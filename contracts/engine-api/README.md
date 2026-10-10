# Engine API

The audit engine listens on `engine:7002` (PRD section 5.4). The MCP server calls it for every auditor and audit-manager tool (rule C-4). Bodies are JSON. Amounts are paise.

## 1. Headers set by the MCP server

| Header | Meaning |
|---|---|
| `X-Identity-User` | User name resolved from the bearer token. |
| `X-Identity-Role` | `auditor`, `audit_manager` or `client_employee`. The engine rejects a role that may not call the endpoint (defence in depth, layer L1 is the MCP server). |

## 2. Error format (TC-5)

Every non-2xx response has this body:

```json
{"code": "NO_ENGAGEMENT", "message": "No engagement is open.", "next_step": "Call open_engagement with period_start and period_end."}
```

| Code | HTTP status |
|---|---|
| `PERMISSION_DENIED` | 403 |
| `NO_ENGAGEMENT` | 409 |
| `NOT_FOUND` | 404 |
| `VALIDATION_FAILED` | 422 |
| `EVIDENCE_PENDING` | 409 |
| `MISSING_UPLOAD` | 409 |
| `ENGAGEMENT_CLOSED` | 409 |

## 3. Engagement selection (TC-7)

Every endpoint except `POST /engagements` accepts `engagement_id` in the body (POST) or the query (GET). If it is absent and exactly one engagement is open, that engagement is used. If none is open the engine returns `NO_ENGAGEMENT`. If several are open it returns `VALIDATION_FAILED` listing them.

## 4. Automatic prerequisites (TC-6)

Every response of a step endpoint carries `auto_ran`, the list of earlier deterministic steps the engine ran first, for example `["import_register", "reconcile_register"]`.

## 5. Endpoints

| Tool | Method and path | Request | Response |
|---|---|---|---|
| `get_audit_plan` | `GET /plan` | `engagement_id?` | `steps[] {step, tool, purpose, status (done, pending, blocked), detail}`, `next_tool` |
| `open_engagement` | `POST /engagements` | `period_start`, `period_end`, `seed?`, `entity_ids?`, `client_name?` | `engagement_id`, `seed`, `snapshot_seq`, `snapshot_hash`, `merkle_root`, `period_start`, `period_end` |
| `get_engagement_status` | `GET /engagements/status` | `engagement_id?` | engagement fields, `steps_completed[]`, `next_tool`, `finding_counts {High, Medium, Low}` |
| `import_register` | `POST /register/import` | `engagement_id?` | `import_id`, `file_hash`, `row_count`, `columns[]`, `missing_columns[]` |
| `reconcile_register` | `POST /register/reconcile` | `engagement_id?` | `rows_matched`, `findings_raised`, `by_subtype {}` |
| `tag_related_parties` | `POST /related-parties/tag` | `engagement_id?` | `tags[] {customer_id, name, tag, suggested_signals[], effective_from}`, `findings_raised` |
| `run_detectors` | `POST /detectors/run` | `engagement_id?`, `detectors?` | `by_detector {D-05: n, ...}`, `findings_raised`, `indicators {}` |
| `select_sales_tod` | `POST /samples/sales` | `engagement_id?` | `samples[] {sample_id, invoice_no, customer, taxable_value, reason, score}`, `population`, `strata`, `evidence_requests[]` |
| `select_cutoff_tod` | `POST /samples/cutoff` | `engagement_id?`, `after_count?` (10 to 15) | as above |
| `select_credit_note_tod` | `POST /samples/credit-notes` | `engagement_id?` | as above |
| `get_evidence_status` | `GET /evidence/status` | `engagement_id?`, `sample_id?` | `requests[] {request_id, sample_id, document_type, status, file_hash}` |
| `list_evidence_requests` (client) | `GET /evidence/requests` | `engagement_id?`, `status?` | `requests[]` as above |
| `request_evidence` | `POST /evidence/requests` | `engagement_id?`, `sample_id`, `document_type`, `note` | `request_id` |
| `verify_evidence` | `POST /evidence/verify` | `engagement_id?`, `sample_id?` | `results[] {sample_id, tests {}, checks[]}`, `findings_raised` |
| `check_post_testing_changes` | `POST /changes/check` | `engagement_id?` | `events_examined`, `matches[] {seq, event_type, identity, sample_ids[], finding_ids[]}`, `findings_raised` |
| `verify_ledger_integrity` | `POST /integrity/verify` | `engagement_id?`, `ledger_result?` | `business {ok, first_bad_seq, head_hash}`, `trail {ok, first_bad_seq}`, `snapshot_hash_ok`, `findings_raised` |
| `get_findings` | `GET /findings` | `engagement_id?`, `category?`, `severity?`, `status?`, `limit?`, `cursor?` | `items[]` (finding records), `next_cursor` |
| `explain_finding` | `GET /findings/{finding_id}/explain` | | `finding`, `reason`, `lineage`, `standard_refs`, `decisions[]` |
| `confirm_finding` | `POST /findings/{finding_id}/decisions` | `decision` (`confirmed`, `rejected`, `needs_info`), `note` | `decision_id`, `status` |
| `sign_off_engagement` | `POST /engagements/sign-off` | `engagement_id?` | `closed`, `undecided[]` |
| `draft_findings_memo` | `POST /memo` | `engagement_id?`, `format?` (`md`, `docx`, `both`) | `files[] {format, file_hash, path}` |
| `export_workpaper` | `POST /workpaper` | `engagement_id?` | `file_hash`, `path`, `sheets[]` |
| `query_records` | `POST /records/query` | `engagement_id?`, `record_type`, `filters {}`, `limit?`, `cursor?` | `items[]`, `next_cursor` |
| `get_sale_chain` | `GET /sales/{sale_id}/chain` | `engagement_id?` | `events[]` |
| `get_ledger_entries` | `GET /ledger/entries` | `engagement_id?`, `account?`, `date_from?`, `date_to?`, `sale_id?`, `limit?`, `cursor?` | `items[]`, `next_cursor` |
| `get_counterparty_graph` | `GET /graph` | `engagement_id?` | `nodes[]`, `edges[]`, `cycles[]` |
| (download) | `GET /files/{file_hash}` | | file bytes |

## 6. Ledger core calls made by the engine

| Purpose | Call |
|---|---|
| Snapshot head at `open_engagement` | `GET ledger:7001/head` |
| Merkle root at the snapshot | `GET ledger:7001/merkle/{date}` (falls back to a root computed by the engine over events up to the snapshot) |
| Integrity | `GET ledger:7001/verify`, `GET ledger:7001/trail/verify`. The engine also recomputes the business chain itself from `business.events` (TE-4). |
