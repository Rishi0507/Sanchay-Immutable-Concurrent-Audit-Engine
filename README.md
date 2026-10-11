<p align="center"><img src="docs/logo.png" alt="Sanchay" width="240"></p>

# Sanchay

AI-run statutory revenue audit. Team ELEV05, Elevate 1.0, problem statement 04.

A statutory auditor of a mid-size manufacturer usually receives a sales register exported to a spreadsheet, tests a few dozen of 6,000 to 8,000 sales, and collects the supporting documents by email. This project builds the system of record behind those sales and audits that instead. Every step of a sale is an event in an append-only, hash-chained double-entry ledger. The whole system is exposed as a Model Context Protocol (MCP) server, so that an AI agent holding only an identity can run the business as a client employee or audit it as an independent auditor, with exactly the permissions of that identity.

The full specification is in [docs/PRD.md](docs/PRD.md).

## Quick start

```sh
docker compose -f deploy/docker-compose.yml up --build
```

Open http://localhost:5173. The front page tells the whole system as one story, and its Lens audits the demo register in the browser with nothing else loaded. To run the full audit on data, [load the demo business](#load-the-demo-business) and sign in as the auditor.

## Contents

- [Quick start](#quick-start)
- [What is built](#what-is-built)
- [Architecture](#architecture)
- [The life of a sale](#the-life-of-a-sale)
- [The ledger](#the-ledger)
- [Identities and permissions](#identities-and-permissions)
- [The audit](#the-audit)
- [Safeguards](#safeguards)
- [Outputs](#outputs)
- [The audit assistant](#the-audit-assistant)
- [User interface](#user-interface)
- [Tools](#tools)
- [Run with Docker](#run-with-docker)
- [Load the demo business](#load-the-demo-business)
- [Run without Docker](#run-without-docker)
- [Connect an agent](#connect-an-agent)
- [Run the auditor agent](#run-the-auditor-agent)
- [Where a model is used](#where-a-model-is-used)
- [Configuration](#configuration)
- [Tests and measured results](#tests-and-measured-results)
- [Repository conventions](#repository-conventions)

## What is built

| Area | Contents |
|---|---|
| System of record | 27 event types that cover the commercial life of a sale: enquiry, order, price and promotion, dispatch, e-way bill, lorry receipt, delivery, invoice, GSTR-1 filing, receipt and bank statement, with credit notes, sales returns, reversals, purchases, payments and journals. |
| Ledger | Double-entry postings for every event that has a financial effect. Append-only, hash-chained, with a Merkle root per day and a proof for any single record. |
| Access | Three roles, four client departments, and four independent layers that stop an auditor identity from changing business data. |
| Audit | Register reconciliation, related-party identification, 16 detectors, three test-of-details sheets, nine evidence checks, and findings that carry their lineage and a proposed adjusting entry. |
| Safeguards | A sampling seed that nobody chooses, requests for documents that should not exist, detection of client changes after testing begins, and verification of the ledger. |
| Outputs | The workpaper, the findings memo, a one-page summary report and a tamper-evident audit trail. |
| Assistant | Questions in English, Hindi or Marathi, answered only from the records of the engagement. Each statement names its source, and a figure that is not in the records is withheld. |
| Agent operation | Every capability is an MCP tool. The interface calls the same tools. An auditor agent is included. |
| Interface | A front page that tells the whole system as one 3D story, the Lens that audits any register in the browser, and pages printed like a banknote in the stone grey of the ₹500 note. |

## Architecture

```mermaid
flowchart LR
    subgraph Callers
        CA[Client employee or agent]
        AA[Auditor agent]
        HU[Audit manager]
    end

    UI[User interface<br/>React, port 5173]
    MCP[MCP server and HTTP gateway<br/>Go, port 8080]
    LC[Ledger core<br/>OCaml, port 7001]
    ENG[Audit engine<br/>Python, port 7002]
    DB[(Postgres<br/>business, trail, audit)]
    OBJ[(File store<br/>files by SHA-256)]
    LLM[Optional model<br/>local or hosted]

    CA -->|MCP| MCP
    AA -->|MCP| MCP
    HU --> UI
    UI -->|the same tools over HTTP| MCP
    MCP -->|append, verify, trail| LC
    MCP -->|audit operations| ENG
    MCP -->|read only| DB
    LC -->|only writer of business and trail| DB
    ENG -->|reads business, writes audit| DB
    ENG --> OBJ
    MCP --> OBJ
    ENG -.-> LLM
```

| Service | Path | Language | Port | Database role | Responsibility |
|---|---|---|---|---|---|
| Ledger core | `ledger/` | OCaml 5 | 7001 | `ledger_rw` | The only writer of the business chain and the trail chain. Validates postings, sequences appends, verifies the chains. |
| Audit engine | `engine/` | Python | 7002 | `engine_audit` | Reads the frozen snapshot and writes the `audit` schema. Reconciliation, detectors, sampling, evidence, findings, outputs. |
| MCP server | `mcp/` | Go | 8080 | `mcp_read` | The single entry point. Serves MCP at `/mcp` and the same handlers at `/api` for the interface. |
| User interface | `ui/` | React, Tailwind | 5173 | none | Client and auditor views. It has no path into the system other than the tools. |
| Auditor agent | `agent/` | Python | none | none | A model that runs the audit through the MCP tools. |
| Data generator | `datagen/` | Python | none | none | A synthetic manufacturer with planted irregularities, an answer key and a client simulator. |
| Database | `db/` | SQL | 5432 | | Schemas, roles and append-only triggers. |
| Contracts | `contracts/` | JSON, Markdown | | | Event catalogue, engine API, ledger API and finding schema shared by every component. |
| Deployment | `deploy/` | YAML, Python | | | Docker Compose and the end-to-end check. |

Design rules that hold throughout:

| Rule | Meaning |
|---|---|
| One entry point | The interface and every agent call the same tools. One place checks permission, validates input, writes the audit trail and raises notifications. |
| Deterministic core | No model call decides a finding, a sample or a figure. The same seed and snapshot give the same samples and the same workpaper. |
| Nothing is edited | State is derived from events. A correction is a new event or a reversal, never an update. |
| Integer money | Amounts are stored as integer paise and shown as rupees at the tool boundary. |

## The life of a sale

Deciding what must exist to prove that a sale really happened is part of the problem. The system records each step as its own event, and each step belongs to one department of the client.

```mermaid
flowchart LR
    subgraph Sales
        EQ[Enquiry] --> SO[Sales order]
    end
    subgraph Dispatch
        DS[Dispatch] --> EW[E-way bill]
        DS --> LR[Lorry receipt]
        DS --> DL[Delivery]
    end
    subgraph Accounts
        IN[Invoice] --> GS[GSTR-1 line]
        IN --> RC[Receipt]
        RC --> BK[Bank statement line]
    end
    SO --> DS
    DL --> IN
```

| Step | Tool | Department | Posts to the ledger |
|---|---|---|---|
| Customer, price, promotion | `create_customer`, `set_price`, `create_promotion` | Sales | No |
| Enquiry and order | `record_enquiry`, `create_sales_order` | Sales | No |
| Goods leave | `record_dispatch`, `generate_eway_bill`, `record_lr` | Dispatch | No |
| Goods arrive | `record_delivery` | Dispatch | No |
| Revenue and tax | `issue_invoice`, `file_gstr1` | Accounts | Invoice: receivable against sales and output tax |
| Cash | `record_receipt`, `import_bank_statement` | Accounts | Receipt: bank against receivable |
| After the sale | `issue_credit_note`, `reverse_document` | Accounts | Yes |
| Goods come back | `record_sales_return` | Dispatch | No |
| Purchases | `record_purchase_invoice`, `record_payment` | Accounts | Yes |
| Other entries | `post_journal` | Accounts | Yes |

Events of one sale share a `sale_id`, so `get_sale_chain` shows every stage of a sale and which stages are missing.

## The ledger

```mermaid
flowchart LR
    G[Genesis<br/>64 zero characters] --> E1[Event 1<br/>hash 1]
    E1 --> E2[Event 2<br/>hash 2]
    E2 --> E3[Event n<br/>hash n]
    E1 -.-> M[Merkle root<br/>of the day]
    E2 -.-> M
    E3 -.-> M
```

| Property | How it is achieved |
|---|---|
| Hash chain | `hash_n = SHA256(prev_hash || canonical_json(content_n))`. The content includes the event, its postings, the identity and the record time. Changing any stored record breaks every later hash. |
| Canonical form | Object keys sorted by byte order, no whitespace, integers without a fraction. The ledger core and the audit engine produce the same bytes, checked against the shared vectors in `contracts/events/chain-vectors.json`. |
| Balanced postings | An event that posts must balance. An unbalanced invoice is refused with `UNBALANCED_POSTING`. |
| Single writer | One sequencer assigns sequence numbers. Parallel appends never fork the chain. |
| Idempotency | Every write carries an `idempotency_key`. A repeated call returns the first result and appends nothing. |
| Versions | An update names the version it read. A stale version is refused with `VERSION_CONFLICT`. |
| Reversal | A document is reversed by a new event with mirror postings. The original stays. |
| Merkle proofs | `get_merkle_proof` proves that one event belongs to its day's root without recomputing the chain. |
| Audit trail | Every tool call, including denied and failed calls, is an entry in a second hash chain with the caller, the tool and hashes of the arguments and the result. |
| Verification | The chain is split into segments and verified in parallel across OCaml domains. |

## Identities and permissions

An identity is a bearer token. Each token maps to one user and one role, and the server reads the role from the token, never from tool arguments. The defaults below are for demonstration and are set in `deploy/.env.example`.

| Role | Token | Tools | Can |
|---|---|---|---|
| `client_employee` | `client-demo-token` | 36 | Record business events, upload the register and evidence |
| `auditor` | `auditor-demo-token` | 34 | Read the snapshot, sample, test, raise findings, export |
| `audit_manager` | `manager-demo-token` | 36 | Everything an auditor can, plus confirm findings and sign off |

### An auditor cannot change the business

The restriction holds at four layers. Each is sufficient on its own, so a failure in one does not grant access.

```mermaid
flowchart TB
    A[An auditor identity tries to change business data]
    A --> L1{L1 Tool list}
    L1 -->|write tools are not listed and a call is refused| X1[PERMISSION_DENIED]
    L1 -.->|if this layer failed| L2{L2 Ledger capability}
    L2 -->|the auditor handle type has no append function| X2[NOT_PERMITTED]
    L2 -.->|if this layer failed| L3{L3 Database role}
    L3 -->|the engine and server roles cannot write the business schema| X3[Refused by Postgres]
    L3 -.->|if this layer failed| L4{L4 Append-only triggers}
    L4 -->|UPDATE and DELETE raise on every table| X4[Refused by trigger]
```

| Layer | Mechanism | Where |
|---|---|---|
| L1 Tool visibility | The server lists only the tools of the caller. A call to any other tool returns `PERMISSION_DENIED` and is still written to the audit trail. | `mcp/` |
| L2 Ledger capability | The ledger core issues a write capability only for a `client_employee` request. The auditor handle has no append function, so the code cannot be written. | `ledger/lib/capability.mli` |
| L3 Database role | The engine connects as `engine_audit` and the server as `mcp_read`. Neither can write the `business` schema. | `db/migrations/006_roles.sql` |
| L4 Append-only triggers | `UPDATE` and `DELETE` raise an error on every table of every schema. | `db/migrations/` |

### Client departments

A `client_employee` identity can belong to a department. It then lists and can call only the tools of that department, so that no single department can take an order, ship it, bill it and collect on it. Every department can read records. The server enforces the rule for the interface and for agents alike.

| Department | Token | Tools | Owns |
|---|---|---|---|
| Sales | `sales-demo-token` | 13 | Customers, prices, promotions, enquiries, sales orders |
| Dispatch | `dispatch-demo-token` | 14 | Dispatches, e-way bills, lorry receipts, deliveries, goods returned or received, transport evidence |
| Accounts | `accounts-demo-token` | 20 | Invoices, tax filings, receipts, bank statements, credit notes, reversals, purchases, payments, journals, the register upload, evidence |
| Admin | `admin-demo-token` | 15 | Vendors, company officers, the related-party list, the register upload, evidence |

A refused call names the department that owns the step:

```json
{
  "code": "PERMISSION_DENIED",
  "message": "The sales department may not call issue_invoice. It belongs to: accounts.",
  "next_step": "Hand this step to a colleague in that department, or use a tool listed for your own. Call get_access_policy to see who may do what."
}
```

`client-demo-token` belongs to no department and is not restricted. The data generator uses it to load the business. The split is defined in `mcp/internal/tools/departments.go`, a test fails if a new write tool has no owner, and `get_access_policy` returns the split to any caller. In `IDENTITIES_FILE`, add `"department"` to an identity to place it in one. The ledger records the user name on every event, so each step of a sale carries the person who performed it.

## The audit

```mermaid
sequenceDiagram
    actor C as Client
    actor A as Auditor or agent
    participant S as System
    actor M as Audit manager

    C->>S: upload_sales_register and upload_related_parties
    S-->>C: sampling_commitment
    A->>S: open_engagement
    S-->>A: snapshot frozen, seed derived
    A->>S: import_register, reconcile_register, tag_related_parties
    A->>S: run_detectors
    A->>S: select_sales_tod, select_cutoff_tod, select_credit_note_tod
    S-->>C: evidence requests
    C->>S: upload_evidence with a file or with not_available
    A->>S: verify_evidence
    A->>S: check_post_testing_changes and verify_ledger_integrity
    A->>S: draft_findings_memo, export_workpaper, export_summary_report
    M->>S: confirm_finding for each finding
    M->>S: sign_off_engagement
```

### The plan

`get_audit_plan` returns these steps in order with the next tool to call. A tool called out of order runs the missing deterministic steps itself, and every error names the next step to take.

| Step | Tool | What it does |
|---|---|---|
| 1 | `open_engagement` | Freezes a snapshot of the client's records at the current ledger position. Later client changes are invisible to testing. |
| 2 | `import_register` | Carries the client's register into the workpaper exactly as provided. |
| 3 | `reconcile_register` | Compares every register row with the system of record. Every difference is a finding. |
| 4 | `tag_related_parties` | Marks each customer as related or non-related, and suggests undisclosed related parties from shared identifiers. |
| 5 | `run_detectors` | Runs the population-level detectors over the snapshot. |
| 6 | `select_sales_tod` | Selects 25 to 35 risk-weighted sales samples and requests their documents. |
| 7 | `select_cutoff_tod` | Selects the last 10 invoices before the period end and the first 15 after it. |
| 8 | `select_credit_note_tod` | Selects credit notes, with those issued after the period end first. |
| 9 | `verify_evidence` | Tests the uploaded documents against the records and against each other. |
| 10 | `check_post_testing_changes` | Traces every client change made after the snapshot to the samples it touches. |
| 11 | `verify_ledger_integrity` | Recomputes both hash chains and compares the snapshot hash with the one stored at opening. |
| 12 | `draft_findings_memo` | Produces the findings memo. |
| 13 | `export_workpaper` | Produces the workpaper. |

### Detectors

Each detector is a rule family in code, not a single pattern. Thresholds are in `engine/audit_engine/thresholds.toml` and are written to the Parameters sheet of the workpaper.

| Rule | Area | Reports |
|---|---|---|
| D-01 | Register differences | A register row that differs from the system of record: a changed field, a row not in the system, a missing row, a duplicate, a row that does not foot, a reversed invoice still listed. |
| D-02 | Undisclosed related parties | A customer linked to an officer or a disclosed party through the same PAN, a shared director, bank account, phone, email or address, or a receipt paid from that party's account. Strong, medium and weak signals combine into a link. |
| D-03 | Related parties from mid-period | A related party whose link begins partway through the period, or earlier than disclosed. |
| D-04 | Circular trading | Goods or money that return to the company through a cycle of counterparties. |
| D-05 | No physical movement | An invoice with no dispatch, transport or delivery, or with a missing e-way bill where one is required. |
| D-06 | Cut-off | Revenue recognised in one period when control passed in another, in either direction. |
| D-07 | Period-end concentration | Sales or discounts in the last 10 days far above the baseline of the period. |
| D-08 | Statutory documents and tax filings | Invoice, e-way bill and GSTR-1 that disagree, an invalid GSTIN, or the wrong tax type for the place of supply. |
| D-09 | Revenue not from a sale | A credit to revenue that did not originate from an invoice. |
| D-10 | Suspect evidence | A failed evidence check (see below). |
| D-11 | Credit notes | A credit note after the period end against an in-period invoice, with no return, with no approver, or to a related party. |
| D-12 | Promotions and discounts | A discount with no scheme, above the scheme rate, outside its dates, or to an ineligible customer. |
| D-13 | Settlement | A receipt with no bank line, paid from an account that is not the customer's, or followed by a payment to a linked party. |
| D-14 | Document integrity | Gaps and duplicates in a number series, backdated entries, one transport document used twice, a vehicle on overlapping trips. |
| D-15 | Changes after testing began | A client event after the snapshot that touches a sample. |
| D-16 | Ledger integrity | A break in either chain, or a snapshot that no longer matches. |

Severity is High for a finding that involves a related party, and for circular trading, revenue not from a sale, suspect evidence, a change after testing began and a break in the ledger. Otherwise it follows the amount: High from 1 percent of period revenue, Medium from 0.1 percent, and Low below that.

### Sampling

| Sheet | Selection |
|---|---|
| Sales TOD | 30 samples by default, within 25 to 35: the 5 largest by value, up to 10 related-party sales, detector hits, the 10 largest customers, then value-weighted sampling across quarters and business units. At least 8 distinct customers. |
| Sales Cut-off TOD | The last 10 invoices on or before the period end and the first 15 after it, each tested against its dispatch or delivery date and its accounting entry. |
| Credit Note TOD | Every credit note dated after the period end against an in-period invoice, up to 15, then value-weighted to a total of 20. |

Each sample stores the reason it was selected. Selection uses no model call and no clock value, so the same seed and snapshot always give the same samples in the same order.

### Evidence checks

Sample selection sends the client a request for each document. The client answers each request with a file, or with a statement that no such document exists.

| Check | Detects |
|---|---|
| E-1 | A document whose number, date, customer, GSTIN or amount differs from the system of record |
| E-2 | Invoice, e-way bill and lorry receipt that disagree with each other |
| E-3 | A file, or a near-identical scan, already used for another sample |
| E-4 | A document number that belongs to a different invoice |
| E-5 | An e-way bill whose validity does not cover the journey |
| E-6 | A delivery too fast for the stated distance |
| E-7 | A PDF created after the request, or produced by an editing tool |
| E-8 | Evidence replaced after it had been verified |
| E-9 | A document supplied although the system of record holds none for the transaction |

Fields are read from text PDFs directly and from scans by OCR, with Tesseract, which the engine's Docker image includes. A field read with low confidence, or a scan that cannot be read, marks the sample `Needs human review`. It never passes silently.

### Documents in Hindi and Marathi

A client's own papers are often not in English. An invoice, a lorry receipt, a credit note or a goods return note written in Hindi or Marathi is read with the same schema and tested with the same nine checks.

```mermaid
flowchart LR
    D[Document in Devanagari] --> C[Digits to ASCII<br/>plain spaces and hyphens]
    C --> M{Label matches a known<br/>Hindi or Marathi wording?}
    M -->|yes| E[Label rewritten in English] --> P[Same pattern rules<br/>same checks E-1 to E-9]
    M -->|no| R[Field left empty] --> H[Needs human review]
```

The text layer of a Devanagari PDF is rarely exact: conjunct letters come back as stray symbols and vowel signs drift. A label is therefore compared with a dictionary of Hindi and Marathi wordings by its consonants only, and the kind of value on the line (a date, a GSTIN, an amount, a vehicle number) narrows which label it can be. Document numbers, GSTINs, names and amounts are left exactly as written. A label that cannot be placed is not guessed: its field stays empty and the sample goes to a person.

The sample panel shows the language its documents were read in, and the summary report counts them. E-way bills come from the government portal and stay in English.

### Findings and the human decision

A finding carries its severity, its amount, its effect on the period, a proposed adjusting entry, references to the Standards on Auditing, and its lineage: the rule, the ledger events, the documents and the evidence files it rests on. `explain_finding` returns a plain-language reason that needs no model.

```mermaid
stateDiagram-v2
    [*] --> proposed: raised by the engine
    proposed --> confirmed: audit manager
    proposed --> rejected: audit manager
    proposed --> needs_info: audit manager
    needs_info --> confirmed: audit manager
    needs_info --> rejected: audit manager
    confirmed --> [*]
    rejected --> [*]
```

Only the `audit_manager` role can decide a finding. The auditing agent cannot confirm its own conclusions, and an engagement cannot be signed off while a finding has no decision.

## Safeguards

### Sealed sampling seed

A seed that someone picks can be picked again. An auditor, or an agent acting as one, could open engagements until the samples happen to miss the problem invoices. Here nobody chooses the seed.

```mermaid
sequenceDiagram
    participant C as Client
    participant G as MCP server
    participant E as Audit engine
    participant A as Auditor

    C->>G: upload_sales_register
    G->>E: seal the seed for this upload
    Note over E: draws a secret and keeps it
    E-->>G: commitment, the SHA-256 of the secret
    G-->>C: sampling_commitment
    A->>G: open_engagement with no seed
    G->>E: open
    Note over E: seed is the first 16 hex characters of SHA-256 over the secret and the snapshot hash
    E-->>A: engagement and seed
    C->>G: verify_sampling_seal
    G-->>C: secret, seed and the recomputed checks
    Note over C: SHA-256 of the secret equals the commitment held since the upload
```

| Property | Why it holds |
|---|---|
| The auditor cannot choose the samples | The seed follows from a secret drawn by the system and from the frozen ledger. |
| The auditor cannot draw again | The same register upload and snapshot always give the same seed and the same engagement. Opening again returns the engagement that exists. |
| The client cannot predict the samples | The client holds only the hash of the secret until the engagement opens. |
| The secret cannot be exchanged afterwards | The client received the commitment in the result of its own upload, before the auditor read the register. |

`verify_sampling_seal` is available to every role and reports one of these states.

| Status | Meaning |
|---|---|
| `sealed` | A register is uploaded and sealed. No engagement is open yet, so the secret is not shown. |
| `verified` | The secret hashes to the commitment, the seed follows from the secret and the snapshot, and the seal was made when the register arrived. |
| `sealed at opening` | The seal was made only when the engagement opened. The seed still cannot be drawn again, but the client did not hold the commitment first. |
| `chosen` | A seed was passed to `open_engagement` by hand, for example to reproduce an earlier run. The status and the summary report say so. |

### Control requests

The evidence checks test whether a document looks genuine. A control request tests the client instead. Among the ordinary evidence requests, up to three ask for a document that should not exist.

```mermaid
flowchart TD
    R[A request for a document that should not exist] --> Q{How does the client answer}
    Q -->|upload_evidence with not_available| P[The control is passed]
    Q -->|a file| F[Check E-9 and a High finding<br/>the document was made for the request]
    Q -->|nothing| W[The sample stays Pending evidence]
```

| Kind | The request | Why the document should not exist |
|---|---|---|
| E-way bill | An e-way bill for a sampled invoice | The consignment value does not exceed Rs 50,000 and no e-way bill is recorded. |
| Credit note | A credit note against a sampled invoice | No credit note is recorded against it. |

A control request is worded like every other request, and nothing returned to the client marks it. The first kind is preferred, and the rest are drawn with the seeded generator. The engagement status, `verify_evidence` and the summary report state how many were sent, declined and supplied. SA 240 asks for an element of unpredictability in audit procedures, and this is one.

The number of control requests is `control_requests_max` in `engine/audit_engine/thresholds.toml`. Set it to `0` to send none, for example where a client agent that is not under test answers every request with a file.

### Changes after testing begins

The engagement reads a frozen snapshot. Any client event recorded after it is compared with the samples: a reversal, a credit note, a customer change, a journal, a backdated document, replaced evidence or a register uploaded again. Each is a D-15 finding traced to the samples it touches, and the affected test results revert.

### Ledger verification

`verify_ledger_integrity` recomputes every hash of the business chain and the trail chain, and compares the hash at the snapshot with the hash stored when the engagement opened. A stored record that was altered is located by its sequence number and reported as D-16.

## Outputs

| Output | Tool | Format | Contents |
|---|---|---|---|
| Workpaper | `export_workpaper` | `.xlsx` | Sales Register as the client provided it with the auditor's columns beside it, Sales TOD, Sales Cut-off TOD, Credit Note TOD, Findings, and the Parameters needed to reproduce every sample. |
| Findings memo | `draft_findings_memo` | `.md`, `.docx` | Every finding with its impact, proposed adjusting entry, standard references and evidence, the changes after testing began, and a statement of ledger integrity. |
| Summary report | `export_summary_report` | `.pdf` | One page for the engagement partner. It can be produced at any point. |
| Audit trail | `get_audit_trail` | data, or a stored file | Every tool call by every identity, with the result of recomputing the chain. |
| Report email | `send_report_email` | email | A report sent to a fixed audience through Twilio SendGrid. See below. |

The summary report shows the findings by severity and by area, the five largest by amount, the proposed adjustment to revenue, the samples and their results, the documents requested and received, and the state of each safeguard. It also grades the revenue of the period by the record behind each invoice:

| Grade | Meaning |
|---|---|
| Ordered, shipped, delivered, paid | The whole life of the sale is on record. |
| Delivered, not yet paid | Everything except the cash. |
| Some movement on record | A dispatch or a delivery, but not the whole chain. |
| Order only, no movement | An order and an invoice, and nothing physical between them. |
| Invoice with nothing behind it | The invoice stands alone. |

A full chain does not make a sale genuine, and the page says so: circular trading has complete paperwork. The grade sits beside the findings and does not replace them. Each output states the ledger hash it rests on, and the same engagement state gives the same file.

## The audit assistant

An auditor or an audit manager can ask about the engagement in plain words, in English, Hindi or Marathi: how many findings are High, why an invoice was flagged, what the control requests showed. In the interface it is a panel that stays over every auditor screen. For an agent it is the tool `ask_assistant`.

```mermaid
flowchart LR
    Q[Question] --> S[Search the passages<br/>of this engagement]
    S -->|nothing answers it| D[Declined<br/>no model call]
    S --> P[Best passages<br/>numbered as sources]
    P -->|no model, or allowance spent| R[Answer straight<br/>from the records]
    P --> M[Model words the answer<br/>from the sources only]
    M --> C{Every figure<br/>in a source?}
    C -->|yes| A[Answer with source numbers]
    C -->|no| W[That sentence is withheld]
```

| Property | How it is achieved |
|---|---|
| Answers come from this audit only | The engine turns the engagement into short passages: one for each finding, sample and related party, the computed figures, and a guide to what each check and safeguard means. A question retrieves at most five of them, and nothing else reaches the model. |
| The model never counts | Totals, rankings and shares are computed in code, by the functions that fill the screens and the summary report, and are stated in the passages. The model is told to copy figures and to work none out. |
| No figure is invented | After the model replies, every figure in every sentence is looked up in the sources. A sentence with a figure that no source states is withheld, and the reply says how many were. If nothing is left, the answer is the records themselves. |
| Every statement can be opened | A sentence carries the number of its source. Clicking it opens that finding, sample or screen. |
| It declines | A question the records do not speak to gets no answer and no model call. |
| Three languages, one index | A question in Hindi or Marathi is given the English audit words for its own, so the same passages are searched. With a model, the answer comes back in the language of the question. |
| It works with no model | Search is BM25 with exact document numbers and correction of misspelt words, held in memory. With `CHAT_MODEL` empty, the best passages are the answer. |
| Spending is bounded | One model call for a question. A repeated question is answered from memory. `CHAT_DAILY_TOKENS` caps the day, after which answers come straight from the records. |
| It is on the trail and changes nothing | Each question is an entry in the audit trail with the caller, the time and the hashes of the question and the answer. The tool is not listed for the client. |

The glossary of Hindi and Marathi audit words is in `engine/audit_engine/assistant/search.py`. A question whose words are not in it is declined, as any other question the records do not answer.

## User interface

The interface is printed like a banknote, because the question it asks of a sale is the one a bank asks of a note: is it genuine? Pages carry guilloche rosettes, a security thread, microtext, a watermark that shows when a panel is held to the light (hovered), serial numbers whose digits grow from left to right, and figures in colour-shift ink that move from one colour to the other with the pointer.

The front page tells the whole system as one story over a 3D scene of a year's sales, drawn as notes that re-form for each chapter: the register as a wall, thirty samples stepping out, the fakes glowing under ultraviolet light, a ring of companies passing money round, the hash chain as a helix, and the signed stacks. Each chapter opens its page of the workspace, and each page opens with the same chapter in its heading. The Lens and the workspace are one click from the front page.

| Control | What it does |
|---|---|
| Simple, Full detail | Simple shows each page's summary, its main view and its list, and folds the other analysis into one bar. Full detail shows every chart. |
| Ctrl K | Finds a page, an action or a finding. |

The workspace asks for an identity. Each identity sees only what its role and department allow, because the tabs follow from the tool list that the server returns.

| Identity | Tab | Purpose |
|---|---|---|
| Client | Upload | Send the sales register and the related-party list. Shows the sampling commitment once the register is sealed. |
| Client | Requests | The documents the auditor asked for. Upload a file, or answer that the document does not exist. |
| Client | Records | Browse every business record with its versions and ledger postings. |
| Client | New record | A form for each record the department may create. |
| Client | Access | Who may do what, with the caller's own department highlighted. |
| Auditor | Overview | The answer first: the revenue in question against the register, the next step to take, the stages of the audit, what it covered and the findings to look at first. The plan, the snapshot and the seed are one click below. |
| Auditor | Register | The client's register as provided, with the related-party tag, reconciliation status and findings pinned beside each row. Every row is also one square of a wall, so the rows that do not agree stand out, and a square opens its row. |
| Auditor | Samples | The three test-of-details sheets with the reason for each sample and its test results. The samples rise from a line of the period at their dates, each marked with its result. A document the client sent can be held to the light, as below. |
| Auditor | Findings | Every finding with its explanation, the ledger records it rests on, its lineage and its proposed adjustment. The audit manager decides here, by button or with the keys C, R and I, and the decision is stamped on the finding. |
| Auditor | Graph | The counterparty graph in two or three dimensions, with the trading cycles. |
| Auditor | Trail | The audit trail and the result of verifying it, with the latest links of the chain checked in the browser. |
| Auditor | Export | The summary report, the workpaper and the findings memo. |
| Auditor | Ask | A panel over every auditor screen. It answers questions from the records of the engagement and opens the record behind each statement. |
| Any | Lens | Audit any register in the browser, as below. |

### A document held to the light

In the panel of a sample, each document the client sent has a button, Hold to the light. It opens the file as the client uploaded it, under the lamp, and marks it from three sources: the text of that document, the records of that sale and the findings the engine raised on that sample.

| Mark | Meaning | Where it comes from |
|---|---|---|
| Green | The value is the same as in the books. | Each number, date, document number and name on the page is compared in the browser with the records `get_sale_chain` returns for the sale. |
| Pink | The evidence checks caught this value. The figure the books hold is written beside it. | The findings of the sample from `get_findings`. The browser decides nothing here. |
| Yellow | An amount printed on the page that no record of the sale holds and no check named. | The same comparison as green. |

A document in Hindi or Marathi is marked like any other, because what is compared are its figures, dates and numbers. A photograph or a scan has no text to compare and is shown as it is. The viewer adds no tool and no server call beyond reading the file, and it changes nothing.

### Lens

Sanchay Lens is one click from the front page, and a tab of the workspace for every identity. A visitor drops a sales register (Excel, CSV or JSON), or presses Audit the sample register, and the browser audits it with no account, no server call and no model. The related-party list can be dropped with it.

| Stage | What happens |
|---|---|
| Read | The file is parsed in the browser. Total rows are set aside. |
| Understand | Each column is given a meaning (date, amount, party, GSTIN, state, document number, category) with the reason. A reader can change any meaning, and every test and view follows. |
| Seal | Every row is hashed with SHA-256, each hash covering the one before. |
| Test | Fourteen tests: duplicate numbers, the number series, rows that do not add up, GSTIN check characters, state against GSTIN, the kind of GST for the place of supply, dates outside the year, the year-end rush, Benford's law, round figures, Sunday bills, missing details, unusually large amounts and sales to related parties. A test whose columns are missing says so. |
| Sample | Thirty samples: the five largest, rows caught by the tests, then value-weighted draws seeded from the seal. |
| Build the page | The views are chosen from the column meanings and written as a spec that can be read: every row as a point, money by month, the parties, a 3D city of party by month, the calendar, a tile map of India, each category, Benford's law and the size of the amounts. Each view states why it was built. |

The run plays as it happens, with every figure taken from the computation. The GSTIN rule is the same as the engine's. The sample is the planted FY 2025-26 register from the data generator, in `ui/public/samples/`.

## Tools

| Identity | Tools | Of which write |
|---|---|---|
| Client employee, no department | 36 | 27 |
| Sales | 13 | 6 |
| Dispatch | 14 | 7 |
| Accounts | 20 | 11 |
| Admin | 15 | 6 |
| Auditor | 34 | 0 |
| Audit manager | 36 | 0 |

Auditor tools change no business data. They write only to the `audit` schema, through the engine.

| Group | Client tools |
|---|---|
| Parties | `create_customer`, `update_customer`, `create_vendor`, `update_vendor`, `record_company_officer` |
| Pricing and promotions | `set_price`, `create_promotion` |
| Sale | `record_enquiry`, `create_sales_order`, `record_dispatch`, `generate_eway_bill`, `record_lr`, `record_delivery`, `issue_invoice` |
| Tax and settlement | `file_gstr1`, `record_receipt`, `import_bank_statement` |
| Reversal | `issue_credit_note`, `record_sales_return`, `reverse_document` |
| Purchases and ledger | `record_purchase_invoice`, `record_goods_receipt`, `record_payment`, `post_journal` |
| Audit support | `upload_sales_register`, `upload_related_parties`, `upload_evidence`, `list_evidence_requests` |
| Read | `list_records`, `get_record`, `export_sales_register`, `get_trial_balance`, `get_access_policy`, `verify_sampling_seal`, `get_merkle_proof`, `get_audit_trail` |

| Group | Auditor tools |
|---|---|
| Plan and engagement | `get_audit_plan`, `get_notifications`, `open_engagement`, `get_engagement_status`, `list_engagements` |
| Register and parties | `import_register`, `reconcile_register`, `get_register_rows`, `tag_related_parties` |
| Detectors and sampling | `run_detectors`, `select_sales_tod`, `select_cutoff_tod`, `select_credit_note_tod`, `get_samples` |
| Evidence | `get_evidence_status`, `request_evidence`, `verify_evidence` |
| Integrity | `check_post_testing_changes`, `verify_ledger_integrity`, `verify_sampling_seal`, `get_merkle_proof` |
| Findings and investigation | `get_findings`, `explain_finding`, `get_counterparty_graph`, `query_records`, `get_sale_chain`, `get_ledger_entries` |
| Outputs | `draft_findings_memo`, `export_workpaper`, `export_summary_report`, `get_audit_trail`, `send_report_email` |
| Assistant | `ask_assistant` |
| Other | `get_access_policy` |
| Audit manager only | `confirm_finding`, `sign_off_engagement` |

### Tool conventions

| Topic | Rule |
|---|---|
| Amounts | Rupees at the tool boundary. Stored as integer paise. |
| Dates | `YYYY-MM-DD`. Date and time values are RFC 3339. |
| Write tools | Need `idempotency_key`. Repeating a call with the same key returns the first result. |
| Files | Pass `file_hash` of a stored file, or `content_base64` for a small one. Store a file with `POST /api/files`. |
| Lists | Paginated with `limit` and `cursor`. |
| Errors | `code`, `message` and `next_step`. |
| Engagement | `engagement_id` is optional when exactly one engagement is open. |

## Run with Docker

```sh
docker compose -f deploy/docker-compose.yml up --build
```

| Address | Purpose |
|---|---|
| http://localhost:5173 | User interface |
| http://localhost:8080/mcp | MCP endpoint for agents |
| http://localhost:8080/healthz | Health of the server and the services behind it |

The first build compiles the OCaml ledger core and takes several minutes. To set tokens or a model key, copy `deploy/.env.example` to `deploy/.env`. Git ignores that file.

The sign-in belongs to the browser tab. An auditor, an audit manager and a client employee can be open side by side in one browser, each in a tab. A screen reloads when another person changes something, and not when they only read.

## Load the demo business

The data generator loads a synthetic manufacturer with planted irregularities through the client tools, with the historical record time of each event. That needs the seeding clock, which is off unless the stack is started with `SIM_CLOCK=1`.

```sh
SIM_CLOCK=1 docker compose -f deploy/docker-compose.yml up --build -d
cd datagen
uv run python -m elev_datagen generate --dataset planted --scale 1 --out ../var/seed --mcp-url http://localhost:8080
cd .. && docker compose -f deploy/docker-compose.yml up -d   # restart with the seeding clock off
```

`--scale 1` loads a full year: about 8,800 sales, of which about 6,900 fall in the audited period, in about 72,000 events. `--scale 0.15` loads about 1,000 sales for quick runs. The load ends with the register and the related-party list uploaded, and the sampling seed sealed.

After the auditor selects samples, the client simulator answers the evidence requests from the client's own records. It answers a request for a document it does not hold as not available.

```sh
cd datagen
uv run python -m elev_datagen respond --dataset ../var/seed          # an honest client
uv run python -m elev_datagen respond --dataset ../var/seed --plant  # forgeries, and a document supplied for every request
uv run python -m elev_datagen respond --dataset ../var/seed --plant --regional  # and every fourth sample in Hindi or Marathi
```

The generator writes `answer_key.json` beside the dataset, outside the file store, so no tool can read it. With `--plant`, the forged evidence is listed in `evidence_answer_key.json`. With `--regional`, the client's own documents of every fourth sample are written in Marathi or Hindi, and the invoice with the forged amount is one of the Hindi ones.

## Run without Docker

Requirements: Postgres 16, Go 1.27, Node 22, Python 3.12 with uv, and OCaml 5.2 with opam.

```sh
# 1. Database
createdb audit
PGDATABASE=audit sh db/apply.sh

# 2. Ledger core
cd ledger
opam install . --deps-only
DATABASE_URL=postgres://ledger_rw:ledger_rw@localhost:5432/audit dune exec ledger

# 3. Audit engine and MCP server
cd engine
DATABASE_URL=postgres://engine_audit:engine_audit@localhost:5432/audit FILES_DIR=../mcp/data/files LEDGER_URL=http://localhost:7001 uv run python -m audit_engine.api
cd ../mcp
DATABASE_URL=postgres://mcp_read:mcp_read@localhost:5432/audit go run ./cmd/server

# 4. User interface
cd ui && npm install && npm run dev
```

To load data, start the ledger core with `LEDGER_SIM_CLOCK=1` and the MCP server with `SIM_CLOCK=1`, then restart both without them.

## Connect an agent

Any MCP client that supports Streamable HTTP can connect. Example client configuration:

```json
{
  "mcpServers": {
    "sanchay": {
      "type": "http",
      "url": "http://localhost:8080/mcp",
      "headers": { "Authorization": "Bearer auditor-demo-token" }
    }
  }
}
```

The server lists only the tools of the token's role and department, and its instructions tell the agent how to begin. An auditing agent starts with `get_audit_plan` and follows `next_tool`. Every error names the next step to take.

For a client that speaks MCP over standard input and output:

```sh
cd mcp && go run ./cmd/server --stdio --token auditor-demo-token
```

## Run the auditor agent

`agent/audit_agent.py` is a small MCP client. It holds an auditor token, reads the tool list from the server, and lets a hosted model choose the calls until the audit plan is complete. It uses the Python standard library only.

```mermaid
sequenceDiagram
    participant M as Hosted model
    participant A as audit_agent.py
    participant S as MCP server

    A->>S: initialize and tools/list
    S-->>A: instructions and the tools of the auditor identity
    loop until the plan is complete
        A->>M: task, tool catalogue and the results so far
        M-->>A: the calls it wants, as JSON
        A->>S: tools/call for each
        S-->>A: results
    end
    M-->>A: REPORT and the text of the report
```

The model is reached with plain text: the tools are described in the prompt and the model answers with the calls it wants as JSON. This works with gateways that do not pass tool definitions through. Requests are paced, kept under 44 KB, and a rate-limit answer is waited out. Results the model has already acted on are shortened, so the conversation stays small.

Set `LLM_URL`, `LLM_API_KEY` and `AGENT_MODEL` in `deploy/.env`. The agent reads the values from the file when the environment does not set them.

```sh
python agent/audit_agent.py --client-cmd "cd datagen && uv run python -m elev_datagen respond --dataset ../var/seed --plant"
```

| Option | Meaning |
|---|---|
| `--client-cmd` | Command that answers the evidence requests as the client. It runs when the agent waits for evidence. |
| `--seed` | A sampling seed chosen by hand. Omit it to use the sealed seed. |
| `--token-budget` | The run stops when the model has used this many tokens. Default 120,000. |
| `--model` | Model for the agent. Default `AGENT_MODEL`, then `LLM_MODEL`. |
| `--pace` | Seconds between requests to the model. Default 5. |
| `--effort` | Reasoning effort asked of the model. Default `low`. |
| `--no-model` | Follows the plan with no model. It checks the connection and the tools and is not an agent. |
| `--transcript` | Writes every reply and result to a JSON Lines file. |

The agent never confirms a finding and never signs off. Those tools are withheld from the model, and the server refuses them for the auditor role in any case.

## Where a model is used

The system runs in full with no model. A model is optional in three places and required only by the agent.

| Place | Use | Without a model |
|---|---|---|
| Evidence reading | Fills or confirms fields read from a document. Its output is validated against a schema, and a disagreement with the pattern rules lowers the confidence of the field. | Pattern rules read the fields. |
| Memo wording | Rephrases the description of a finding. A rephrasing that changes any number is discarded. | Template text is used. |
| Audit assistant | Words the answer from the passages that search found. A sentence with a figure that is not in those passages is withheld. | The passages are the answer. |
| Auditor agent | Chooses which tool to call next. | `--no-model` follows the plan. |
| Findings, sampling, severity, the summary figures | Never | |

The engine accepts a local Ollama server (`OLLAMA_URL`), which keeps every request inside the deployment, or a hosted service that speaks the chat completions format (`LLM_URL`, `LLM_API_KEY`, `LLM_MODEL`). `LLM_MODEL` is a separate switch from `AGENT_MODEL`: while it is empty, no step in the application calls a model and only the agent spends tokens. Model readings and accepted wording are cached, so repeating a step needs no model. `CHAT_MODEL` is a third switch, for the assistant only: while it is empty the assistant answers from the records and spends no tokens.

### Report emails

`send_report_email` sends one of three reports. The kind decides the audience; addresses come from the server's configuration and never from the call.

| Kind | Goes to | Who can send | Contents |
|---|---|---|---|
| `findings_review` | Audit manager, and the partner when one is named | Auditor, audit manager | Findings awaiting review by severity, the potential misstatement before review, and the largest high-severity findings. Marked for the audit team only. |
| `evidence_reminder` | The client's staff | Auditor, audit manager | Every document still awaited, by sample, with a pointer to the Requests page. Refused when nothing is awaited. |
| `findings_memo` | The client's management | Audit manager, after sign-off | The confirmed findings and their total impact, and the memo's SHA-256 when its `file_hash` is passed. |

Potential findings never reach the client: the only email to the client's management is the memo, and only once the engagement is signed off. Every email states the snapshot hash it rests on. The tool call is recorded in the trail like any other, and its result, which holds the recipients, subject and SendGrid message id, is hashed into the chain. Without `SENDGRID_API_KEY` and `EMAIL_FROM` the tool returns the email as a preview and sends nothing.

## Configuration

| Variable | Service | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | all | per service | Connection string for the service's own database role |
| `SERVICE_TOKEN` | all | `dev-service-token` | Shared token between internal services |
| `CATALOGUE_PATH` | ledger, mcp | `../contracts/events.json` | Event catalogue |
| `LEDGER_PORT` | ledger | `7001` | Listening port |
| `VERIFY_DOMAINS` | ledger | cores minus one, at most 8 | Domains used to verify the chain in parallel |
| `LEDGER_SIM_CLOCK` | ledger | `0` | Set `1` only while loading historical data |
| `SIM_CLOCK` | mcp | `0` | Set `1` only while loading historical data |
| `LISTEN_ADDR` | mcp | `:8080` | Listening address |
| `LEDGER_URL`, `ENGINE_URL` | mcp | `http://localhost:7001`, `http://localhost:7002` | Internal services |
| `TOKEN_CLIENT`, `TOKEN_AUDITOR`, `TOKEN_MANAGER` | mcp | demo tokens | One token per demo identity |
| `TOKEN_SALES`, `TOKEN_DISPATCH`, `TOKEN_ACCOUNTS`, `TOKEN_ADMIN` | mcp | `<department>-demo-token` | One token per client department |
| `IDENTITIES_FILE` | mcp | unset | JSON list of `{token, user, role, department}` that replaces the demo tokens. `department` is optional and applies to `client_employee` only. |
| `OBJECT_STORE` | mcp | `dir` | `dir` for a directory, `s3` for MinIO or another S3-compatible store |
| `FILES_DIR` | mcp, engine | `./data/files` | Directory for the `dir` store |
| `MCP_STATEFUL` | mcp | `false` | Set `true` to keep MCP sessions between requests |
| `SENDGRID_API_KEY` | mcp | unset | Twilio SendGrid API key with Mail Send access. Unset means report emails are previewed, not sent. |
| `EMAIL_FROM`, `EMAIL_FROM_NAME` | mcp | unset, `Revenue Audit` | Sender of report emails. The address or its domain must be verified in SendGrid. |
| `EMAIL_TO_MANAGER`, `EMAIL_TO_PARTNER`, `EMAIL_TO_AUDITOR`, `EMAIL_TO_CLIENT`, `EMAIL_TO_CLIENT_MANAGEMENT` | mcp | unset | Comma-separated recipients for each audience of `send_report_email` |
| `ENGINE_OUTPUT_DIR` | engine | `var/outputs` | Where exported files are also written |
| `ENGINE_THRESHOLDS` | engine | `audit_engine/thresholds.toml` | Alternative thresholds file |
| `OLLAMA_URL`, `OLLAMA_MODEL` | engine | unset, `llama3.2:3b` | Optional local model for evidence reading and memo wording |
| `LLM_URL`, `LLM_API_KEY` | engine, agent | unset | Optional hosted model that speaks the chat completions format. An address that ends in `/v1` gets `/chat/completions` appended. Any other address is used as given. |
| `LLM_MODEL` | engine | unset | Model for the engine. For the engine a hosted model takes precedence over the local one. |
| `AGENT_MODEL` | agent | unset | Model for the auditor agent. `LLM_MODEL` is used when it is unset. |
| `CHAT_MODEL` | engine | unset | Model that words the assistant's answers, reached through `LLM_URL` and `LLM_API_KEY`. While it is empty the assistant answers from the records. |
| `CHAT_DAILY_TOKENS` | engine | `100000` | Tokens the assistant may use in a day. Beyond it, answers come from the records. The count restarts with the engine. |
| `LLM_REASONING_EFFORT`, `LLM_WORKERS` | engine | unset, `2` | Reasoning effort asked of the hosted model, and the number of concurrent requests to it. Hidden reasoning is billed as output, so `minimal` suits document reading. |

## Tests and measured results

```sh
cd ledger && dune test                 # posting rules, canonical JSON, hash chain, Merkle proofs, capabilities
cd mcp && go test ./...                # catalogue, validation, money conversion, departments
cd engine && uv run pytest             # chain, GSTIN, money, repository, model output handling, the assistant
cd datagen && uv run pytest            # generator and engine together, on generated data
python deploy/smoke.py                 # end to end, against running services
```

| Suite | Covers |
|---|---|
| `mcp` | The catalogue and input validation. Every write tool belongs to a department, the departments separate the steps of a sale, and a department never widens another role. |
| `engine` | Hash chain vectors, GSTIN checksums, money arithmetic, the append-only repository, how model output is parsed and merged with pattern rules, and the assistant: what a question finds, what is declined, and the check on every figure a model writes. |
| `datagen` | Recall of every planted item by detector, no findings on the clean dataset, reproducible sampling, evidence checks, control requests, the sealed seed, the summary report, the assistant's answers against the engagement, and the API. |
| `deploy/smoke.py` | 73 checks on a small business: the full sale chain, refusals, idempotency, 40 parallel appends, the snapshot, a change after testing, both chains, the trail and the MCP protocol. Set `PSQL` to a superuser connection to include the tamper test. |

The figures below are from one run of the full-year planted dataset on a laptop with 16 GB of memory and no dedicated GPU, with every service running locally and no model.

| Measure | Result |
|---|---|
| Events loaded through the client tools | 71,667 |
| Sales | 8,790, with 6,885 rows in the client's register |
| Time to load | About 8 minutes |
| The 13 steps of the plan, including the client's answers | About 65 seconds |
| Samples | 75: 30 sales, 25 cut-off, 20 credit notes |
| Evidence requests | 206, of which 3 were control requests |
| Findings | 118: 46 High, 5 Medium, 67 Low |
| Planted items | Each of the 87 planted items has a finding of its category that names its subject |
| Control requests | The simulated client supplied a document for all 3, and each is a High finding |
| Revenue with a full chain of records | 99.8 percent of Rs 105.35 crore |

## Repository conventions

- All work is committed to `main`.
- Each person changes only the paths they own (PRD section 26). A change to `contracts/` or `db/` is announced first.
- Documentation uses a formal tone and no em dashes.
- A key is never committed. `deploy/.env` holds local settings and is ignored by git.
