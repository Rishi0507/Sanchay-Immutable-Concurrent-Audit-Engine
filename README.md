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
| `engine/` | Audit engine: reconciliation, sampling, detectors, outputs | Python | Pending |
| `datagen/` | Synthetic data and self-test | Python | Pending |

Until the audit engine exists, `mcp/cmd/mockengine` answers the engine API with simple results so the rest of the system can run.

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

Requirements: Postgres 16, Go 1.27, Node 22, and OCaml 5.2 with opam.

```sh
# 1. Database
createdb audit
PGDATABASE=audit sh db/apply.sh

# 2. Ledger core
cd ledger
opam install . --deps-only
DATABASE_URL=postgres://ledger_rw:ledger_rw@localhost:5432/audit dune exec ledger

# 3. Stand-in engine and MCP server
cd mcp
DATABASE_URL=postgres://engine_audit:engine_audit@localhost:5432/audit go run ./cmd/mockengine
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
