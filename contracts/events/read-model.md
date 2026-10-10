# Business read model expected by the audit engine

The engine reads the `business` schema directly with the `engine_audit` role (PRD section 4.4). It needs the two relations below. Person A owns the DDL. If the names differ, a view with these names is sufficient.

## business.events

| Column | Type |
|---|---|
| `seq` | bigint, primary key |
| `event_type` | text |
| `entity_id` | text |
| `aggregate_id` | text |
| `aggregate_version` | integer |
| `sale_id` | text, nullable |
| `payload` | jsonb |
| `business_date` | date |
| `recorded_at` | timestamptz |
| `identity_user` | text |
| `identity_role` | text |
| `idempotency_key` | text |
| `prev_hash` | char(64) |
| `hash` | char(64) |

## business.postings

| Column | Type |
|---|---|
| `seq` | bigint, the event that produced the posting |
| `line_no` | integer, order within the event |
| `entity_id` | text |
| `account` | text, chart of accounts code |
| `debit` | bigint, paise |
| `credit` | bigint, paise |
| `sale_id` | text, nullable |
| `source_event_type` | text |
| `business_date` | date |

## Queries the engine issues

| Purpose | Filter |
|---|---|
| Snapshot load | `seq <= :snapshot_seq` |
| Change detection | `seq > :snapshot_seq` |
| Evidence intake | `event_type = 'EvidenceUploaded'` with no sequence bound |
