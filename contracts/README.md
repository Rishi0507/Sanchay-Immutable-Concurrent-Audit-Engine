# Contracts

Shared definitions that every component follows. A change here affects more than one service and is announced before it is pushed (PRD section 26.2).

| File | Defines | Read by |
|---|---|---|
| `events.json` | Event types, their tools, payload fields, references and chart of accounts | Ledger core, MCP server, audit engine, data generator |
| `ledger-api.md` | HTTP API of the ledger core | MCP server, audit engine |
| `engine-api.md` | HTTP API of the audit engine | MCP server |
| `finding.schema.json` | Finding record | Audit engine, MCP server, user interface |

## Conventions

| Topic | Rule |
|---|---|
| Money | Integer paise in every payload, table and service call. The MCP server converts to and from rupees at the tool boundary only. |
| Dates | `YYYY-MM-DD`. |
| Date and time | RFC 3339 in UTC, for example `2025-03-30T14:05:00Z`. |
| Identifiers | Lower-case prefix, underscore, 16 hexadecimal characters, for example `inv_3fa9c1d2e4b70a15`. |
| Errors | `{"error": {"code": "...", "message": "...", "next_step": "..."}}` with a 4xx or 5xx status. |
| Identity between services | Headers `X-Identity-User` and `X-Identity-Role`, plus `X-Service-Token` shared by the internal services. |

## Field types in `events.json`

| Type | Meaning |
|---|---|
| `string`, `int`, `number`, `bool` | Plain values. |
| `date`, `datetime` | As in the conventions above. |
| `money` | Non-negative integer paise. |
| `signed_money` | Integer paise that may be negative. |
| `enum` | One of `values`. |
| `ref` | Identifier of an existing aggregate of type `ref`. The ledger core rejects an unknown identifier. |
| `ref_list` | Array of such identifiers. |
| `array` | Array of objects described by `fields`, or by the named entry in `shared`. |

## Event attributes in `events.json`

| Attribute | Meaning |
|---|---|
| `mode` | `create` starts a new aggregate. `update` appends a version to an existing one. `reverse` marks an existing one as reversed. |
| `sale` | `new` starts a sale. `inherit` takes the `sale_id` of a referenced document. `inherit_or_new` inherits when a reference is given and otherwise starts a sale. `none` carries no `sale_id`. |
| `posts` | Whether the ledger core derives postings for the event. |
| `business_date` | The payload field that supplies the event's business date. |
