# Ledger core API

Base address inside the deployment: `http://ledger:7001`. All bodies are JSON. Every request carries `X-Service-Token`.

## POST /append

Appends one event to the business chain. Postings are derived by the ledger core from the event type and payload.

Request:

```json
{
  "event_type": "InvoiceIssued",
  "entity_id": "E1",
  "aggregate_type": "invoice",
  "aggregate_id": "inv_3fa9c1d2e4b70a15",
  "expected_version": 0,
  "sale_id": "sale_91c2aa0be7d14f03",
  "payload": {"invoice_no": "G/0001/24", "date": "2025-03-30", "customer_id": "cus_0a1b2c3d4e5f6a7b", "taxable_value": 10000000, "igst": 1800000, "gross": 11800000},
  "business_date": "2025-03-30",
  "identity": {"user": "client.agent", "role": "client_employee"},
  "idempotency_key": "b1f0c2e8-0001"
}
```

| Field | Rule |
|---|---|
| `expected_version` | 0 for `create`. The current version of the aggregate for `update` and `reverse`. |
| `sale_id` | Null when the event is not part of a sale. |
| `business_date` | Null when the event has none. |
| `identity.role` | Must be `client_employee`. Any other role is refused with `NOT_PERMITTED`. |

Response 200:

```json
{"seq": 1042, "hash": "9c1e...", "aggregate_version": 1, "duplicate": false}
```

`duplicate` is true when the idempotency key was seen before with the same request. The original result is returned and nothing is appended.

Errors:

| Status | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_FAILED` | The request or payload is malformed, or a required amount is missing. |
| 403 | `NOT_PERMITTED` | The identity holds no write capability. |
| 404 | `UNKNOWN_REFERENCE` | The payload refers to an aggregate that does not exist, or the target of an update or reversal does not exist. |
| 409 | `VERSION_CONFLICT` | `expected_version` differs from the current version. |
| 409 | `INVALID_TRANSITION` | The transition is impossible, for example reversing a document twice. |
| 409 | `IDEMPOTENCY_MISMATCH` | The idempotency key was used before with a different request. |
| 422 | `UNBALANCED_POSTING` | Debits do not equal credits. |

## GET /head

```json
{"seq": 1042, "hash": "9c1e..."}
```

For an empty chain, `seq` is 0 and `hash` is 64 zero characters.

## GET /verify?from=1&to=1042

Recomputes the chain over the range. Both parameters are optional and default to the whole chain. Add `at=<seq>` to also return the recomputed hash at that sequence number.

```json
{"ok": true, "checked": 1042, "first_bad_seq": null, "reason": null, "head_seq": 1042, "head_hash": "9c1e...", "at": {"seq": 900, "hash": "77ab..."}}
```

When `ok` is false, `first_bad_seq` is the first event that fails and `reason` is one of `hash_mismatch`, `prev_hash_mismatch`, `sequence_gap`, `postings_mismatch`.

## GET /merkle/{date}

Returns the Merkle root over the hashes of the events recorded on that UTC date, and stores it.

```json
{"date": "2025-03-30", "root": "5d0a...", "first_seq": 990, "last_seq": 1042, "count": 53}
```

404 with `NOT_FOUND` when the date has no events.

## GET /proof/{seq}

Returns the Merkle path that proves one event belongs to its day's root.

```json
{"seq": 1001, "hash": "aa41...", "date": "2025-03-30", "root": "5d0a...", "path": [{"side": "left", "hash": "c3..."}, {"side": "right", "hash": "09..."}]}
```

To check a proof, start from `hash` and fold over `path`: for a `left` entry compute `SHA256(entry || current)`, for a `right` entry compute `SHA256(current || entry)`. The result equals `root`.

## POST /trail/append

Appends one entry to the trail chain.

```json
{"identity": {"user": "auditor.agent", "role": "auditor"}, "tool": "run_detectors", "args_hash": "<64 hex>", "result_hash": "<64 hex>", "status": "ok", "engagement_id": "eng_01"}
```

Response 200: `{"trail_seq": 77, "hash": "e0b3..."}`

## GET /trail/verify

```json
{"ok": true, "checked": 77, "first_bad_seq": null, "reason": null, "head_seq": 77, "head_hash": "e0b3..."}
```

## GET /health

`{"status": "ok", "head_seq": 1042, "trail_seq": 77}`

## Hashing

`hash_n = SHA256(prev_hash || canonical_json(content_n))`, in lower-case hexadecimal. The genesis `prev_hash` is 64 zero characters.

Canonical JSON sorts object keys by byte order, uses no whitespace, writes integers without a fraction, and writes a number with a zero fraction as an integer.

Business event content:

```json
{
  "aggregate_id": "...", "aggregate_type": "...", "aggregate_version": 1,
  "business_date": "2025-03-30", "entity_id": "E1", "event_type": "InvoiceIssued",
  "idempotency_key": "...", "identity": {"role": "client_employee", "user": "client.agent"},
  "payload": {}, "postings": [{"account": "1100", "credit": 0, "debit": 11800000}],
  "recorded_at": "2025-03-30T14:05:00.123456Z", "sale_id": "...", "seq": 1042
}
```

Trail entry content:

```json
{
  "args_hash": "...", "engagement_id": "eng_01", "identity": {"role": "auditor", "user": "auditor.agent"},
  "result_hash": "...", "status": "ok", "tool": "run_detectors", "trail_seq": 77, "ts": "2025-04-20T09:00:00.000000Z"
}
```

Merkle root: leaves are the event hashes of the day in sequence order. A parent is `SHA256(left || right)` over the hexadecimal strings. An odd node at the end of a level is carried up unchanged.
