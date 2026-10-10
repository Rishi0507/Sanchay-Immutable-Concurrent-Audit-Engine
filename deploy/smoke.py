#!/usr/bin/env python3
"""End-to-end check of the ledger core and the MCP server.

Runs a small business through the client tools, then an audit through the
auditor tools, and asserts the guarantees of PRD sections 4, 6, 8, 9 and 16.
It needs the database, the ledger core, the MCP server and an engine (the
stand-in is enough) to be running. Standard library only.

    python deploy/smoke.py
    python deploy/smoke.py --base http://localhost:8080 --ledger http://localhost:7001

Set PSQL to a superuser psql command line to include the tamper test, for
example:  PSQL="psql postgres://postgres:postgres@localhost:5432/audit"
"""

import argparse
import base64
import json
import os
import shlex
import subprocess
import sys
import threading
import urllib.error
import urllib.request
import uuid

parser = argparse.ArgumentParser()
parser.add_argument("--base", default=os.environ.get("MCP_URL", "http://localhost:8080"))
parser.add_argument("--ledger", default=os.environ.get("LEDGER_URL", "http://localhost:7001"))
parser.add_argument("--service-token", default=os.environ.get("SERVICE_TOKEN", "dev-service-token"))
args = parser.parse_args()

TOKENS = {
    "client": os.environ.get("TOKEN_CLIENT", "client-demo-token"),
    "auditor": os.environ.get("TOKEN_AUDITOR", "auditor-demo-token"),
    "manager": os.environ.get("TOKEN_MANAGER", "manager-demo-token"),
}
RUN = uuid.uuid4().hex[:8]
passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok    {name}")
    else:
        failed += 1
        print(f"  FAIL  {name} {detail}")


def http(method, url, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def tool(who, tool_name, /, **kwargs):
    """Calls a tool. Returns (result, error); exactly one is None."""
    status, raw, _ = http("POST", f"{args.base}/api/tools/{tool_name}", kwargs, {"Authorization": f"Bearer {TOKENS[who]}"})
    body = json.loads(raw)
    if body.get("ok"):
        return body["result"], None
    return None, body.get("error", {"code": f"HTTP_{status}"})


def must(who, tool_name, /, **kwargs):
    result, err = tool(who, tool_name, **kwargs)
    if err:
        print(f"  FAIL  {tool_name} was expected to succeed: {err}")
        sys.exit(1)
    return result


def code(who, tool_name, /, **kwargs):
    _, err = tool(who, tool_name, **kwargs)
    return err["code"] if err else "OK"


def key(label):
    return f"smoke-{RUN}-{label}"


print("Identities")
for who, role in (("client", "client_employee"), ("auditor", "auditor"), ("manager", "audit_manager")):
    status, raw, _ = http("GET", f"{args.base}/api/whoami", headers={"Authorization": f"Bearer {TOKENS[who]}"})
    check(f"{who} token resolves to {role}", status == 200 and json.loads(raw)["role"] == role)
status, _, _ = http("GET", f"{args.base}/api/whoami", headers={"Authorization": "Bearer nope"})
check("unknown token is refused", status == 401)

print("Client: parties and pricing")
cust = must("client", "create_customer", name=f"Alpha Shipyard {RUN}", gstin="27AAACA1234A1Z5", pan="AAACA1234A", state_code="27",
            phone="9800000001", bank_accounts=[{"account_no": "111000111", "ifsc": "HDFC0000001"}],
            directors=[{"name": "R Mehta", "din": "00011122"}], effective_from="2024-04-01", idempotency_key=key("cust1"))
cust_id = cust["customer_id"]
cust2 = must("client", "create_customer", name=f"Beta Marine {RUN}", gstin="24AAACB5678B1Z3", state_code="24",
             effective_from="2024-04-01", idempotency_key=key("cust2"))
must("client", "record_company_officer", name="R Mehta", din="00011122", role="Director", effective_from="2020-01-01", idempotency_key=key("off"))
must("client", "set_price", item_code="PANEL-01", rate=50000, effective_from="2024-04-01", idempotency_key=key("price"))
must("client", "create_promotion", scheme_id=f"YE-{RUN}", discount_percent=5, valid_from="2025-03-01", valid_to="2025-03-31",
     approver="Sales Head", idempotency_key=key("promo"))

again = must("client", "create_customer", name=f"Alpha Shipyard {RUN}", gstin="27AAACA1234A1Z5", pan="AAACA1234A", state_code="27",
             phone="9800000001", bank_accounts=[{"account_no": "111000111", "ifsc": "HDFC0000001"}],
             directors=[{"name": "R Mehta", "din": "00011122"}], effective_from="2024-04-01", idempotency_key=key("cust1"))
check("a repeated call returns the first result", again["duplicate"] and again["seq"] == cust["seq"] and again["customer_id"] == cust_id)
check("the same key with a different request is refused",
      code("client", "create_customer", name="Someone Else", effective_from="2024-04-01", idempotency_key=key("cust1")) == "IDEMPOTENCY_MISMATCH")

print("Client: one complete sale")
enq = must("client", "record_enquiry", customer_id=cust_id, date="2025-03-10", channel="email", idempotency_key=key("enq"))
sale_id = enq["sale_id"]
order = must("client", "create_sales_order", customer_id=cust_id, enquiry_id=enq["enquiry_id"], order_no=f"SO-{RUN}", date="2025-03-12",
             items=[{"item_code": "PANEL-01", "qty": 2, "rate": 50000}], delivery_terms="delivered", approver="Sales Head", idempotency_key=key("ord"))
check("the order inherits the sale of its enquiry", order["sale_id"] == sale_id)
disp = must("client", "record_dispatch", order_id=order["order_id"], dispatched_at="2025-03-28T09:00:00Z", vehicle_no="MH04AB1234", distance_km=320, idempotency_key=key("dsp"))
check("the dispatch inherits the sale", disp["sale_id"] == sale_id)
must("client", "generate_eway_bill", dispatch_id=disp["dispatch_id"], ewb_no="181000000001", date="2025-03-28", value=118000,
     vehicle_no="MH04AB1234", distance_km=320, valid_until="2025-03-30T23:59:00Z", idempotency_key=key("ewb"))
must("client", "record_lr", dispatch_id=disp["dispatch_id"], lr_no=f"LR-{RUN}", transporter="Fast Roadways", date="2025-03-28", vehicle_no="MH04AB1234", idempotency_key=key("lr"))
must("client", "record_delivery", dispatch_id=disp["dispatch_id"], delivered_at="2025-04-02T15:30:00Z", receiver_name="Stores", idempotency_key=key("dlv"))
inv = must("client", "issue_invoice", invoice_no=f"G/{RUN}/01", date="2025-03-28", customer_id=cust_id, order_id=order["order_id"],
           taxable_value=100000, igst=18000, gross=118000, tax_rate=18, place_of_supply="27", customer_gstin="27AAACA1234A1Z5",
           business_unit="Marine", idempotency_key=key("inv1"))
check("the invoice inherits the sale", inv["sale_id"] == sale_id)
must("client", "file_gstr1", return_period="2025-03", filed_on="2025-04-11",
     lines=[{"invoice_no": f"G/{RUN}/01", "gstin": "27AAACA1234A1Z5", "taxable_value": 100000, "igst": 18000, "place_of_supply": "27"}], idempotency_key=key("gstr"))
must("client", "record_receipt", customer_id=cust_id, invoice_ids=[inv["invoice_id"]], amount=118000, date="2025-04-20",
     payer_name=f"Alpha Shipyard {RUN}", payer_account="111000111", utr=f"UTR{RUN}", idempotency_key=key("rcp"))
must("client", "import_bank_statement", account_no="5550001", statement_date="2025-04-30",
     lines=[{"date": "2025-04-20", "amount": 118000, "direction": "credit", "counterparty_account": "111000111", "utr": f"UTR{RUN}"}], idempotency_key=key("bank"))

record = must("client", "get_record", id=inv["invoice_id"])
postings = [p for h in record["history"] for p in h.get("postings", [])]
check("the invoice posted balanced ledger lines",
      len(postings) == 3 and sum(p["debit"] for p in postings) == sum(p["credit"] for p in postings) == 118000, str(postings))
check("amounts are returned in rupees", record["data"]["gross"] == 118000)

print("Client: irregular but accepted events (PRD section 6.4)")
bare = must("client", "issue_invoice", invoice_no=f"G/{RUN}/02", date="2025-03-31", customer_id=cust2["customer_id"],
            taxable_value=500000, cgst=45000, sgst=45000, gross=590000, idempotency_key=key("inv2"))
check("an invoice with no order or dispatch is accepted", bare["seq"] > inv["seq"])
jrn = must("client", "post_journal", date="2025-03-31", narration="Year end accrual",
           lines=[{"account": "9000", "debit": 250000}, {"account": "4000", "credit": 250000}], idempotency_key=key("jrn"))
check("a journal crediting Sales is accepted", jrn["seq"] > 0)
after = must("client", "issue_invoice", invoice_no=f"G/{RUN}/03", date="2025-04-02", customer_id=cust2["customer_id"],
             taxable_value=200000, igst=36000, gross=236000, idempotency_key=key("inv3"))
ven = must("client", "create_vendor", name=f"Gamma Traders {RUN}", effective_from="2024-04-01", idempotency_key=key("ven"))
pin = must("client", "record_purchase_invoice", vendor_id=ven["vendor_id"], invoice_no=f"P-{RUN}", date="2025-03-20",
           taxable_value=80000, tax=14400, gross=94400, idempotency_key=key("pin"))
must("client", "record_goods_receipt", purchase_invoice_id=pin["purchase_invoice_id"], vendor_id=ven["vendor_id"], date="2025-03-21", idempotency_key=key("grn"))
must("client", "record_payment", vendor_id=ven["vendor_id"], purchase_invoice_ids=[pin["purchase_invoice_id"]], amount=94400, date="2025-03-25", idempotency_key=key("pay"))

print("Client: structural rejections")
check("an invoice whose gross does not foot is refused",
      code("client", "issue_invoice", invoice_no="BAD", date="2025-03-01", customer_id=cust_id, taxable_value=1000, igst=180, gross=1200, idempotency_key=key("bad1")) == "UNBALANCED_POSTING")
check("an unbalanced journal is refused",
      code("client", "post_journal", date="2025-03-01", narration="x", lines=[{"account": "9000", "debit": 5}, {"account": "4000", "credit": 6}], idempotency_key=key("bad2")) == "UNBALANCED_POSTING")
check("a reference to a missing customer is refused",
      code("client", "issue_invoice", invoice_no="BAD", date="2025-03-01", customer_id="cus_doesnotexist000", taxable_value=1, gross=1, idempotency_key=key("bad3")) == "UNKNOWN_REFERENCE")
check("a reference to the wrong kind of record is refused",
      code("client", "issue_invoice", invoice_no="BAD", date="2025-03-01", customer_id=ven["vendor_id"], taxable_value=1, gross=1, idempotency_key=key("bad4")) == "UNKNOWN_REFERENCE")
check("a badly formed date is refused before the ledger",
      code("client", "issue_invoice", invoice_no="BAD", date="31-03-2025", customer_id=cust_id, taxable_value=1, gross=1, idempotency_key=key("bad5")) == "VALIDATION_FAILED")
check("an unknown field is refused",
      code("client", "record_enquiry", customer_id=cust_id, date="2025-03-01", colour="blue", idempotency_key=key("bad6")) == "VALIDATION_FAILED")
check("a write with no idempotency_key is refused",
      code("client", "record_enquiry", customer_id=cust_id, date="2025-03-01") == "VALIDATION_FAILED")

upd = must("client", "update_customer", customer_id=cust_id, phone="9800000099", effective_from="2025-01-01", idempotency_key=key("upd1"))
check("an update appends version 2", upd["version"] == 2)
check("a stale expected_version is refused",
      code("client", "update_customer", customer_id=cust_id, phone="1", effective_from="2025-02-01", expected_version=1, idempotency_key=key("upd2")) == "VERSION_CONFLICT")
history = must("client", "get_record", id=cust_id)
check("both versions of the customer are kept", len(history["history"]) == 2 and history["data"]["phone"] == "9800000099")

rev = must("client", "reverse_document", document_id=after["invoice_id"], reason="Raised in error", date="2025-04-03", idempotency_key=key("rev1"))
reversed_record = must("client", "get_record", id=after["invoice_id"])
mirror = [p for h in reversed_record["history"] if h["event"] == "DocumentReversed" for p in h.get("postings", [])]
check("a reversal posts mirror lines and keeps the original", reversed_record["reversed"] and len(mirror) == 3 and len(reversed_record["history"]) == 2
      and sum(p["debit"] for p in mirror) == sum(p["credit"] for p in mirror) == 236000)
check("reversing twice is refused",
      code("client", "reverse_document", document_id=after["invoice_id"], reason="again", date="2025-04-04", idempotency_key=key("rev2")) == "INVALID_TRANSITION")

tb = must("client", "get_trial_balance")
check("the trial balance balances", abs(sum(a["total_debit"] for a in tb["accounts"]) - sum(a["total_credit"] for a in tb["accounts"])) < 0.005)

print("Permissions")
check("an auditor cannot call a client write tool",
      code("auditor", "issue_invoice", invoice_no="X", date="2025-03-01", customer_id=cust_id, taxable_value=1, gross=1, idempotency_key=key("deny1")) == "PERMISSION_DENIED")
check("an audit manager cannot call a client write tool",
      code("manager", "post_journal", date="2025-03-01", narration="x", lines=[], idempotency_key=key("deny2")) == "PERMISSION_DENIED")
check("a client cannot call an auditor tool", code("client", "get_findings") == "PERMISSION_DENIED")
check("an unknown tool is reported as such", code("auditor", "delete_everything") == "UNKNOWN_TOOL")

status, raw, _ = http("POST", f"{args.ledger}/append", {
    "event_type": "JournalPosted", "entity_id": "E1", "aggregate_type": "journal", "aggregate_id": f"jrn_direct{RUN}",
    "expected_version": 0, "sale_id": None, "business_date": "2025-03-31", "idempotency_key": key("direct"),
    "payload": {"date": "2025-03-31", "narration": "direct", "lines": [{"account": "9000", "debit": 100}, {"account": "4000", "credit": 100}]},
    "identity": {"user": "auditor.agent", "role": "auditor"}}, {"X-Service-Token": args.service_token})
check("the ledger core itself refuses an auditor identity", status == 403 and json.loads(raw)["error"]["code"] == "NOT_PERMITTED", raw[:200])
status, _, _ = http("GET", f"{args.ledger}/head")
check("the ledger core refuses a call with no service token", status == 403)

print("Concurrency")
results, lock = [], threading.Lock()


def append(i, same_key):
    r, e = tool("client", "record_enquiry", customer_id=cust_id, date="2025-03-15", channel="phone",
                idempotency_key=key("same" if same_key else f"par{i}"))
    with lock:
        results.append((r, e))


threads = [threading.Thread(target=append, args=(i, False)) for i in range(40)]
[t.start() for t in threads]
[t.join() for t in threads]
seqs = sorted(r["seq"] for r, e in results if r)
check("40 parallel appends all succeed", len(seqs) == 40, str([e for r, e in results if e][:2]))
check("their sequence numbers are distinct and contiguous", len(set(seqs)) == 40 and seqs[-1] - seqs[0] == 39, str(seqs[:5]))
results.clear()
threads = [threading.Thread(target=append, args=(i, True)) for i in range(12)]
[t.start() for t in threads]
[t.join() for t in threads]
check("12 parallel calls with one key append exactly once",
      len({r["seq"] for r, e in results if r}) == 1 and sum(1 for r, e in results if r and not r["duplicate"]) == 1 and len(results) == 12)

print("Client: uploads for the audit")
exported = must("client", "export_sales_register", period_start="2024-04-01", period_end="2025-03-31")
check("the register export lists the period's unreversed invoices", exported["row_count"] >= 2)
reg = must("client", "upload_sales_register", file_hash=exported["file_hash"], file_name=exported["file_name"],
           period_start="2024-04-01", period_end="2025-03-31", idempotency_key=key("reg"))
check("the register row count is recorded", reg["seq"] > 0)
must("client", "upload_related_parties", as_of="2025-03-31",
     parties=[{"name": f"Alpha Shipyard {RUN}", "pan": "AAACA1234A", "relationship": "Common director", "effective_from": "2024-04-01"}], idempotency_key=key("rpl"))
status, raw, _ = http("GET", f"{args.base}/api/files/{exported['file_hash']}", headers={"Authorization": f"Bearer {TOKENS['auditor']}"})
check("the stored register can be downloaded and has the client layout", status == 200 and raw.decode().startswith("Bill no.,Date,Job No.,Customer"))

print("Auditor: engagement and snapshot")
notes = must("auditor", "get_notifications")
check("the auditor is notified of both uploads", notes["sales_register_uploaded"] and notes["related_parties_uploaded"])
eng = must("auditor", "open_engagement", period_start="2024-04-01", period_end="2025-03-31", seed=f"seed-{RUN}")
eng_id = eng["engagement_id"]
check("the engagement freezes a snapshot", eng["snapshot_seq"] >= reg["seq"] and len(eng["snapshot_hash"]) == 64)
plan = must("auditor", "get_audit_plan", engagement_id=eng_id)
check("the plan names the next tool", plan["next_tool"] == "import_register", str(plan.get("next_tool")))

late = must("client", "issue_invoice", invoice_no=f"G/{RUN}/99", date="2025-03-30", customer_id=cust_id, taxable_value=10000, igst=1800, gross=11800, idempotency_key=key("late"))
seen = must("auditor", "query_records", engagement_id=eng_id, type="invoice", text=f"G/{RUN}/")
numbers = {r["data"]["invoice_no"] for r in seen["records"]}
check("the auditor reads the snapshot, not later records", f"G/{RUN}/01" in numbers and f"G/{RUN}/99" not in numbers, str(numbers))
chain = must("auditor", "get_sale_chain", engagement_id=eng_id, invoice_no=f"G/{RUN}/01")
check("a full sale chain shows every stage", all(chain["stages"][s] for s in ("enquiry", "order", "dispatch", "eway_bill", "lorry_receipt", "delivery", "invoice", "receipt")), str(chain["stages"]))
bare_chain = must("auditor", "get_sale_chain", engagement_id=eng_id, invoice_no=f"G/{RUN}/02")
check("a bare invoice shows the missing stages", bare_chain["stages"]["invoice"] and not bare_chain["stages"]["dispatch"])
sales = must("auditor", "get_ledger_entries", engagement_id=eng_id, account="4000", limit=500)
sources = {e["source_event_type"] for e in sales["entries"]}
check("ledger lines name the event that posted them", {"InvoiceIssued", "JournalPosted"} <= sources, str(sources))

print("Auditor: audit steps (engine)")
for name in ("import_register", "reconcile_register", "tag_related_parties", "run_detectors"):
    must("auditor", name, engagement_id=eng_id)
sales_tod = must("auditor", "select_sales_tod", engagement_id=eng_id)
must("auditor", "select_cutoff_tod", engagement_id=eng_id)
must("auditor", "select_credit_note_tod", engagement_id=eng_id)
check("samples are selected with reasons", len(sales_tod["samples"]) > 0 and all(s["reason"] for s in sales_tod["samples"]))
again = must("auditor", "select_sales_tod", engagement_id=eng_id)
check("selecting again returns the same samples", [s["sample_id"] for s in again["samples"]] == [s["sample_id"] for s in sales_tod["samples"]])
requests = must("client", "list_evidence_requests", status="pending", limit=500)
mine = [r for r in requests["requests"] if any(r["sample_id"] == s["sample_id"] for s in sales_tod["samples"])]
check("the client sees the evidence requests", len(mine) > 0)
first = mine[0]
ev = must("client", "upload_evidence", sample_id=first["sample_id"], document_type=first["document_type"], file_name="invoice.txt",
          content_base64=base64.b64encode(f"Invoice copy {RUN}".encode()).decode(), idempotency_key=key("evd"))
check("inline evidence is stored by hash", len(ev["file_hash"]) == 64)
must("auditor", "verify_evidence", engagement_id=eng_id)

sampled = next((s for s in sales_tod["samples"] if s.get("invoice_no") == f"G/{RUN}/01"), None)
if sampled:
    must("client", "issue_credit_note", credit_note_no=f"CN-{RUN}", date="2025-04-25", invoice_id=inv["invoice_id"], reason="Rate difference",
         taxable_value=10000, igst=1800, gross=11800, approver="CFO", idempotency_key=key("cn"))
    changes = must("auditor", "check_post_testing_changes", engagement_id=eng_id)
    check("a client change after the snapshot is traced to the sample",
          any(sampled["sample_id"] in c["sample_ids"] and c["event_type"] == "CreditNoteIssued" for c in changes["changes"]), str(changes["changes"])[:300])
else:
    print("  skip  post-testing change (the stand-in engine did not sample the test invoice)")

findings = must("auditor", "get_findings", engagement_id=eng_id, limit=500)
check("findings are raised", len(findings["findings"]) > 0)
fid = findings["findings"][0]["finding_id"]
detail = must("auditor", "explain_finding", finding_id=fid)
check("a finding explains itself with lineage", bool(detail.get("reason")) and "lineage" in detail)
check("an auditor cannot confirm a finding", code("auditor", "confirm_finding", finding_id=fid, decision="confirmed") == "PERMISSION_DENIED")
decided = must("manager", "confirm_finding", finding_id=fid, decision="confirmed", note="Agreed")
check("the audit manager can confirm a finding", decided["status"] == "confirmed")
must("auditor", "draft_findings_memo", engagement_id=eng_id)
must("auditor", "export_workpaper", engagement_id=eng_id)

print("Integrity and trail")
integrity = must("auditor", "verify_ledger_integrity", engagement_id=eng_id)
check("both chains verify", integrity["ok"], json.dumps(integrity)[:400])
check("the snapshot hash is unchanged", integrity["snapshot"]["match"])
check("verification ran over the whole chain", integrity["business_chain"]["checked"] == integrity["business_chain"]["head_seq"])
proof = must("auditor", "get_merkle_proof", seq=inv["seq"])
check("a Merkle proof is returned for an event", proof["hash"] == inv["hash"] and len(proof["root"]) == 64)
trail = must("auditor", "get_audit_trail", limit=500)
statuses = {e["status"] for e in trail["entries"]}
check("the trail chain verifies", trail["verification"]["ok"])
check("denied calls are in the trail", "permission_denied" in statuses, str(statuses))
own = must("client", "get_audit_trail", limit=500)
check("a client sees only its own trail entries", {e["role"] for e in own["entries"]} == {"client_employee"})
exported_trail = must("auditor", "get_audit_trail", export=True)
check("the trail can be exported as a file", exported_trail["entries"] > 0 and len(exported_trail["file_hash"]) == 64)

psql = os.environ.get("PSQL")
if psql:
    print("Tamper detection")

    def sql(statement):
        # Options go before the connection string; psql on Windows ignores
        # options that follow a positional argument.
        parts = shlex.split(psql)
        subprocess.run(parts[:1] + ["-q", "-v", "ON_ERROR_STOP=1", "-c", statement] + parts[1:],
                       check=True, capture_output=True, stdin=subprocess.DEVNULL, timeout=60)

    target = inv["seq"]
    sql("ALTER TABLE business.events DISABLE TRIGGER append_only_row")
    try:
        sql(f"UPDATE business.events SET payload = jsonb_set(payload, '{{gross}}', '1') WHERE seq = {target}")
        broken = must("auditor", "verify_ledger_integrity", engagement_id=eng_id)
        check("an altered event is detected at its sequence number",
              not broken["ok"] and broken["business_chain"]["first_bad_seq"] == target, json.dumps(broken["business_chain"]))
        sql(f"UPDATE business.events SET payload = jsonb_set(payload, '{{gross}}', '11800000') WHERE seq = {target}")
    finally:
        sql("ALTER TABLE business.events ENABLE TRIGGER append_only_row")
    restored = must("auditor", "verify_ledger_integrity", engagement_id=eng_id)
    check("the chain verifies again once the value is restored", restored["business_chain"]["ok"])
else:
    print("Tamper detection skipped (set PSQL to run it)")

print("MCP protocol")


def rpc(who, method, params=None, rid=1):
    body = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}
    status, raw, headers = http("POST", f"{args.base}/mcp", body, {
        "Authorization": f"Bearer {TOKENS[who]}", "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18"})
    text = raw.decode()
    if "text/event-stream" in headers.get("Content-Type", ""):
        for line in text.splitlines():
            if line.startswith("data:"):
                message = json.loads(line[5:])
                if message.get("id") == rid:
                    return message
        return {}
    return json.loads(text) if text.strip() else {}


init = rpc("auditor", "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "smoke", "version": "1"}})
check("initialize answers with server info", init.get("result", {}).get("serverInfo", {}).get("name") == "sanchay", str(init)[:200])
listed = rpc("auditor", "tools/list")
names = {t["name"] for t in listed.get("result", {}).get("tools", [])}
check("the auditor lists audit tools", {"get_audit_plan", "select_sales_tod", "explain_finding"} <= names, str(sorted(names))[:200])
check("the auditor lists no client or manager tools", not ({"issue_invoice", "post_journal", "confirm_finding"} & names))
client_names = {t["name"] for t in rpc("client", "tools/list").get("result", {}).get("tools", [])}
check("the client lists business tools and no audit tools", "issue_invoice" in client_names and "get_findings" not in client_names)
manager_names = {t["name"] for t in rpc("manager", "tools/list").get("result", {}).get("tools", [])}
check("the audit manager also lists confirm_finding", "confirm_finding" in manager_names and "issue_invoice" not in manager_names)
called = rpc("auditor", "tools/call", {"name": "get_engagement_status", "arguments": {"engagement_id": eng_id}})
structured = called.get("result", {}).get("structuredContent", {})
check("a tool call over MCP returns structured content", structured.get("engagement_id") == eng_id, str(called)[:300])
denied = rpc("auditor", "tools/call", {"name": "post_journal", "arguments": {}})
check("an unlisted tool called over MCP is denied, not hidden",
      denied.get("result", {}).get("isError") and denied["result"]["structuredContent"]["error"]["code"] == "PERMISSION_DENIED", str(denied)[:300])
status, _, _ = http("POST", f"{args.base}/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, {"Accept": "application/json, text/event-stream"})
check("MCP without a token is refused", status == 401)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
