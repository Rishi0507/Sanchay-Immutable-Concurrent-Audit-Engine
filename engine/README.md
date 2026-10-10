# Audit engine

Python service for PRD sections 10 to 19: engagement and snapshot, register import and reconciliation, related-party identification, detectors D-01 to D-16, sampling, evidence verification, findings, change detection, integrity, workpaper and memo. Owner: Person B.

## Running

| Task | Command (from `engine/`) |
|---|---|
| Install | `uv sync` |
| Unit tests | `uv run pytest` |
| Serve the API on 7002 | `uv run python -m audit_engine.api` |
| Docker image | `docker build -t elev05-engine .` |
| Postgres DDL for the `audit` schema | `engine/sql/audit_schema.sql` (regenerate with `uv run python -c "from audit_engine.repo import postgres_ddl; print(postgres_ddl())"`) |

Integration tests and the self-test live in `datagen/` because they need generated data.

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `ENGINE_BUSINESS_SOURCE` | `postgresql+psycopg://...` (reads `business.events`, `business.postings`) or `fixture:<dir>` | `fixture:var/fixture` |
| `ENGINE_AUDIT_DB` | Database for the `audit` schema. SQLite is used for local work and tests. | `sqlite:///var/audit.db` |
| `ENGINE_FILES` | `minio://user:secret@host:9000/bucket` or `dir:<path>`. Files are addressed by SHA-256. | `dir:var/files` |
| `ENGINE_OUTPUT_DIR` | Where exported workpapers and memos are also written | `var/outputs` |
| `LEDGER_URL` | Ledger core, for `/verify` and `/trail/verify` | unset |
| `OLLAMA_URL`, `OLLAMA_MODEL` | Local model for evidence extraction and memo wording. Optional (AI-1). | unset, `llama3.2:3b` |
| `TESSERACT_CMD` | Tesseract binary for OCR. Found on PATH or in the usual install folders when unset. | unset |
| `ENGINE_COMPANY_FILE` | TOML with `[entities.E1]` name, GSTIN, PAN, phone, email, address and bank accounts of the company and group entities | unset |
| `ENGINE_THRESHOLDS` | Alternative thresholds file (DT-6) | `audit_engine/thresholds.toml` |

## API

The endpoints, headers and error format are in `contracts/engine-api/README.md`. The MCP server sets `X-Identity-User` and `X-Identity-Role`. The engine checks the role again.

## Module map

| Module | PRD | Content |
|---|---|---|
| `snapshot.py` | 6, 16.1 | Documents rebuilt from events with `seq <= snapshot_seq` |
| `engine.py` | 10.1, 9.2 | Engagements, plan, automatic prerequisites (TC-6), default engagement (TC-7), error format (TC-5) |
| `register_recon.py` | 10.2, 10.3 | Register copied exactly as provided, parsed values beside raw values, D-01 |
| `related_parties.py` | 11 | Signals, links, union-find clusters, bottleneck dates from anchors, D-02 and D-03 |
| `detectors/` | 13 | D-04 to D-09, D-11 to D-14, indicators, parallel runner |
| `graph.py` | 13.4 | Counterparty graph, Tarjan components, Johnson cycles up to length 6 |
| `sampling.py` | 12 | Sales, cut-off and credit note TODs, seeded RNG, reasons, evidence requests |
| `evidence/` | 14 | Text and OCR extraction, pattern rules and optional local model, checks E-1 to E-8, D-10 |
| `findings.py`, `findings_service.py` | 15 | Stable finding IDs, severity, template reasons, decisions, sign-off |
| `changes.py` | 16.3 | D-15 matching rules and sample reversion |
| `integrity.py` | 16.2 | Chain recomputation, snapshot hash and Merkle root comparison, D-16 |
| `outputs/` | 19 | Workpaper (.xlsx) and findings memo (.md, .docx) |
| `repo.py` | 4.4 | `audit` schema. Every table is insert-only (L4) |

## Design notes

| Topic | Decision |
|---|---|
| Determinism | No model call, no wall-clock value and no unordered iteration feeds a sample, a finding or a workpaper cell. Two runs give byte-identical workpapers. |
| Append-only audit schema | Current state is the latest row for a key: decisions (FN-3), sample test results (CH-2), steps done. |
| Finding IDs | `F-` and 16 hex characters of SHA-256 over engagement, category, subtype and subject. Re-running a step adds nothing (DT-4). |
| Evidence reuse (E-3) | Exact file hash and normalised text hash across samples of different transactions. Perceptual hash for raster scans. Samples of the same invoice in two TODs may share documents. |
| Evidence confidence (EV-4) | Text PDFs 0.95, OCR 0.85, disagreement between model and patterns 0.6. A required field below 0.8 gives `Needs human review`. |
| Model use | Optional. Model output is schema-validated and only fills or confirms fields. Memo rephrasing is discarded if any number changes. |
