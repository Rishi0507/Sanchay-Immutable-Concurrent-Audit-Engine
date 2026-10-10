// The words of the story page. Plain, specific, and each claim tied to a
// mechanism or a measured result.

import type { LegendItem, Provenance } from "./parts";

export interface ChapterCopy {
  n: string;
  label: string;
  lines: string[];
  body: string;
  legend: LegendItem[];
  note?: string;
  side: "left" | "right";
}

export const chapters: ChapterCopy[] = [
  {
    n: "01",
    label: "The register",
    lines: ["Seven thousand sales.", "The auditor tests thirty."],
    body: "A mid-size manufacturer books 6,000 to 8,000 sales a year. Its statutory auditor checks a few dozen of them, from a spreadsheet the client exported. This system audits the business behind the spreadsheet, and the audit is run by an AI agent that holds an identity and nothing else.",
    legend: [
      { colour: "ice", text: "One column is one invoice. Its height is the invoice value." },
      { colour: "dim", text: "Left to right is the year, April to March. Front to back is one row per customer." },
      { colour: "gold", text: "The gold line in front is the ledger every sale posts to." },
    ],
    side: "left",
  },
  {
    n: "02",
    label: "The problem",
    lines: ["A register is a report.", "It is not the business."],
    body: "The export shows what the client chose to show. It says nothing about what was promised, what physically moved, or what was reversed after year end. Sales booked in the last days of the period are the easiest to inflate, so that is where the pressure builds.",
    legend: [
      { colour: "vermilion", text: "Sales booked in the last three weeks of the period." },
      { colour: "ice", text: "Rising columns are their value surging toward the cut-off date." },
      { colour: "dim", text: "The haze is that pressure. It clears when the period closes." },
    ],
    side: "right",
  },
  {
    n: "03",
    label: "The record",
    lines: ["Every sale leaves", "a trail of documents."],
    body: "Enquiry, order, dispatch, e-way bill, lorry receipt, delivery, invoice, receipt. Each one is recorded as its own event and tied to the sale. A sale that cannot show the whole trail has to be explained.",
    legend: [
      { colour: "ice", text: "One plate is one document. A stack is one sale, built from the bottom in the order things happened." },
      { colour: "frame", text: "An empty frame is a document that should exist and does not." },
      { colour: "vermilion", text: "The fifth stack is an invoice with nothing physical behind it." },
    ],
    side: "left",
  },
  {
    n: "04",
    label: "The ledger",
    lines: ["Nothing is updated.", "Nothing is deleted."],
    body: "Every event is appended to a double-entry ledger and chained to the one before it by its hash. A correction is a new event that reverses the old one, so the history stays in view. One writer orders every append, which is why the chain cannot fork.",
    legend: [
      { colour: "gold", text: "One block is one ledger event." },
      { colour: "gold", text: "Each link is the hash carried in from the block before." },
      { colour: "dim", text: "The moving light is a hash being carried forward." },
    ],
    side: "right",
  },
  {
    n: "05",
    label: "Identity",
    lines: ["The agent holds an identity.", "Nothing more."],
    body: "The whole system is one tool server. A client employee runs the business through it. An auditor reads a frozen snapshot and raises findings. An auditor cannot change business data. That is enforced four times over, and never by a prompt.",
    legend: [
      { colour: "ice", text: "Four frames are four layers: the tool list, the ledger's capability types, the database role, the append-only triggers." },
      { colour: "ice", text: "A client's write passes through all four and joins the chain." },
      { colour: "vermilion", text: "An auditor's write stops at the first frame, and the refusal is logged." },
    ],
    side: "left",
  },
  {
    n: "06",
    label: "Detection",
    lines: ["What the paperwork", "was hiding."],
    body: "Detectors read every sale, not a sample. Each is a rule a person can read, and each hit carries the exact events and documents behind it. No language model decides what is a finding.",
    legend: [
      { colour: "vermilion", text: "An invoice a detector flagged." },
      { colour: "violet", text: "A related party. One of the two rows was never disclosed." },
      { colour: "dim", text: "Dimmed columns raised nothing." },
    ],
    note: "Move the pointer over a column to see the invoice.",
    side: "right",
  },
  {
    n: "07",
    label: "Sampling",
    lines: ["Thirty samples,", "each with a reason."],
    body: "The largest items, related parties and detector hits are taken first. The rest are drawn by value, from a seed. The same seed and the same snapshot always give the same thirty, so a reviewer can reproduce the selection exactly.",
    legend: [
      { colour: "gold", text: "A raised gold column is a selected sample." },
      { colour: "vermilion", text: "Flagged invoices that were not selected stay marked." },
    ],
    note: "Move the pointer over a gold column to see why it was chosen.",
    side: "left",
  },
  {
    n: "08",
    label: "Proof",
    lines: ["Do not take", "our word for it."],
    body: "Two things you can check yourself. Break a hash chain in your own browser and watch verification fail. Then ask this deployment to recompute its real ledger.",
    legend: [
      { colour: "gold", text: "The chain behind this panel follows the table below." },
      { colour: "vermilion", text: "Change an amount and the block you altered, and every block after it, turns." },
    ],
    side: "right",
  },
];

export const closing = {
  lines: ["Audit the business,", "not the spreadsheet."],
  body: "Sign in as the client to record a sale, as the auditor to run the audit, or as the audit manager to confirm what it found.",
};

export interface Stat {
  value: number | "ledger" | "trail";
  suffix?: string;
  source: Provenance;
  text: string;
}

export const stats: Stat[] = [
  { value: "ledger", source: "Live", text: "events in this ledger, every hash recomputed a moment ago" },
  { value: 72, suffix: " of 72", source: "Measured", text: "end-to-end checks passing in the recorded run of 10 October 2026" },
  { value: 4, source: "Tested", text: "independent layers between an auditor identity and a write" },
  { value: 16, source: "Specified", text: "detectors, one for each irregularity in the problem statement" },
];

export const provenanceKey: { kind: Provenance; text: string }[] = [
  { kind: "Live", text: "Read from this deployment now" },
  { kind: "Measured", text: "Result of a recorded test run" },
  { kind: "Specified", text: "In the design, not yet measured" },
  { kind: "Illustrative", text: "Made up to explain" },
];

export const claims = ["An auditor identity cannot write", "Every difference is a finding, never a cleaning step", "Same seed, same snapshot, same samples", "A human confirms every conclusion", "Nothing is updated, nothing is deleted"];

export interface Detector {
  id: string;
  name: string;
  how: string;
  catches: string;
  limit: string;
}

export const detectors: Detector[] = [
  { id: "D-01", name: "Register reconciliation", how: "Compares every register row with the invoice in the system of record, field by field, and the register total with the ledger.", catches: "Rows that were dropped, added or changed in the export.", limit: "It trusts the system of record. If both were falsified the same way, it sees nothing." },
  { id: "D-02", name: "Undisclosed related parties", how: "Links customers that share a PAN, a director, a bank account, a phone, an email or an address, then clusters them.", catches: "A customer controlled by the company's own people that was left off the disclosed list.", limit: "A link through an identifier the system never recorded cannot be found." },
  { id: "D-03", name: "Mid-period relationships", how: "Every link carries the date it began. Sales are split before and after it.", catches: "A party that became related partway through the year.", limit: "It relies on the effective dates the client recorded." },
  { id: "D-04", name: "Circular trading", how: "Builds a graph of goods and money between resolved parties and lists the closed loops.", catches: "Sales that return as purchases through connected parties.", limit: "A leg of the loop that runs outside the company's books is invisible." },
  { id: "D-05", name: "No physical movement", how: "For each invoice, requires a dispatch, a lorry receipt and a delivery, and an e-way bill above the legal threshold.", catches: "Turnover with nothing moved behind it.", limit: "A complete set of forged movement records passes here. Evidence testing is the second line." },
  { id: "D-06", name: "Cut-off", how: "Dates revenue by transfer of control: dispatch for ex-works terms, delivery for delivered terms.", catches: "Sales booked in one period and delivered in the next.", limit: "It needs the delivery terms on the order to be right." },
  { id: "D-07", name: "Period-end concentration", how: "Compares sales and discounts in the last ten days with the rest of the period.", catches: "Stuffing the channel before year end.", limit: "A business with a real seasonal peak at year end will be flagged and must be explained." },
  { id: "D-08", name: "Statutory mismatch", how: "Agrees invoice, e-way bill and GSTR-1 on value, GSTIN, place of supply and tax type.", catches: "A sale reported one way to the buyer and another to the tax authority.", limit: "It reads the filings recorded in the system, not the government portal." },
  { id: "D-09", name: "Revenue not from a sale", how: "Lists every credit to Sales that was not posted by an invoice.", catches: "Revenue created by a manual journal.", limit: "None within the ledger: every posting names what posted it." },
  { id: "D-10", name: "Suspect evidence", how: "Agrees each uploaded document to the records and to the other documents, and looks for reused files and document numbers.", catches: "Evidence that is forged or belongs to another sale.", limit: "Reading a scan is uncertain. Low confidence goes to a person and never passes on its own." },
  { id: "D-11", name: "Credit notes", how: "Tests credit notes issued after the period end against invoices inside it, and looks for the goods coming back.", catches: "Revenue recognised at year end and reversed afterwards.", limit: "A credit note issued after the audit closes is outside its view." },
  { id: "D-12", name: "Promotions", how: "Checks each discount against the scheme, its rate, its dates and the customers it covers.", catches: "Discounts given outside an approved scheme.", limit: "It cannot judge whether the scheme itself was commercially sensible." },
  { id: "D-13", name: "Settlement", how: "Matches receipts to bank lines and to the account that paid.", catches: "Payment from a third party, or money that comes in and goes straight back out.", limit: "It sees the company's own bank statement only." },
  { id: "D-14", name: "Document integrity", how: "Looks for gaps and repeats in invoice numbers, backdated entries, and one vehicle in two places.", catches: "Paperwork that looks complete and is not.", limit: "A clean number series proves order, not truth." },
  { id: "D-15", name: "Changes after testing", how: "Reads every event after the snapshot and matches it to the samples.", catches: "A client change made once it knew what was being tested.", limit: "None within the system: nothing can change without an event." },
  { id: "D-16", name: "Ledger integrity", how: "Recomputes every hash in the ledger and the audit trail.", catches: "A stored record altered outside the system.", limit: "It proves a record was not changed after entry. It does not prove the record was true when entered." },
];

export interface Handling {
  scenario: string;
  happens: string;
  result: string;
  tone: "refused" | "accepted" | "caught";
}

export const handling: Handling[] = [
  { scenario: "An auditor agent calls a tool that writes", happens: "Refused at the tool layer. The attempt is written to the audit trail.", result: "PERMISSION_DENIED", tone: "refused" },
  { scenario: "An auditor identity reaches the ledger directly", happens: "No write capability can be built for that role.", result: "NOT_PERMITTED", tone: "refused" },
  { scenario: "An agent retries the same call", happens: "The first result is returned. Nothing is appended twice.", result: "duplicate: true", tone: "accepted" },
  { scenario: "Forty writers append at once", happens: "One sequencer orders them.", result: "40 in sequence, no fork", tone: "accepted" },
  { scenario: "An invoice whose total does not foot", happens: "The posting cannot be constructed.", result: "UNBALANCED_POSTING", tone: "refused" },
  { scenario: "An invoice with no dispatch behind it", happens: "Accepted. Finding it is the audit's job.", result: "Finding: no movement", tone: "caught" },
  { scenario: "A credit note issued after testing began", happens: "Invisible to the tests. Found by the change check.", result: "Traced to the sample", tone: "caught" },
  { scenario: "A stored record edited in the database", happens: "Recomputing the chain fails at that record.", result: "First altered record named", tone: "caught" },
  { scenario: "An agent calls the steps out of order", happens: "The missing step is run, or the error names the next one.", result: "next_step", tone: "accepted" },
];

export const weClaim = [
  "An auditor identity cannot change business data. Four layers enforce it, and the test run attacks each one.",
  "Every tool call by every identity is logged and chained, including the refused ones.",
  "Any client change after the snapshot is found and traced to the samples it touches.",
  "A sample selection can be reproduced exactly from its seed and snapshot.",
];

export const weDoNotClaim = [
  "That a finding is a fraud. A finding is a question, and a human auditor confirms or rejects each one.",
  "That an unaltered record was true when it was entered. The chain proves it was not changed afterwards.",
  "That untested sales are clean. Sampling tests a few dozen of thousands.",
  "That a machine reads every document correctly. A scan it is unsure of goes to a person.",
  "An audit opinion. That stays with the engagement partner.",
];

export const buildStatus = "Today the ledger, the tool server and this interface are built and tested. The detection engine is specified and in build, so detection and sampling are shown here with illustrative data.";

export const disclosure = "The scene uses illustrative data. A finding is not a conclusion until an auditor confirms it. This system supports the auditor's opinion and does not give one.";
