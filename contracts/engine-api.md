# Audit engine API

Base address inside the deployment: `http://engine:7002`. All bodies are JSON. The MCP server is the only caller. Each auditor tool maps to one endpoint (PRD section 9.4, rule C-4).

## Headers

| Header | Value |
|---|---|
| `X-Service-Token` | Shared internal token. |
| `X-Identity-User` | User name of the caller. |
| `X-Identity-Role` | `client_employee`, `auditor` or `audit_manager`. |

The MCP server has already checked that the role may call the tool. The engine uses the identity for records such as `opened_by` and `decided_by`, and refuses `POST /findings/{id}/decisions` and `POST /engagements/{id}/sign-off` unless the role is `audit_manager`.

## Common rules

| Rule | Statement |
|---|---|
| Engagement | Every endpoint except `POST /engagements`, `GET /engagements` and `GET /evidence/requests` takes `engagement_id`, in the body for POST and in the query for GET. When it is omitted and exactly one engagement is open, that engagement is used. Otherwise the engine returns `NO_ENGAGEMENT`. |
| Prerequisites | An endpoint that depends on an earlier deterministic step runs it and lists it in `auto_ran` (TC-6). |
| Repeat calls | Calling an endpoint again returns the stored result. It does not create duplicates (DT-4, SM-7). |
| Pagination | List endpoints take `limit` (default 50, maximum 500) and `cursor`, and return `next_cursor`, which is null on the last page. |
| Money | Integer paise. |
| Errors | `{"error": {"code": "...", "message": "...", "next_step": "..."}}`. Codes: `NO_ENGAGEMENT`, `NOT_FOUND`, `VALIDATION_FAILED`, `EVIDENCE_PENDING`, `PERMISSION_DENIED`. |
| Files | Outputs are written to the file store by SHA-256 and returned as `{"file_hash": "...", "file_name": "...", "content_type": "..."}`. See the file store layout below. |
| Money keys | The MCP server converts paise to rupees in responses by key name. A key holds money when it is a money field of `events.json`, or one of `amount_impact`, `total_adjustment`, `sales_value`, `debit`, `credit`, `balance`, `total`, `total_debit`, `total_credit`, or ends in `_amount`, `_value` or `_total`. Use these names only for integer paise, and no other name for money. |

## Endpoints

| Tool | Method and path | Request fields | Response fields |
|---|---|---|---|
| `get_audit_plan` | `GET /plan` | `engagement_id` optional | `steps[]` of `{step, tool, purpose, status}` where status is `done`, `ready` or `blocked`; `next_tool` |
| `open_engagement` | `POST /engagements` | `period_start`, `period_end`, `seed` optional, `entity_ids` optional | `engagement_id`, `period_start`, `period_end`, `seed`, `snapshot_seq`, `snapshot_hash`, `merkle_root` |
| `list_engagements` | `GET /engagements` | none | `engagements[]` |
| (called by `upload_sales_register`) | `POST /sampling/seal` | `upload_seq` | `register_upload_seq`, `commitment`, `sealed_when`, `sealed_at`. Sealing twice returns the first seal. Never returns the secret. |
| `verify_sampling_seal` | `GET /sampling/seal` | `engagement_id` optional (the latest register upload when omitted) | `commitment`, `sealed_when`, `status` of `sealed`, `verified`, `sealed at opening`, `chosen` or `failed`; once an engagement is open also `secret`, `seed`, `snapshot_hash`, `checks` |
| `get_engagement_status` | `GET /engagements/status` | `engagement_id` | engagement fields, `seed_source` of `sealed` or `chosen`, `steps[]`, `next_tool`, `counts` of `{findings_by_severity, samples_by_sheet, evidence_pending, control_requests of {sent, declined, supplied, pending}}`, `signed_off` |
| `import_register` | `POST /register/import` | `engagement_id` | `rows`, `columns[]`, `unrecognised_columns[]`, `missing_columns[]`, `file_hash` |
| `reconcile_register` | `POST /register/reconcile` | `engagement_id` | `summary` by subtype, `findings_created`, `auto_ran[]` |
| `get_register_rows` | `GET /register/rows` | `engagement_id`, `recon_status` optional, `rp_tag` optional, `limit`, `cursor` | `columns[]`, `rows[]` of `{row_no, raw, rp_tag, suggested_rp, recon_status, finding_ids}`, `next_cursor` |
| `tag_related_parties` | `POST /related-parties/tag` | `engagement_id` | `customers`, `related_disclosed`, `related_suggested`, `suggestions[]` of `{customer_id, name, signals[], effective_from, sales_value}`, `findings_created`, `auto_ran[]` |
| `run_detectors` | `POST /detectors/run` | `engagement_id`, `detectors[]` optional | `results[]` of `{detector_id, category, hits}`, `findings_created`, `indicators`, `auto_ran[]` |
| `select_sales_tod` | `POST /samples/sales` | `engagement_id`, `target` optional (25 to 35) | `sheet`, `seed`, `snapshot_seq`, `population`, `samples[]`, `evidence_requests_created`, `auto_ran[]` |
| `select_cutoff_tod` | `POST /samples/cutoff` | `engagement_id`, `before` optional (default 10), `after` optional (10 to 15, default 15) | same shape as above |
| `select_credit_note_tod` | `POST /samples/credit-notes` | `engagement_id` | same shape as above |
| `get_samples` | `GET /samples` | `engagement_id`, `sheet` | `samples[]` |
| `get_evidence_status` | `GET /evidence/status` | `engagement_id` | `samples[]` of `{sample_id, sheet, documents[] of {document_type, status, file_hash}}`, `pending`, `received`, `verified` |
| `list_evidence_requests` | `GET /evidence/requests` | `status` optional (`pending`, `received`), `limit`, `cursor` | `requests[]` of `{request_id, sample_id, sheet, document_type, subject of {invoice_no, date, customer, amount}, status, note}`, `next_cursor` |
| `request_evidence` | `POST /evidence/requests` | `engagement_id`, `sample_ids[]`, `document_types[]`, `note` optional | `requests_created` |
| `verify_evidence` | `POST /evidence/verify` | `engagement_id`, `sample_id` optional (all samples when omitted) | `results[]` of `{sample_id, tests of {test: result}, checks[] of {check_id, result, detail}}`, `findings_created`, `control_requests` of `{sent, declined, supplied, pending}` |
| `check_post_testing_changes` | `POST /changes/check` | `engagement_id` | `changes[]` of `{seq, event_type, identity_user, recorded_at, sample_ids[], finding_ids[]}`, `findings_created`, `head_seq` |
| `get_findings` | `GET /findings` | `engagement_id`, `category`, `severity`, `status`, `sample_id` all optional, `limit`, `cursor` | `findings[]` (compact: no lineage), `next_cursor`, `totals` |
| `explain_finding` | `GET /findings/{finding_id}/explain` | none | full finding record, `explanation`, `documents[]` |
| `confirm_finding` | `POST /findings/{finding_id}/decisions` | `decision` (`confirmed`, `rejected`, `needs_info`), `note` optional | `finding_id`, `status`, `decided_by`, `decided_at` |
| `export_summary_report` | `POST /summary` | `engagement_id` | `summary` of `{findings, samples, evidence, revenue, safeguards}`, `file` (a one-page PDF), `head_hash` |
| `sign_off_engagement` | `POST /engagements/sign-off` | `engagement_id`, `note` optional | `signed_by`, `signed_at`; `VALIDATION_FAILED` listing undecided findings otherwise |
| `get_counterparty_graph` | `GET /graph` | `engagement_id` | `nodes[]` of `{id, label, kind, related}`, `edges[]` of `{source, target, kind, value, count}`, `cycles[]` of `{finding_id, path[], value}` |
| `draft_findings_memo` | `POST /memo` | `engagement_id` | `files[]`, `findings`, `total_adjustment`, `head_hash` |
| `export_workpaper` | `POST /workpaper` | `engagement_id` | `file`, `sheets[]`, `head_hash` |
| `verify_ledger_integrity` | `POST /integrity/report` | `engagement_id`, `business_chain`, `trail_chain` (the ledger core's verification results), `snapshot_match` | `findings_created`. The engine records a `LEDGER_INTEGRITY` finding when a chain fails or the snapshot hash differs. |
| (health) | `GET /health` | none | `{"status": "ok"}` |

## Sample record

```json
{
  "sample_id": "smp_5b2d19c07fa34e61",
  "sheet": "sales_tod",
  "position": 3,
  "subject_type": "invoice",
  "subject_id": "inv_3fa9c1d2e4b70a15",
  "sale_id": "sale_91c2aa0be7d14f03",
  "invoice_no": "G/0001/24",
  "date": "2025-03-30",
  "customer": "Example Shipyard Limited",
  "related": "Related Party",
  "taxable_value": 10000000,
  "reason_codes": ["RELATED_PARTY", "KEY_ITEM"],
  "reason": "RELATED_PARTY (disclosed); KEY_ITEM (rank 3 by value); 1 day before period end.",
  "tests": {"Occurrence": "Pending evidence", "Amount": "Pass"},
  "finding_ids": []
}
```

## Read tools served by the MCP server

`query_records`, `get_sale_chain`, `get_ledger_entries`, `get_notifications` and `get_audit_trail` read the `business` and `trail` schemas directly from the MCP server with its read-only role. They take the snapshot sequence from `audit.engagements`, so they need no engine endpoint.

## File store layout

The MCP server and the engine share one content-addressed store, selected by `OBJECT_STORE`.

| Store | Layout |
|---|---|
| `dir` (default) | `FILES_DIR/<first two characters of hash>/<hash>` holds the bytes. `<hash>.json` beside it holds `{"file_hash", "file_name", "content_type", "size"}`. |
| `s3` | Bucket `S3_BUCKET`, object key `<hash>`. The content type is the object's content type and the file name is the user metadata entry `file-name`. |

The hash is SHA-256 of the bytes in lower-case hexadecimal. A client upload is identified by the `file_hash` in its `SalesRegisterUploaded`, `RelatedPartyListUploaded` or `EvidenceUploaded` event.
