-- Document views over the event log (PRD section 6.1). A document is the
-- event that created it. Every view exposes seq, so a reader applies a
-- snapshot with "WHERE seq <= :snapshot_seq", and reversed_seq, so a reader
-- can tell whether the reversal falls inside the snapshot.

CREATE VIEW business.v_reversals AS
SELECT aggregate_id, seq AS reversed_seq, business_date AS reversed_on,
       payload->>'reason' AS reason, identity_user AS reversed_by
FROM business.events
WHERE event_type = 'DocumentReversed';

CREATE VIEW business.v_documents AS
SELECT e.seq,
       e.event_type,
       e.aggregate_type,
       e.aggregate_id,
       e.entity_id,
       e.sale_id,
       e.business_date,
       e.recorded_at,
       e.identity_user,
       e.payload,
       r.reversed_seq
FROM business.events e
LEFT JOIN business.v_reversals r ON r.aggregate_id = e.aggregate_id
WHERE e.aggregate_version = 1;

-- Master records carry versions. Each row is one effective-dated version.
CREATE VIEW business.v_party_versions AS
SELECT e.seq,
       e.aggregate_type AS party_type,
       e.aggregate_id   AS party_id,
       e.aggregate_version AS version,
       e.entity_id,
       (e.payload->>'effective_from')::date AS effective_from,
       e.recorded_at,
       e.payload
FROM business.events e
WHERE e.event_type IN ('CustomerCreated', 'CustomerUpdated', 'VendorCreated', 'VendorUpdated');

CREATE VIEW business.v_customers AS
SELECT seq, aggregate_id AS customer_id, entity_id, payload->>'name' AS name,
       payload->>'gstin' AS gstin, payload->>'pan' AS pan,
       payload->>'state_code' AS state_code, business_date AS effective_from,
       recorded_at, payload, reversed_seq
FROM business.v_documents WHERE event_type = 'CustomerCreated';

CREATE VIEW business.v_vendors AS
SELECT seq, aggregate_id AS vendor_id, entity_id, payload->>'name' AS name,
       payload->>'gstin' AS gstin, payload->>'pan' AS pan,
       payload->>'state_code' AS state_code, business_date AS effective_from,
       recorded_at, payload, reversed_seq
FROM business.v_documents WHERE event_type = 'VendorCreated';

CREATE VIEW business.v_company_officers AS
SELECT seq, aggregate_id AS officer_id, entity_id, payload->>'name' AS name,
       payload->>'pan' AS pan, payload->>'din' AS din, payload->>'role' AS role,
       (payload->>'effective_from')::date AS effective_from,
       (payload->>'effective_to')::date AS effective_to,
       recorded_at, payload, reversed_seq
FROM business.v_documents WHERE event_type = 'CompanyOfficerRecorded';

CREATE VIEW business.v_prices AS
SELECT seq, aggregate_id AS price_id, entity_id, payload->>'item_code' AS item_code,
       (payload->>'rate')::bigint AS rate, business_date AS effective_from,
       recorded_at, payload, reversed_seq
FROM business.v_documents WHERE event_type = 'PriceSet';

CREATE VIEW business.v_promotions AS
SELECT seq, aggregate_id AS promotion_id, entity_id, payload->>'scheme_id' AS scheme_id,
       (payload->>'discount_percent')::numeric AS discount_percent,
       (payload->>'valid_from')::date AS valid_from,
       (payload->>'valid_to')::date AS valid_to,
       payload->>'approver' AS approver,
       recorded_at, payload, reversed_seq
FROM business.v_documents WHERE event_type = 'PromotionCreated';

CREATE VIEW business.v_enquiries AS
SELECT seq, aggregate_id AS enquiry_id, entity_id, sale_id,
       payload->>'customer_id' AS customer_id, business_date AS date,
       recorded_at, payload, reversed_seq
FROM business.v_documents WHERE event_type = 'EnquiryRecorded';

CREATE VIEW business.v_sales_orders AS
SELECT seq, aggregate_id AS order_id, entity_id, sale_id,
       payload->>'customer_id' AS customer_id, payload->>'order_no' AS order_no,
       business_date AS date, payload->>'delivery_terms' AS delivery_terms,
       payload->>'scheme_id' AS scheme_id, payload->>'approver' AS approver,
       recorded_at, payload, reversed_seq
FROM business.v_documents WHERE event_type = 'SalesOrderCreated';

CREATE VIEW business.v_dispatches AS
SELECT seq, aggregate_id AS dispatch_id, entity_id, sale_id,
       (payload->>'dispatched_at')::timestamptz AS dispatched_at,
       business_date AS date, payload->>'vehicle_no' AS vehicle_no,
       (payload->>'distance_km')::numeric AS distance_km,
       recorded_at, payload, reversed_seq
FROM business.v_documents WHERE event_type = 'DispatchRecorded';

CREATE VIEW business.v_eway_bills AS
SELECT seq, aggregate_id AS eway_bill_id, entity_id, sale_id,
       payload->>'ewb_no' AS ewb_no, payload->>'invoice_no' AS invoice_no,
       business_date AS date, (payload->>'value')::bigint AS value,
       payload->>'supplier_gstin' AS supplier_gstin,
       payload->>'recipient_gstin' AS recipient_gstin,
       payload->>'vehicle_no' AS vehicle_no,
       (payload->>'distance_km')::numeric AS distance_km,
       (payload->>'valid_until')::timestamptz AS valid_until,
       recorded_at, payload, reversed_seq
FROM business.v_documents WHERE event_type = 'EWayBillGenerated';

CREATE VIEW business.v_lorry_receipts AS
SELECT seq, aggregate_id AS lorry_receipt_id, entity_id, sale_id,
       payload->>'lr_no' AS lr_no, payload->>'transporter' AS transporter,
       business_date AS date, payload->>'vehicle_no' AS vehicle_no,
       recorded_at, payload, reversed_seq
FROM business.v_documents WHERE event_type = 'LorryReceiptRecorded';

CREATE VIEW business.v_deliveries AS
SELECT seq, aggregate_id AS delivery_id, entity_id, sale_id,
       (payload->>'delivered_at')::timestamptz AS delivered_at,
       business_date AS date, payload->>'pod_reference' AS pod_reference,
       recorded_at, payload, reversed_seq
FROM business.v_documents WHERE event_type = 'DeliveryRecorded';

CREATE VIEW business.v_invoices AS
SELECT seq, aggregate_id AS invoice_id, entity_id, sale_id,
       payload->>'invoice_no' AS invoice_no, business_date AS date,
       payload->>'customer_id' AS customer_id, payload->>'order_id' AS order_id,
       payload->>'job_no' AS job_no,
       (payload->>'taxable_value')::bigint AS taxable_value,
       coalesce((payload->>'discount')::bigint, 0) AS discount,
       coalesce((payload->>'packing')::bigint, 0) AS packing,
       coalesce((payload->>'freight')::bigint, 0) AS freight,
       coalesce((payload->>'insurance')::bigint, 0) AS insurance,
       coalesce((payload->>'cgst')::bigint, 0) AS cgst,
       coalesce((payload->>'sgst')::bigint, 0) AS sgst,
       coalesce((payload->>'igst')::bigint, 0) AS igst,
       coalesce((payload->>'tcs')::bigint, 0) AS tcs,
       coalesce((payload->>'round_off')::bigint, 0) AS round_off,
       (payload->>'gross')::bigint AS gross,
       payload->>'place_of_supply' AS place_of_supply,
       payload->>'customer_gstin' AS customer_gstin,
       payload->>'scheme_id' AS scheme_id,
       payload->>'business_unit' AS business_unit,
       payload->>'irn' AS irn,
       recorded_at, identity_user, payload, reversed_seq
FROM business.v_documents WHERE event_type = 'InvoiceIssued';

CREATE VIEW business.v_gstr1_lines AS
SELECT d.seq, d.aggregate_id AS gstr1_id, d.entity_id,
       d.payload->>'return_period' AS return_period, d.business_date AS filed_on,
       l.ordinality AS line_no,
       l.line->>'invoice_no' AS invoice_no,
       coalesce(l.line->>'doc_type', 'invoice') AS doc_type,
       l.line->>'gstin' AS gstin,
       l.line->>'place_of_supply' AS place_of_supply,
       coalesce((l.line->>'taxable_value')::bigint, 0) AS taxable_value,
       coalesce((l.line->>'cgst')::bigint, 0) AS cgst,
       coalesce((l.line->>'sgst')::bigint, 0) AS sgst,
       coalesce((l.line->>'igst')::bigint, 0) AS igst,
       d.reversed_seq
FROM business.v_documents d
CROSS JOIN LATERAL jsonb_array_elements(d.payload->'lines') WITH ORDINALITY AS l(line, ordinality)
WHERE d.event_type = 'Gstr1Filed';

CREATE VIEW business.v_receipts AS
SELECT seq, aggregate_id AS receipt_id, entity_id, sale_id,
       payload->>'customer_id' AS customer_id, payload->'invoice_ids' AS invoice_ids,
       (payload->>'amount')::bigint AS amount, business_date AS date,
       payload->>'payer_name' AS payer_name, payload->>'payer_account' AS payer_account,
       payload->>'utr' AS utr, recorded_at, payload, reversed_seq
FROM business.v_documents WHERE event_type = 'ReceiptRecorded';

CREATE VIEW business.v_bank_lines AS
SELECT d.seq, d.aggregate_id AS bank_statement_id, d.entity_id,
       d.payload->>'account_no' AS account_no,
       l.ordinality AS line_no,
       (l.line->>'date')::date AS date,
       (l.line->>'amount')::bigint AS amount,
       l.line->>'direction' AS direction,
       l.line->>'counterparty_name' AS counterparty_name,
       l.line->>'counterparty_account' AS counterparty_account,
       l.line->>'utr' AS utr,
       l.line->>'narration' AS narration,
       d.reversed_seq
FROM business.v_documents d
CROSS JOIN LATERAL jsonb_array_elements(d.payload->'lines') WITH ORDINALITY AS l(line, ordinality)
WHERE d.event_type = 'BankStatementImported';

CREATE VIEW business.v_credit_notes AS
SELECT seq, aggregate_id AS credit_note_id, entity_id, sale_id,
       payload->>'credit_note_no' AS credit_note_no, business_date AS date,
       payload->>'invoice_id' AS invoice_id, payload->>'reason' AS reason,
       (payload->>'taxable_value')::bigint AS taxable_value,
       coalesce((payload->>'cgst')::bigint, 0) AS cgst,
       coalesce((payload->>'sgst')::bigint, 0) AS sgst,
       coalesce((payload->>'igst')::bigint, 0) AS igst,
       (payload->>'gross')::bigint AS gross,
       payload->>'approver' AS approver,
       recorded_at, payload, reversed_seq
FROM business.v_documents WHERE event_type = 'CreditNoteIssued';

CREATE VIEW business.v_sales_returns AS
SELECT seq, aggregate_id AS sales_return_id, entity_id, sale_id,
       payload->>'credit_note_id' AS credit_note_id, payload->>'invoice_id' AS invoice_id,
       business_date AS inward_date, payload->>'vehicle_no' AS vehicle_no,
       recorded_at, payload, reversed_seq
FROM business.v_documents WHERE event_type = 'SalesReturnRecorded';

CREATE VIEW business.v_purchase_invoices AS
SELECT seq, aggregate_id AS purchase_invoice_id, entity_id,
       payload->>'vendor_id' AS vendor_id, payload->>'invoice_no' AS invoice_no,
       business_date AS date,
       (payload->>'taxable_value')::bigint AS taxable_value,
       coalesce((payload->>'tax')::bigint, 0) AS tax,
       (payload->>'gross')::bigint AS gross,
       recorded_at, payload, reversed_seq
FROM business.v_documents WHERE event_type = 'PurchaseInvoiceRecorded';

CREATE VIEW business.v_goods_receipts AS
SELECT seq, aggregate_id AS goods_receipt_id, entity_id,
       payload->>'purchase_invoice_id' AS purchase_invoice_id,
       payload->>'vendor_id' AS vendor_id, business_date AS date,
       payload->>'vehicle_no' AS vehicle_no, recorded_at, payload, reversed_seq
FROM business.v_documents WHERE event_type = 'GoodsReceiptRecorded';

CREATE VIEW business.v_payments AS
SELECT seq, aggregate_id AS payment_id, entity_id,
       payload->>'vendor_id' AS vendor_id,
       (payload->>'amount')::bigint AS amount, business_date AS date,
       payload->>'payee_name' AS payee_name, payload->>'payee_account' AS payee_account,
       payload->>'utr' AS utr, recorded_at, payload, reversed_seq
FROM business.v_documents WHERE event_type = 'PaymentMade';

CREATE VIEW business.v_journals AS
SELECT seq, aggregate_id AS journal_id, entity_id, business_date AS date,
       payload->>'narration' AS narration, payload->>'reference' AS reference,
       payload->>'approver' AS approver, recorded_at, identity_user, payload, reversed_seq
FROM business.v_documents WHERE event_type = 'JournalPosted';

CREATE VIEW business.v_register_uploads AS
SELECT seq, aggregate_id AS upload_id, entity_id,
       payload->>'file_hash' AS file_hash, payload->>'file_name' AS file_name,
       (payload->>'period_start')::date AS period_start,
       (payload->>'period_end')::date AS period_end,
       recorded_at, identity_user, payload
FROM business.v_documents WHERE event_type = 'SalesRegisterUploaded';

CREATE VIEW business.v_related_party_lists AS
SELECT seq, aggregate_id AS upload_id, entity_id,
       payload->>'file_hash' AS file_hash, payload->'parties' AS parties,
       recorded_at, identity_user, payload
FROM business.v_documents WHERE event_type = 'RelatedPartyListUploaded';

CREATE VIEW business.v_evidence AS
SELECT seq, aggregate_id AS evidence_id, entity_id,
       payload->>'sample_id' AS sample_id, payload->>'document_type' AS document_type,
       payload->>'file_hash' AS file_hash, payload->>'file_name' AS file_name,
       recorded_at, identity_user
FROM business.v_documents WHERE event_type = 'EvidenceUploaded';

-- Ledger lines with their account names, for trial balances (LG-5).
CREATE VIEW business.v_ledger AS
SELECT p.seq, p.line_no, p.account_code, a.name AS account_name, a.type AS account_type,
       p.debit, p.credit, p.entity_id, p.sale_id, p.source_event_type, p.business_date,
       e.aggregate_id, e.recorded_at, e.identity_user
FROM business.postings p
JOIN business.accounts a ON a.code = p.account_code
JOIN business.events e ON e.seq = p.seq;
