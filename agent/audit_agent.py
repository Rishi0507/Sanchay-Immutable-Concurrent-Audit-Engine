"""Auditor agent: a language model that runs the audit through the MCP tools only.

The agent holds an auditor identity (a bearer token) and nothing else. It
reads the tool list from the MCP server, lets the model choose the calls, and
returns each result to the model until the audit plan is complete. It has no
other path into the system, so it can do exactly what its identity allows.

The model is reached over the chat completions format with plain text only:
the tools are described in the prompt and the model answers with the calls it
wants as JSON. This works with gateways that do not pass tool definitions
through. Configuration comes from the environment, or from deploy/.env for
any variable the environment does not set. Git ignores that file, so the key
never enters the repository:

    LLM_URL       address of the model service. A base that ends in /v1 gets
                  /chat/completions appended; any other address is used as given
    LLM_API_KEY   key for that service
    AGENT_MODEL   model name for the agent. LLM_MODEL is used when it is unset
    MCP_URL      MCP endpoint (default http://localhost:8080/mcp)
    MCP_TOKEN     auditor token (default auditor-demo-token)

Only the standard library is used: python agent/audit_agent.py --help
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

WAIT_TOOL = "wait_for_client_evidence"
# Tools the auditor identity lists but this run must leave to a person.
HUMAN_ONLY = {"confirm_finding", "sign_off_engagement"}
KEEP_LATEST = 3000  # characters of a tool result the model sees in the turn it arrives
KEEP_OLDER = 400  # characters kept once the model has acted on it
MAX_REQUEST = 44_000  # bytes. Some gateways refuse a request body over 48 KB.
MAX_OUTPUT = 8000  # tokens the model may spend on one reply, hidden reasoning included

PROTOCOL = """You act through the tools listed below. You cannot run them yourself: the program that reads your reply
runs them and sends you the results. Every reply must be one JSON object and nothing else, in one of two forms.

To call tools, in the order given:
{"calls": [{"tool": "<name>", "args": {<arguments>}}, ...]}

To finish, write the word REPORT alone on the first line and then your report as plain text. No JSON in that reply.

Tools. A star marks a required argument.
"""

TASK = """Run the statutory revenue audit for the period {start} to {end}.

1. Call open_engagement with period_start {start}, period_end {end}{seed}, and no other argument.
   Pass the engagement_id it returns on every later call.
2. Call get_audit_plan once. It lists every step in order. Then call the tool of each step in that order. Put
   several calls in one reply whenever you can: the steps need no argument but engagement_id. Call get_audit_plan
   again only after an error.
3. After the three select tools, call {wait} before verify_evidence. The client needs time to upload the documents.
4. Do not confirm findings and do not sign off. Those decisions belong to the audit manager.
   Pass only engagement_id to the plan tools. Leave every optional argument out, so the server's defaults apply,
   and never invent an identifier. A long result is cut short to save space: work with what is shown and do not
   ask for it again.
5. When the plan is complete, call get_engagement_status once, then finish with a short report: findings by
   severity, the areas with the most findings, sample results, the ledger integrity result and the files exported.
   Use only figures the tools returned."""


def load_env(path: Path) -> None:
    """Set the variables of a .env file that the environment does not already set."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        name, sep, value = line.strip().partition("=")
        if sep and name and not name.startswith("#") and value.strip():
            os.environ.setdefault(name.strip(), value.strip().strip('"').strip("'"))


class Mcp:
    """MCP over Streamable HTTP, one JSON-RPC request per call."""

    def __init__(self, url: str, token: str):
        self.url, self.token, self.n = url, token, 0

    def rpc(self, method: str, params: dict | None = None, timeout: float = 600) -> dict:
        self.n += 1
        body = {"jsonrpc": "2.0", "id": self.n, "method": method, "params": params or {}}
        req = urllib.request.Request(self.url, data=json.dumps(body).encode(), headers={
            "Authorization": f"Bearer {self.token}", "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8")
        # The server answers with one JSON document or one server-sent event that carries it.
        for line in raw.splitlines():
            if line.startswith("data:"):
                raw = line[5:].strip()
        msg = json.loads(raw)
        if "error" in msg:
            raise RuntimeError(f"{method}: {msg['error'].get('message')}")
        return msg["result"]

    def call(self, name: str, args: dict) -> str:
        res = self.rpc("tools/call", {"name": name, "arguments": args})
        return "\n".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")


class Chat:
    """Chat completions, text in and text out."""

    def __init__(self, url: str, key: str, model: str, effort: str | None = None):
        url = url.rstrip("/")
        self.url = url + "/chat/completions" if url.endswith("/v1") else url
        self.key, self.model, self.effort, self.tokens = key, model, effort, 0

    def body(self, messages: list[dict]) -> bytes:
        body = {"model": self.model, "messages": messages}
        if self.effort:
            body["reasoning_effort"] = self.effort
        # Room for the reasoning and the reply together. With too little, the reply comes back empty.
        body["max_tokens" if "deepseek" in self.model else "max_completion_tokens"] = MAX_OUTPUT
        return json.dumps(body).encode()

    def turn(self, messages: list[dict]) -> str:
        req = urllib.request.Request(self.url, data=self.body(messages), headers={
            "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=300) as r:
                    out = json.load(r)
                break
            except urllib.error.HTTPError as e:
                detail = e.read().decode("utf-8", "replace")[:400]
                if e.code not in (429, 500, 502, 503, 504) or attempt == 3:
                    raise RuntimeError(f"model service answered {e.code}: {detail}") from None
                # A rate limit clears in about a minute. Waiting is cheaper than failing the run.
                time.sleep(20 * (attempt + 1) if e.code == 429 else 5 * (attempt + 1))
            except (urllib.error.URLError, TimeoutError) as e:
                if attempt == 3:
                    raise RuntimeError(f"model service unreachable: {e}") from None
                time.sleep(5 * (attempt + 1))
        self.tokens += int((out.get("usage") or {}).get("total_tokens") or 0)
        choice = out["choices"][0]
        self.finish = choice.get("finish_reason")
        return choice["message"].get("content") or ""


def catalogue(tools: list[dict]) -> str:
    """The tool list as text: one line per tool with its arguments and the server's own description."""
    lines = []
    for t in tools:
        schema = t.get("inputSchema") or {}
        required = set(schema.get("required") or [])
        args = []
        for name, p in (schema.get("properties") or {}).items():
            kind = p.get("format") or p.get("type") or "any"
            if p.get("enum"):
                kind = " | ".join(map(str, p["enum"]))
            args.append(f"{name}{'*' if name in required else ''}: {kind}")
        lines.append(f"- {t['name']}({', '.join(args)}): {t.get('description', '')}")
    return "\n".join(lines)


def parse_reply(text: str) -> dict | None:
    """The calls or the final report in a reply. The JSON may be fenced or surrounded by prose."""
    text = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", text.strip())
    if re.match(r"\s*REPORT\b", text):
        return {"report": re.sub(r"^\s*REPORT\b[:\s]*", "", text)}
    for candidate in (text, text[text.find("{"): text.rfind("}") + 1]):
        try:
            data = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(data, dict) and ("calls" in data or "report" in data):
            return data
    # A report sent as JSON with raw line breaks does not parse. The text is still the report.
    wrapped = re.match(r'\s*\{\s*"report"\s*:\s*"(.*)"\s*\}\s*$', text, re.S)
    if wrapped:
        return {"report": wrapped.group(1).replace("\\n", "\n").replace('\\"', '"')}
    return None


def clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit] + f"\n[cut short here, {len(text) - limit} more characters not shown]"


def one_line(text: str, width: int = 150) -> str:
    try:
        data = json.loads(text)
    except ValueError:
        return " ".join(text.split())[:width]
    if isinstance(data, dict):
        if "error" in data and isinstance(data["error"], dict):
            return f"error {data['error'].get('code')}: {data['error'].get('message')}"[:width]
        parts = [f"{k}={len(v) if isinstance(v, (list, dict)) else v}" for k, v in data.items()
                 if k not in ("engagement_id", "auto_ran") and v is not None]
        return ", ".join(parts)[:width]
    return str(data)[:width]


def wait_for_client(mcp: Mcp, engagement_id: str | None, client_cmd: str | None, seconds: int) -> str:
    """Give the client time to answer the evidence requests, then report what is still pending.

    With a client command, the command is the client: it runs to the end and
    the status is read once. Otherwise the status is polled until nothing is
    pending, the count stops falling, or the time is up.
    """
    if client_cmd:
        print(f"      client: {client_cmd}")
        done = subprocess.run(client_cmd, shell=True, capture_output=True, text=True)
        if done.returncode != 0:
            print("      client command failed: " + (done.stderr or done.stdout).strip()[-300:])
    args = {"engagement_id": engagement_id} if engagement_id else {}
    deadline, last, still = time.time() + seconds, None, 0
    while True:
        try:
            status = json.loads(mcp.call("get_evidence_status", args))
        except ValueError:
            status = {}
        pending = status.get("pending")
        still = still + 1 if pending == last else 0
        last = pending
        if client_cmd or not pending or still >= 3 or time.time() >= deadline:
            break
        time.sleep(5)
    return json.dumps({k: status.get(k) for k in ("pending", "received", "verified") if k in status}
                      | {"next_step": "Call verify_evidence. Samples with no documents stay Pending evidence."})


def follow_plan(mcp: Mcp, args) -> int:
    """Run the plan with no model. This checks the connection and the tools. It is not an agent."""
    opened = json.loads(mcp.call("open_engagement", {"period_start": args.period_start, "period_end": args.period_end}
                                 | ({"seed": args.seed} if args.seed else {})))
    eid = opened["engagement_id"]
    print(f"engagement {eid}, snapshot at event {opened.get('snapshot_seq')}")
    for _ in range(args.max_turns):
        nxt = json.loads(mcp.call("get_audit_plan", {"engagement_id": eid})).get("next_tool")
        if not nxt:
            print("plan complete")
            return 0
        if nxt == "verify_evidence":
            print("  " + WAIT_TOOL + ": " + one_line(wait_for_client(mcp, eid, args.client_cmd, args.wait)))
        t = time.time()
        print(f"  {nxt}: {one_line(mcp.call(nxt, {'engagement_id': eid}))} ({time.time() - t:.1f}s)")
    return 1


def conversation(system: str, task: str, turns: list[dict], latest: int, older: int) -> list[dict]:
    """The messages for the next request. Results the model has already acted on are shortened."""
    messages = [{"role": "system", "content": system}, {"role": "user", "content": task}]
    for i, turn in enumerate(turns):
        limit = latest if i == len(turns) - 1 else older
        messages.append({"role": "assistant", "content": turn["reply"]})
        messages.append({"role": "user", "content": turn.get("note") or "Results:\n" + "\n".join(
            f"[{n}] {name} -> {clip(result, limit)}" for n, (name, result) in enumerate(turn["results"], 1))})
    return messages


def main() -> int:
    ap = argparse.ArgumentParser(description="Run the revenue audit as an agent that holds only an auditor identity.")
    ap.add_argument("--period-start", default="2025-04-01")
    ap.add_argument("--period-end", default="2026-03-31")
    ap.add_argument("--seed", default=None, help="Sampling seed chosen by hand. Omit it to use the sealed seed, which nobody chooses.")
    ap.add_argument("--client-cmd", default=None,
                    help="Command that answers the evidence requests as the client, run when the agent waits for evidence.")
    ap.add_argument("--wait", type=int, default=120, help="Seconds to wait for the client's documents.")
    ap.add_argument("--max-turns", type=int, default=30)
    ap.add_argument("--token-budget", type=int, default=120_000, help="Stop when the model has used this many tokens.")
    ap.add_argument("--model", default=None, help="Model for the agent. Default: AGENT_MODEL, then LLM_MODEL.")
    ap.add_argument("--pace", type=float, default=5.0, help="Seconds between requests to the model, to stay under rate limits.")
    ap.add_argument("--effort", default="low", help="Reasoning effort asked of the model. Pass an empty value to omit it.")
    ap.add_argument("--no-model", action="store_true", help="Follow the plan with no model, to check the connection.")
    ap.add_argument("--transcript", default=None, help="Write every reply and result to this JSON Lines file.")
    args = ap.parse_args()
    load_env(Path(__file__).resolve().parents[1] / "deploy" / ".env")

    mcp = Mcp(os.environ.get("MCP_URL", "http://localhost:8080/mcp"), os.environ.get("MCP_TOKEN", "auditor-demo-token"))
    hello = mcp.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                   "clientInfo": {"name": "audit-agent", "version": "1.0"}})
    tools = [t for t in mcp.rpc("tools/list")["tools"] if t["name"] not in HUMAN_ONLY]
    names = {t["name"] for t in tools}
    print(f"connected to {hello['serverInfo'].get('title') or hello['serverInfo']['name']}: {len(tools)} tools")
    if args.no_model:
        return follow_plan(mcp, args)

    model = args.model or os.environ.get("AGENT_MODEL") or os.environ.get("LLM_MODEL")
    missing = [v for v in ("LLM_URL", "LLM_API_KEY") if not os.environ.get(v)] + ([] if model else ["AGENT_MODEL"])
    if missing:
        print("Set " + ", ".join(missing) + " in deploy/.env to run the agent, or pass --no-model to check the connection.")
        return 2
    chat = Chat(os.environ["LLM_URL"], os.environ["LLM_API_KEY"], model, args.effort or None)
    seen: set[str] = set()  # calls already answered, so a repeat costs nothing and changes nothing
    system = "\n\n".join([hello.get("instructions", ""), PROTOCOL + catalogue(tools) + (
        f"\n- {WAIT_TOOL}(engagement_id: string): Wait for the client to upload the documents requested for the "
        "samples. Call after the select tools and before verify_evidence.")])
    task = TASK.format(start=args.period_start, end=args.period_end, wait=WAIT_TOOL,
                       seed=f' and seed "{args.seed}"' if args.seed else "")
    log = open(args.transcript, "a", encoding="utf-8") if args.transcript else None
    turns: list[dict] = []
    print(f"model {chat.model}, {'seed ' + args.seed if args.seed else 'sealed seed'}")
    for n in range(1, args.max_turns + 1):
        # Stay under the request size limit by shortening tool results, the latest ones last.
        latest, older = KEEP_LATEST, KEEP_OLDER
        messages = conversation(system, task, turns, latest, older)
        while len(chat.body(messages)) > MAX_REQUEST and latest > 100:
            older = max(100, older // 2)
            latest = latest // 2 if older == 100 else latest
            messages = conversation(system, task, turns, latest, older)
        if n > 1:
            time.sleep(args.pace)
        try:
            reply = chat.turn(messages)
        except RuntimeError as e:
            print(f"\nStopped: {e}\n{n - 1} turns, {chat.tokens:,} tokens")
            return 1
        action = parse_reply(reply)
        turn = {"reply": reply, "results": []}
        turns.append(turn)
        if action is None:
            turn["note"] = "That reply was empty or not in the required form. Reply again: calls as one JSON object, or REPORT and the text."
            print(f"  {n:>2}. reply was {'empty' if not reply.strip() else 'not in the required form'} "
                  f"(finish reason: {chat.finish}), asking again")
        elif "report" in action:
            if log:
                log.write(json.dumps(turn) + "\n")
            print("\n" + str(action["report"]).strip())
            print(f"\n{n} turns, {chat.tokens:,} tokens")
            return 0
        for c in (action or {}).get("calls") or []:
            name, call_args = str(c.get("tool")), c.get("args") if isinstance(c.get("args"), dict) else {}
            t = time.time()
            key = name + json.dumps(call_args, sort_keys=True)
            if key in seen and name != "get_audit_plan":
                result = json.dumps({"note": "You already made this call and have its result above. Go on to the next step."})
            elif name == WAIT_TOOL:
                result = wait_for_client(mcp, call_args.get("engagement_id"), args.client_cmd, args.wait)
            elif name not in names:
                result = json.dumps({"error": {"code": "UNKNOWN_TOOL", "message": f"{name} is not available to this identity."}})
            else:
                try:
                    result = mcp.call(name, call_args)
                except Exception as e:  # noqa: BLE001 - the model is told and decides what to do next
                    result = json.dumps({"error": {"code": "CALL_FAILED", "message": str(e)[:300]}})
            shown = {k: v for k, v in call_args.items() if k != "engagement_id"}
            print(f"  {n:>2}. {name}({json.dumps(shown) if shown else ''}) -> {one_line(result)} ({time.time() - t:.1f}s)")
            seen.add(key)
            turn["results"].append((name, result))
        if action is not None and not turn["results"]:
            turn["note"] = "No tool was called. Reply with calls, or with a report to finish."
        if log:
            log.write(json.dumps(turn) + "\n")
            log.flush()
        if chat.tokens > args.token_budget:
            print(f"\nStopped: {chat.tokens:,} tokens used, over the budget of {args.token_budget:,}.")
            return 1
    print(f"\nStopped after {args.max_turns} turns, {chat.tokens:,} tokens.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
