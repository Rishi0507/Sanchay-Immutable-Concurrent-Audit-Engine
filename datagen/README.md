# Data generator and self-test

Synthetic manufacturer with planted irregularities, an answer key, evidence files and the self-test (PRD section 23). Owner: Person B.

## Running

| Task | Command (from `datagen/`) |
|---|---|
| Install | `uv sync` |
| Clean baseline | `uv run python -m elev_datagen generate --dataset clean --out ../var/clean` |
| Planted dataset | `uv run python -m elev_datagen generate --dataset planted --out ../var/planted` |
| Load through the MCP client tools | add `--mcp-url http://localhost:8080/mcp --token <client token>` |
| Self-test report | `uv run python -m elev_datagen.selftest --out ../var/selftest` |
| Tests (generator and engine integration) | `uv run pytest` |
| Copy a fixture into Postgres (development only) | `uv run python -m elev_datagen.pgload ../var/planted/fixture postgresql://...` |

`--scale 0.15` gives a dataset of about 1,000 sales for quick runs.

## Output of `generate`

| Path | Content |
|---|---|
| `fixture/events.jsonl`, `fixture/postings.jsonl` | The business chain from the local ledger emulator, in the shape of `contracts/events/read-model.md` |
| `files/` | Uploaded files by SHA-256 (register, related-party list, later evidence) |
| `uploads/` | The client's register (.xlsx, Fig. 1 layout) and related-party list (.csv) |
| `company.toml` | Company and group entity identifiers, for `ENGINE_COMPANY_FILE` |
| `answer_key.json` | Planted items. Outside the fixture and the file store, so no tool can read it (SD-5) |

## The business

| Item | Value at scale 1.0 |
|---|---|
| Company | Shreeji Precision Components Pvt Ltd (E1, Maharashtra). Group entity E2 appears in the planted set only. |
| Period | 1 April 2025 to 31 March 2026. Activity continues to 10 July 2026, when the register and related-party list are uploaded. |
| Sales | About 6,900 in the period, 8,800 in all, 150 customers, 40 vendors |
| Documents per sale | Enquiry, order, dispatch, e-way bill above Rs 50,000, LR, delivery, invoice with IRN, GSTR-1 line, receipt, bank line |
| Other | Price list with a mid-year revision, three promotion schemes, credit notes with returns, purchases and payments, monthly GST journals |

## Planted irregularities

Every detector D-01 to D-14 has at least two planted items of different shapes (SD-4). D-10 items are planted when evidence is uploaded, D-15 items by the change scenario after the snapshot, and D-16 by editing a stored event.

| Detector | Shapes planted |
|---|---|
| D-01 | Missing rows, rows with no invoice, field differences (amount, GSTIN, date), duplicate rows, rows that do not foot, reversed invoices left in the register, total not agreed |
| D-02 | Shared bank account with the MD, CFO as director, CS phone and re-typed address, receipt from a disclosed party's account |
| D-03 | Director appointed mid-year, customer master updated to add the MD, disclosed relationship starting mid-year, late disclosure |
| D-04 | Goods cycle through a customer and vendor with one PAN, money cycle through a vendor paying a customer's invoice, three-party goods cycle through group entity E2 |
| D-05 | Invoice with no order or movement, no dispatch, no delivery, no e-way bill, short dispatch, contradictory vehicle |
| D-06 | Delivered terms recognised before delivery (two), ex-works recognised after dispatch |
| D-07 | Year-end sales spike with high discounts and later credit notes, discount spike |
| D-08 | Invoices left out of GSTR-1, GSTR-1 line with no invoice, invalid GSTIN checksum, IGST on intra-state, CGST and SGST on inter-state, e-way bill value, GSTR-1 value, period total |
| D-09 | Journals crediting Sales from suspense, receivables and bank |
| D-10 | Altered amount, short e-way bill validity, editing-tool producer, different LR vehicle, reused file, e-way bill of another invoice, replacement after verification |
| D-11 | Post-period credit notes, 90 percent of a period-end invoice, no approver, related party, no return |
| D-12 | No scheme, above scheme rate, outside scheme dates, ineligible customer, below price list without approver |
| D-13 | Receipt not on the bank statement, third-party payers, receipt then payment to a linked vendor, unpaid period-end invoices |
| D-14 | Number gap, duplicate number, backdating, out-of-order date, reused e-way bill, vehicle on two trips, impossible delivery speed |
| D-15 | Reversal, customer bank change, journal to Sales, credit note, evidence replacement |
| D-16 | One stored event edited outside the ledger |

## Self-test result (scale 1.0, seed 7)

| Measure | Result | Target |
|---|---|---|
| Recall | 100 percent in all 16 categories | 100 percent |
| Findings on the clean baseline | 0 | 0 |
| Same seed and snapshot | Identical samples, findings and workpaper file | Identical |

## Assumptions to confirm with Person A

| Topic | Assumption |
|---|---|
| Tool arguments | Each client tool takes the payload fields of `contracts/events` plus `entity_id`, `aggregate_id`, `sale_id`, `business_date` and `idempotency_key`. Upload tools take `content_base64` and `file_name`. |
| Simulated clock | The seed loader sends `X-Sim-Recorded-At`. The ledger core honours it when `LEDGER_SIM_CLOCK=1` (contracts/events, section 3). Without it every invoice looks backdated to D-14. |
| Read model | `business.events` and `business.postings` as in `contracts/events/read-model.md`. |
| Audit schema | `engine/sql/audit_schema.sql`, to be applied by the migrations in `db/`. |
