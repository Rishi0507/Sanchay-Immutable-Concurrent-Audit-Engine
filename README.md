# ELEV05: AI-Run Statutory Revenue Audit

Elevate 1.0, problem statement 04. The system of record behind a manufacturer's sales, exposed as a Model Context Protocol server, so that an AI agent holding only an identity can run the business as a client employee or audit it as an independent auditor.

The full specification is in [docs/PRD.md](docs/PRD.md).

## Components

| Path | Component | Language | Status |
|---|---|---|---|
| `ledger/` | Ledger core: append-only, hash-chained double-entry ledger | OCaml 5 | Built |
| `mcp/` | MCP server and HTTP gateway | Go | Built |
| `ui/` | Client and auditor views | React, Tailwind | Built |
| `db/` | Schemas, roles, append-only triggers | SQL | Built |
| `contracts/` | Shared definitions used by every component | JSON, Markdown | Built |
| `deploy/` | Docker Compose and the end-to-end check | YAML, Python | Built |
| `engine/` | Audit engine: reconciliation, sampling, detectors, outputs | Python | Built |
| `datagen/` | Synthetic data and self-test | Python | Built |
| `agent/` | Auditor agent: a model that runs the audit through the MCP tools | Python | Built |

The engine service runs the audit engine in `engine/`. The stand-in in `mcp/cmd/mockengine` is kept as a development aid.

## Run with Docker

```sh
docker compose -f deploy/docker-compose.yml up --build
```

| Address | Purpose |
|---|---|
| http://localhost:5173 | User interface |
| http://localhost:8080/mcp | MCP endpoint for agents |
| http://localhost:8080/healthz | Health of the server and the services behind it |

The first build compiles the OCaml ledger core and takes several minutes.

## Load the demo business

The data generator loads a synthetic manufacturer with planted irregularities through the client tools, with the historical record time of each event. That needs the seeding clock, which is off unless the stack is started with `SIM_CLOCK=1`.

```sh
SIM_CLOCK=1 docker compose -f deploy/docker-compose.yml up --build -d
cd datagen
uv run python -m elev_datagen generate --dataset planted --scale 0.15 --out ../var/seed --mcp-url http://localhost:8080
cd .. && docker compose -f deploy/docker-compose.yml up -d   # restart with the seeding clock off
```

`--scale 0.15` loads about 1,000 sales (about 11,000 events, 11 minutes). `--scale 1` loads a full year of about 7,000 sales.

After the auditor selects samples, the client answers the evidence requests:

```sh
cd datagen
uv run python -m elev_datagen respond --dataset ../var/seed          # genuine copies
uv run python -m elev_datagen respond --dataset ../var/seed --plant  # with planted forgeries
```

## Identities

An identity is a bearer token. Each token maps to one user and one role. The defaults below are for demonstration and are set in `deploy/.env.example`.

| Role | Token | Can |
|---|---|---|
| `client_employee` | `client-demo-token` | Record business events, upload the register and evidence |
| `auditor` | `auditor-demo-token` | Read the snapshot, sample, test, raise findings, export |
| `audit_manager` | `manager-demo-token` | Everything an auditor can, plus confirm findings and sign off |

An auditor identity cannot change business data. The restriction holds at four layers: the tool list, the ledger core's capability types, the database role, and append-only triggers.

## Connect an agent

Any MCP client that supports Streamable HTTP can connect. Example client configuration:

```json
{
  "mcpServers": {
    "revenue-audit": {
      "type": "http",
      "url": "http://localhost:8080/mcp",
      "headers": { "Authorization": "Bearer auditor-demo-token" }
    }
  }
}
```

The server lists only the tools of the token's role. An auditing agent starts with `get_audit_plan` and follows `next_tool`. Every error names the next step to take.

For a client that speaks MCP over standard input and output:

```sh
cd mcp && go run ./cmd/server --stdio --token auditor-demo-token
```

## Run the auditor agent

`agent/audit_agent.py` is a small MCP client. It holds an auditor token, reads the tool list from the server, and lets a hosted model choose the calls until the audit plan is complete. It uses the Python standard library only.

The model is reached with plain text: the tools are described in the prompt and the model answers with the calls it wants as JSON. This works with gateways that do not pass tool definitions through. Requests are paced and kept under 44 KB, and a rate-limit answer is waited out.

Set `LLM_URL`, `LLM_API_KEY` and `AGENT_MODEL` in `deploy/.env` (copy `deploy/.env.example`). Git ignores that file. The agent reads the values from the file when the environment does not set them. `LLM_MODEL` is a separate switch for the engine: while it is empty, no step in the application calls the model, and only the agent spends tokens.

```sh
python agent/audit_agent.py --client-cmd "cd datagen && uv run python -m elev_datagen respond --dataset ../var/seed --plant"
```

| Option | Meaning |
|---|---|
| `--client-cmd` | Command that answers the evidence requests as the client. It runs when the agent waits for evidence. |
| `--seed` | Sampling seed. Each seed opens its own engagement, so a run does not disturb an earlier one. |
| `--token-budget` | The run stops when the model has used this many tokens. Default 120,000. A run on the demo data used about 41,000. |
| `--model` | Model for the agent. Default `AGENT_MODEL`, then `LLM_MODEL`. |
| `--pace` | Seconds between requests to the model. Default 5. |
| `--effort` | Reasoning effort asked of the model. Default `low`. |
| `--no-model` | Follows the plan with no model. It checks the connection and the tools and is not an agent. |
| `--transcript` | Writes every message to a JSON Lines file. |

The agent never confirms a finding and never signs off. Those tools are withheld from the model, and the server refuses them for the auditor role in any case.

## Tool conventions

| Topic | Rule |
|---|---|
| Amounts | Rupees at the tool boundary. Stored as integer paise. |
| Dates | `YYYY-MM-DD`. Date and time values are RFC 3339. |
| Write tools | Need `idempotency_key`. Repeating a call with the same key returns the first result. |
| Files | Pass `file_hash` of a stored file, or `content_base64` for a small one. Store a file with `POST /api/files`. |
| Lists | Paginated with `limit` and `cursor`. |
| Errors | `code`, `message` and `next_step`. |

## Run without Docker

Requirements: Postgres 16, Go 1.27, Node 22, Python 3.12 with uv, and OCaml 5.2 with opam.

```sh
# 1. Database
createdb audit
PGDATABASE=audit sh db/apply.sh

# 2. Ledger core
cd ledger
opam install . --deps-only
DATABASE_URL=postgres://ledger_rw:ledger_rw@localhost:5432/audit dune exec ledger

# 3. Audit engine and MCP server
cd engine
DATABASE_URL=postgres://engine_audit:engine_audit@localhost:5432/audit FILES_DIR=../mcp/data/files LEDGER_URL=http://localhost:7001 uv run python -m audit_engine.api
cd ../mcp
DATABASE_URL=postgres://mcp_read:mcp_read@localhost:5432/audit go run ./cmd/server

# 4. User interface
cd ui && npm install && npm run dev
```

## Configuration

| Variable | Service | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | all | per service | Connection string for the service's own database role |
| `SERVICE_TOKEN` | all | `dev-service-token` | Shared token between internal services |
| `CATALOGUE_PATH` | ledger, mcp | `../contracts/events.json` | Event catalogue |
| `LEDGER_PORT` | ledger | `7001` | Listening port |
| `VERIFY_DOMAINS` | ledger | cores minus one, at most 8 | Domains used to verify the chain in parallel |
| `LISTEN_ADDR` | mcp | `:8080` | Listening address |
| `LEDGER_URL`, `ENGINE_URL` | mcp | `http://localhost:7001`, `http://localhost:7002` | Internal services |
| `TOKEN_CLIENT`, `TOKEN_AUDITOR`, `TOKEN_MANAGER` | mcp | demo tokens | One token per demo identity |
| `IDENTITIES_FILE` | mcp | unset | JSON list of `{token, user, role}` that replaces the three tokens |
| `OBJECT_STORE` | mcp | `dir` | `dir` for a directory, `s3` for MinIO or another S3-compatible store |
| `FILES_DIR` | mcp, engine | `./data/files` | Directory for the `dir` store |
| `MCP_STATEFUL` | mcp | `false` | Set `true` to keep MCP sessions between requests |
| `OLLAMA_URL`, `OLLAMA_MODEL` | engine | unset, `llama3.2:3b` | Optional local model for evidence extraction and memo wording |
| `LLM_URL`, `LLM_API_KEY`, `LLM_MODEL` | engine, agent | unset | Optional hosted model that speaks the chat completions format. For the engine it takes precedence over the local model. The agent requires it. An address that ends in `/v1` gets `/chat/completions` appended. Any other address is used as given. |
| `LLM_REASONING_EFFORT`, `LLM_WORKERS` | engine | unset, `2` | Reasoning effort asked of the hosted model, and the number of concurrent requests to it. Hidden reasoning is billed as output, so `minimal` suits document reading. |

## Tests

```sh
cd ledger && dune test          # posting rules, canonical JSON, hash chain, Merkle proofs, capabilities
cd mcp && go test ./...         # catalogue, validation, money conversion
python deploy/smoke.py          # end to end, against running services
```

`deploy/smoke.py` runs a small business through the client tools and an audit through the auditor tools. It asserts, among other things, that an auditor identity cannot write at the tool layer or at the ledger core, that parallel appends never fork the chain, that a repeated call appends once, that the auditor reads the snapshot and not later records, and that a client change after the snapshot is traced to the affected sample. Set `PSQL` to a superuser connection to include the tamper test.

## Repository conventions

- All work is committed to `main`.
- Each person changes only the paths they own (PRD section 26). A change to `contracts/` or `db/` is announced first.
- Documentation uses a formal tone and no em dashes.
