# Event contract

The machine-readable schema is `events.schema.json` (JSON Schema 2020-12). This file explains the envelope, hashing and references.

## 1. Envelope

| Field | Type | Set by | Notes |
|---|---|---|---|
| `seq` | integer | Ledger core | Gap-free, starts at 1. |
| `event_type` | string | Caller (via tool) | One of the types in section 4. |
| `entity_id` | string | Caller | Legal entity, for example `E1`. |
| `aggregate_id` | string | Caller | Unique id of the document or master record. Distinct from the document number, so that a duplicated document number is representable (detector D-14). |
| `aggregate_version` | integer | Ledger core | 1 for the first event of an aggregate. |
| `sale_id` | string or null | Caller | Links all events of one sale. |
| `payload` | object | Caller | Section 4. |
| `business_date` | date | Caller | The date the event states for itself. |
| `recorded_at` | RFC 3339 UTC | Ledger core | Server time. See section 3 for seeding. |
| `identity` | object | MCP server | `{"user": "...", "role": "client_employee"}`. |
| `idempotency_key` | string | Caller | |
| `prev_hash` | 64 hex | Ledger core | Genesis is 64 zero characters. |
| `hash` | 64 hex | Ledger core | Section 2. |

## 2. Hash chain

```
hash_n = lower_hex( SHA256( utf8( prev_hash_n + canonical_json(content_n) ) ) )
```

- `content_n` is the envelope without `hash`. It includes `prev_hash`.
- `canonical_json`: keys sorted by Unicode code point at every level, separators `,` and `:` with no whitespace, non-ASCII characters emitted as UTF-8 (not escaped), integers in plain decimal, `null`, `true` and `false` in lower case. Floats are not permitted.
- Python reference: `json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.
- A reference implementation lives in `engine/audit_engine/chain.py` and is used by the generator's fixture emulator. The ledger core must produce identical hashes for identical input. Test vectors are in `chain-vectors.json`.

## 3. Seeding with simulated time

Synthetic data spans a financial year but is loaded in minutes. Without help, every `recorded_at` would fall on the load day and detector D-14 (backdating) would flag every invoice.

| Item | Statement |
|---|---|
| Header | The seed loader sends `X-Sim-Recorded-At: <RFC 3339 UTC>` on each client tool call. |
| Honoured when | The ledger core is started with `LEDGER_SIM_CLOCK=1`. Otherwise the header is ignored. |
| Monotonic | The ledger core uses `max(header, previous recorded_at)` so that time never runs backwards on the chain. |
| Off in production | The demo compose file may enable it only for the seed step. |

## 4. Payloads

Every amount is in paise. Every percentage is in basis points. Referenced ids are business ids from earlier payloads.

| Event type | Aggregate id | Payload fields | References |
|---|---|---|---|
| `CustomerCreated` | `customer_id` | `customer_id`, `name`, `gstin`, `pan`, `addresses[]`, `phone`, `email`, `bank_accounts[]`, `directors[]`, `effective_from` | |
| `CustomerUpdated` | `customer_id` | `customer_id`, `changes` (subset of the created fields), `effective_from` | customer |
| `VendorCreated` | `vendor_id` | as customer, with `vendor_id` | |
| `VendorUpdated` | `vendor_id` | `vendor_id`, `changes`, `effective_from` | vendor |
| `CompanyOfficerRecorded` | `officer_id` | `officer_id`, `name`, `pan`, `din`, `role`, `phone`, `email`, `address`, `bank_accounts[]`, `effective_from`, `effective_to` | |
| `PriceSet` | `price:<item>` | `item`, `rate`, `effective_from` | |
| `PromotionCreated` | `scheme_id` | `scheme_id`, `discount_bp`, `valid_from`, `valid_to`, `eligible_customers` (array or null for all), `approver` | |
| `EnquiryRecorded` | `enquiry_id` | `enquiry_id`, `customer_id`, `date`, `channel`, `items[] {item, qty}` | customer |
| `SalesOrderCreated` | `order_id` | `order_id`, `enquiry_id`, `customer_id`, `order_date`, `items[] {item, qty, rate, discount_bp}`, `scheme_id`, `delivery_terms` (`EX_WORKS` or `DELIVERED`), `approver`, `bu`, `unit` | customer, enquiry |
| `DispatchRecorded` | `dispatch_id` | `dispatch_id`, `order_id`, `dispatched_at`, `items[] {item, qty}`, `vehicle_no`, `from_address`, `to_address`, `distance_km` | order |
| `EWayBillGenerated` | `ewb:<ewb_no>:<n>` | `ewb_no`, `invoice_no`, `dispatch_id`, `value`, `supplier_gstin`, `recipient_gstin`, `vehicle_no`, `distance_km`, `generated_at`, `valid_until` | dispatch |
| `LorryReceiptRecorded` | `lr:<lr_no>:<n>` | `lr_no`, `dispatch_id`, `transporter`, `vehicle_no`, `date`, `consignee` | dispatch |
| `DeliveryRecorded` | `dispatch_id` | `dispatch_id`, `delivered_at`, `receiver`, `pod_ref` | dispatch |
| `InvoiceIssued` | `inv:<n>` | `invoice_no`, `invoice_date`, `customer_id`, `customer_name`, `customer_gstin`, `order_id`, `dispatch_id`, `items[] {item, qty, rate, discount_bp, amount}`, `taxable_value`, `discount`, `packing`, `freight`, `insurance`, `cgst`, `sgst`, `igst`, `tcs`, `round_off`, `gross`, `place_of_supply`, `tax_rate_bp`, `irn`, `ledger_account`, `bu`, `unit` | customer, order, dispatch |
| `Gstr1Filed` | `gstr1:<period>:<n>` | `return_period` (`YYYY-MM`), `supplier_gstin`, `lines[] {invoice_no, invoice_date, gstin, taxable_value, cgst, sgst, igst, place_of_supply}` | |
| `ReceiptRecorded` | `receipt_id` | `receipt_id`, `customer_id`, `invoice_refs[]` (invoice numbers), `amount`, `date`, `payer_name`, `payer_account`, `utr` | customer |
| `BankStatementImported` | `statement_id` | `statement_id`, `account_no`, `lines[] {date, amount, direction (CR or DR), counterparty_name, counterparty_account, utr}` | |
| `CreditNoteIssued` | `cn:<n>` | `credit_note_no`, `date`, `original_invoice_no`, `customer_id`, `reason`, `taxable_value`, `cgst`, `sgst`, `igst`, `gross`, `approver` | invoice |
| `SalesReturnRecorded` | `sr:<n>` | `credit_note_no`, `inward_date`, `items[] {item, qty}`, `vehicle_no` | credit note |
| `PurchaseInvoiceRecorded` | `purchase_id` | `purchase_id`, `vendor_id`, `invoice_no`, `date`, `items[] {item, qty, rate, amount}`, `taxable_value`, `cgst`, `sgst`, `igst`, `gross` | vendor |
| `GoodsReceiptRecorded` | `grn:<n>` | `purchase_id`, `date`, `items[] {item, qty}`, `vehicle_no` | purchase |
| `PaymentMade` | `payment_id` | `payment_id`, `vendor_id`, `amount`, `date`, `payee_account`, `utr`, `purchase_refs[]` | vendor |
| `JournalPosted` | `journal_id` | `journal_id`, `date`, `narration`, `lines[] {account, debit, credit, ref}`, `approver` | |
| `DocumentReversed` | target aggregate id | `target_aggregate_id`, `reason` | any aggregate |
| `SalesRegisterUploaded` | `upload:<file_hash>` | `file_hash`, `file_name`, `row_count`, `period_start`, `period_end` | |
| `RelatedPartyListUploaded` | `upload:<file_hash>` | `file_hash`, `file_name`, `parties[] {name, pan, gstin, relationship, effective_from}` | |
| `EvidenceUploaded` | `evidence:<file_hash>:<request_id>` | `sample_id`, `request_id`, `document_type`, `file_hash`, `file_name` | |

Shared sub-objects:

| Object | Fields |
|---|---|
| address | `line1`, `city`, `state_code`, `pincode` |
| addresses[] item | address fields plus `kind` (`billing` or `shipping`) |
| bank account | `account_no`, `ifsc` |
| director | `name`, `pan`, `din` |

## 5. Invoice arithmetic

| Quantity | Definition |
|---|---|
| line `amount` | `qty * rate * (10000 - discount_bp) / 10000`, rounded half up to the paisa |
| `discount` | `sum(qty * rate) - sum(amount)` |
| `taxable_value` | `sum(amount)`, that is, after discount |
| tax base | `taxable_value + packing + freight + insurance` |
| tax | `tax base * tax_rate_bp / 10000`, split equally into CGST and SGST when `place_of_supply` equals the supplier state, otherwise IGST |
| `gross` | `taxable_value + packing + freight + insurance + cgst + sgst + igst + tcs + round_off`, a whole number of rupees |

The register "Total Cost" column is `taxable_value`. "Discount" is shown for information and is already deducted, so a row foots when Total Cost, Packing, Freight, Insurance, IGST, CGST, SGST, TCS Collection and Round sum to Gross Amt.

## 6. Ledger postings (fixture emulator)

The generator's emulator in `datagen/emulator.py` applies PRD section 7.2. A negative `round_off` is posted as a debit to 4900. `DocumentReversed` mirrors the target's postings.
