"""What the assistant knows that is not a record of one engagement.

These passages say what each check looks for and how the safeguards work, in
the words of the README. They are searched together with the records of the
engagement, so "what is circular trading" and "which invoices are circular"
are answered from the same place.
"""

from __future__ import annotations

# Other words people use for an area of the audit. They are searched and never shown.
AREA_TERMS = {
    "D-01": "register mismatch reconciliation difference", "D-02": "undisclosed hidden related party not disclosed",
    "D-03": "mid period related party late disclosure", "D-04": "circular round tripping roundtrip cycle",
    "D-05": "no movement missing dispatch delivery fictitious sale", "D-06": "cutoff cut off wrong period",
    "D-07": "period end year end spike concentration", "D-08": "gst gstr-1 gstin tax mismatch",
    "D-09": "journal entry manual revenue non sale", "D-10": "forged fake tampered altered doctored document evidence",
    "D-11": "credit note return", "D-12": "discount promotion scheme", "D-13": "receipt payment settlement bank",
    "D-14": "backdated duplicate gap series vehicle", "D-15": "changed after snapshot post testing",
    "D-16": "hash chain tamper ledger",
}

# (key, title, text, screen that shows it or "")
GUIDE: list[tuple[str, str, str, str]] = [
    ("D-01", "What the register check looks for",
     "Register differences (D-01): a row of the client's sales register that differs from the system of record. "
     "A changed field, a row not in the system, a missing row, a duplicate, a row that does not foot, or a reversed "
     "invoice still listed.", "register"),
    ("D-02", "What an undisclosed related party is",
     "Undisclosed related parties (D-02): a customer linked to an officer or to a disclosed party through the same PAN, "
     "a shared director, bank account, phone, email or address, or a receipt paid from that party's account, and "
     "missing from the client's related-party list. Strong, medium and weak signals combine into a link.", "graph"),
    ("D-03", "What a related party from mid-period is",
     "Related parties from mid-period (D-03): a related party whose link begins partway through the period, or "
     "earlier than the client disclosed.", "graph"),
    ("D-04", "What circular trading is",
     "Circular trading (D-04), also called round tripping: goods or money that return to the company through a cycle "
     "of counterparties. The paperwork of each sale can be complete, so the cycle is found on the counterparty graph "
     "and not on any single invoice.", "graph"),
    ("D-05", "What a sale with no physical movement is",
     "No physical movement (D-05): an invoice with no dispatch, transport or delivery behind it, or with no e-way bill "
     "where the consignment value requires one.", "findings"),
    ("D-06", "What cut-off means",
     "Cut-off (D-06): revenue recognised in one period when control of the goods passed in another, in either "
     "direction. Control passes on dispatch for ex-works terms and on delivery for delivered terms.", "samples"),
    ("D-07", "What period-end concentration is",
     "Period-end concentration (D-07): sales or discounts in the last 10 days of the period far above the baseline of "
     "the period.", "findings"),
    ("D-08", "What the statutory document check looks for",
     "Statutory documents and tax filings (D-08): an invoice, e-way bill and GSTR-1 line that disagree, an invalid "
     "GSTIN, or the wrong tax type for the place of supply.", "findings"),
    ("D-09", "What revenue not from a sale is",
     "Revenue not from a sale (D-09): a credit to the revenue account that did not come from an invoice, for example a "
     "journal entry posted straight to sales.", "findings"),
    ("D-10", "What suspect evidence is",
     "Suspect evidence (D-10): a document the client uploaded that failed an evidence check. Forged, altered, fake or "
     "tampered documents are reported here.", "samples"),
    ("D-11", "What the credit note check looks for",
     "Credit notes (D-11): a credit note issued after the period end against an invoice in the period, with no goods "
     "returned, with no approver, or to a related party.", "samples"),
    ("D-12", "What the promotion check looks for",
     "Promotions and discounts (D-12): a discount with no scheme behind it, above the scheme rate, outside the scheme "
     "dates, or given to a customer who is not eligible.", "findings"),
    ("D-13", "What the settlement check looks for",
     "Settlement (D-13): a receipt with no bank line, a receipt paid from an account that is not the customer's, or a "
     "receipt followed by a payment to a linked party.", "findings"),
    ("D-14", "What document integrity means",
     "Document integrity (D-14): gaps and duplicates in a number series, backdated entries, one transport document used "
     "twice, or a vehicle on overlapping trips.", "findings"),
    ("D-15", "What a change after testing began is",
     "Changes after testing began (D-15): the engagement reads a frozen snapshot of the client's records. Any client "
     "event recorded after it that touches a sample is a finding: a reversal, a credit note, a customer change, a "
     "journal, a backdated document, replaced evidence or a register uploaded again.", "findings"),
    ("D-16", "What ledger integrity means",
     "Ledger integrity (D-16): every record is chained to the one before by a SHA-256 hash, so changing a stored record "
     "breaks every later hash. The check recomputes both chains and compares the snapshot hash with the one stored "
     "when the engagement opened.", "trail"),
    ("severity", "How severity is decided",
     "Severity is High for a finding that involves a related party, and for circular trading, revenue not from a sale, "
     "suspect evidence, a change after testing began and a break in the ledger. Otherwise it follows the amount: High "
     "from 1 percent of period revenue, Medium from 0.1 percent, and Low below that. No model decides severity.",
     "findings"),
    ("sampling", "How samples are chosen",
     "Samples are chosen by rule, with no model. Sales TOD: 30 samples by default, the 5 largest by value, up to 10 "
     "related-party sales, detector hits, the 10 largest customers, then value-weighted sampling across quarters and "
     "business units. Sales Cut-off TOD: the last 10 invoices on or before the period end and the first 15 after it. "
     "Credit Note TOD: credit notes after the period end against invoices in the period first, to a total of 20. The "
     "same seed and snapshot always give the same samples.", "samples"),
    ("seed", "Why nobody can choose the samples",
     "Sealed sampling seed: when the register arrives the system draws a secret and gives the client only its hash. "
     "The seed is computed from that secret and the frozen ledger, so the auditor cannot pick the samples or draw "
     "again, and the client cannot predict them.", "overview"),
    ("control", "What a control request is",
     "Control requests, also called trap requests: among the ordinary evidence requests, up to three ask the client "
     "for a document that should not exist. A client who answers that there is no such document passes. A client who "
     "supplies a file has made a document for the request, and that is a High finding.", "samples"),
    ("evidence", "How evidence is tested",
     "Evidence checks: each uploaded document is agreed to the system of record and to the other documents of the "
     "sample. The checks find a wrong number, date, customer, GSTIN or amount, documents that disagree with each "
     "other, a file reused for another sample, an e-way bill that does not cover the journey, a delivery too fast for "
     "the distance, a PDF created after the request, and evidence replaced after verification. A document that cannot "
     "be read with confidence marks the sample Needs human review.", "samples"),
    ("languages", "Documents in Hindi and Marathi",
     "An invoice, lorry receipt, credit note or goods return note written in Hindi or Marathi is read with the same "
     "rules as an English one. Each label is matched to a dictionary of Hindi and Marathi wordings and the same "
     "checks run. A label that cannot be placed is not guessed: the sample goes to a person.", "samples"),
    ("decision", "Who decides a finding",
     "Findings are raised by the engine as proposed. Only the audit manager can confirm or reject one. The auditing "
     "agent cannot confirm its own conclusions, and an engagement cannot be signed off while a finding has no "
     "decision.", "findings"),
    ("readonly", "What the audit side can change",
     "The audit side reads the client's records and cannot change them. Every tool call, including denied and failed "
     "ones, is written to a tamper-evident audit trail with the caller and the time.", "trail"),
]
