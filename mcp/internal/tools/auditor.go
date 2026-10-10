package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/catalogue"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/core"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/store"
)

// engineTool is an auditor tool that is one call to the audit engine
// (PRD rule C-4).
type engineTool struct {
	name, group, desc string
	method, path      string
	roles             []string
	fields            []catalogue.Field
	notify            string
}

func (e engineTool) build(d *Deps) *Tool {
	return &Tool{
		Name:        e.name,
		Group:       e.group,
		Description: e.desc,
		Roles:       e.roles,
		Fields:      e.fields,
		Notify:      e.notify,
		Handler: func(ctx context.Context, c *core.Call) (map[string]any, *core.ToolError) {
			path := e.path
			args := map[string]any{}
			for k, v := range c.Args {
				placeholder := "{" + k + "}"
				if strings.Contains(path, placeholder) {
					path = strings.ReplaceAll(path, placeholder, fmt.Sprint(v))
					continue
				}
				args[k] = v
			}
			return d.Engine.Do(ctx, c.Identity, e.method, path, args)
		},
	}
}

func auditorEngineTools(d *Deps) []*Tool {
	defs := []engineTool{
		{
			name: "get_audit_plan", group: "Plan", method: http.MethodGet, path: "/plan", roles: auditRoles,
			desc:   "Start here. Returns the ordered audit steps, the tool for each, which are done, and the next tool to call. Call it again at any time to see where the audit stands.",
			fields: []catalogue.Field{fEngagement},
		},
		{
			name: "open_engagement", group: "Engagement", method: http.MethodPost, path: "/engagements", roles: auditRoles,
			desc: "Open an audit engagement for a period. Freezes a snapshot of the client's records: later client changes are invisible to testing and are reported by check_post_testing_changes. Needs the client's sales register and related-party list to be uploaded; call get_notifications to check. Next: import_register.",
			fields: []catalogue.Field{
				reqDate("period_start", "First day of the audited period, for example 2024-04-01."),
				reqDate("period_end", "Last day of the audited period, for example 2025-03-31."),
				str("seed", "Leave this out. The seed then follows from a secret sealed when the register arrived and from the frozen ledger, so that nobody chooses it and it cannot be drawn again; verify_sampling_seal shows the proof. A seed given here is recorded as chosen by the auditor. The same seed and snapshot always give the same samples."),
				strList("entity_ids", "Legal entities in scope. Defaults to the main entity."),
			},
		},
		{
			name: "get_engagement_status", group: "Engagement", method: http.MethodGet, path: "/engagements/status", roles: auditRoles,
			desc:   "Get the engagement's period, seed, snapshot, completed steps, counts of findings and samples, and the next recommended tool.",
			fields: []catalogue.Field{fEngagement},
		},
		{
			name: "list_engagements", group: "Engagement", method: http.MethodGet, path: "/engagements", roles: auditRoles,
			desc: "List every engagement with its period and whether it is signed off.",
		},
		{
			name: "get_register_rows", group: "Register", method: http.MethodGet, path: "/register/rows", roles: auditRoles,
			desc: "Read the imported sales register as the client provided it, with the related-party tag, reconciliation status and finding references added beside each row.",
			fields: []catalogue.Field{
				fEngagement,
				str("recon_status", "Only rows with this reconciliation status, for example FIELD_DIFFERENCE or NOT_IN_SYSTEM."),
				str("rp_tag", "Only rows with this tag: Related Party or Non Related Party."),
				fLimit,
				fCursor,
			},
		},
		{
			name: "get_samples", group: "Sampling", method: http.MethodGet, path: "/samples", roles: auditRoles,
			desc: "Read the samples already selected for one sheet, with the reason for each and its test results. Does not select; use the select tools for that.",
			fields: []catalogue.Field{
				fEngagement,
				{Name: "sheet", Type: "enum", Required: true, Values: []string{"sales_tod", "cutoff_tod", "credit_note_tod"}, Description: "Which sheet."},
			},
		},
		{
			name: "import_register", group: "Register", method: http.MethodPost, path: "/register/import", roles: auditRoles,
			desc:   "Carry the client's sales register into the workpaper exactly as provided: same rows, same order, same values. Call after open_engagement. Next: reconcile_register.",
			fields: []catalogue.Field{fEngagement},
		},
		{
			name: "reconcile_register", group: "Register", method: http.MethodPost, path: "/register/reconcile", roles: auditRoles,
			desc:   "Compare the client's register with the system of record. Every difference becomes a finding: missing rows, rows with no invoice behind them, changed fields, duplicates and totals that do not agree to the ledger. Next: tag_related_parties.",
			fields: []catalogue.Field{fEngagement},
		},
		{
			name: "tag_related_parties", group: "Related parties", method: http.MethodPost, path: "/related-parties/tag", roles: auditRoles,
			desc:   "Mark each customer as related or non-related from the client's disclosed list, and suggest undisclosed related parties linked through shared PAN, directors, bank accounts, phone, email or address, with the date each link began. Next: run_detectors.",
			fields: []catalogue.Field{fEngagement},
		},
		{
			name: "run_detectors", group: "Detectors", method: http.MethodPost, path: "/detectors/run", roles: auditRoles,
			desc: "Run every detector over the whole population in the snapshot: circular trading, sales with no physical movement, cut-off by transfer of control, period-end concentration, statutory document and GSTR-1 mismatches, revenue not from a sale, credit notes, promotions, settlement and document integrity. Returns hits per detector. Next: select_sales_tod.",
			fields: []catalogue.Field{
				fEngagement,
				strList("detectors", "Detector IDs to run, for example D-05. Runs all when omitted."),
			},
		},
		{
			name: "select_sales_tod", group: "Sampling", method: http.MethodPost, path: "/samples/sales", roles: auditRoles, notify: NotifyClient,
			desc: "Select 25 to 35 sales for the Sales TOD sheet, weighted to risk: related parties, high amounts, period-end dates and detector hits, covering many customers. Each sample carries its reason. The selection is reproducible from the seed and snapshot. Evidence requests are sent to the client automatically. Next: select_cutoff_tod.",
			fields: []catalogue.Field{
				fEngagement,
				integer("target", "Number of samples, 25 to 35. Default 30."),
			},
		},
		{
			name: "select_cutoff_tod", group: "Sampling", method: http.MethodPost, path: "/samples/cutoff", roles: auditRoles, notify: NotifyClient,
			desc: "Select the last invoices before the period end and the first after it for the Sales Cut-off TOD sheet, with dispatch dates, delivery dates and the date control passed. Evidence requests are sent to the client automatically. Next: select_credit_note_tod.",
			fields: []catalogue.Field{
				fEngagement,
				integer("before", "Invoices on or before the period end. Default 10."),
				integer("after", "Invoices after the period end, 10 to 15. Default 15."),
			},
		},
		{
			name: "select_credit_note_tod", group: "Sampling", method: http.MethodPost, path: "/samples/credit-notes", roles: auditRoles, notify: NotifyClient,
			desc:   "Select credit notes for the Credit Note TOD sheet, taking those issued after the period end against invoices in the period first. Evidence requests are sent to the client automatically. Next: get_evidence_status.",
			fields: []catalogue.Field{fEngagement},
		},
		{
			name: "get_evidence_status", group: "Evidence", method: http.MethodGet, path: "/evidence/status", roles: auditRoles,
			desc:   "See which requested documents the client has uploaded for each sample. Call before verify_evidence. If documents are pending, the client must call upload_evidence.",
			fields: []catalogue.Field{fEngagement},
		},
		{
			name: "request_evidence", group: "Evidence", method: http.MethodPost, path: "/evidence/requests", roles: auditRoles, notify: NotifyClient,
			desc: "Ask the client for further documents for samples. Not needed for the standard documents, which are requested automatically when samples are selected.",
			fields: []catalogue.Field{
				fEngagement,
				{Name: "sample_ids", Type: "string_list", Required: true, Description: "Samples the request is for."},
				{Name: "document_types", Type: "string_list", Required: true, Description: "Documents wanted: invoice, eway_bill, lr_copy, proof_of_delivery, credit_note, sales_return, other."},
				str("note", "Message to the client."),
			},
		},
		{
			name: "verify_evidence", group: "Evidence", method: http.MethodPost, path: "/evidence/verify", roles: auditRoles,
			desc: "Test the uploaded evidence: agree it to the system of record and to the other documents of the sample, and check for reused files, documents that belong to another transaction, infeasible transport and documents created after the request. Updates each sample's test results. Samples with no evidence stay Pending evidence. Next: check_post_testing_changes.",
			fields: []catalogue.Field{
				fEngagement,
				str("sample_id", "Verify one sample. Verifies every sample when omitted."),
			},
		},
		{
			name: "check_post_testing_changes", group: "Integrity", method: http.MethodPost, path: "/changes/check", roles: auditRoles,
			desc:   "List every client change made after the snapshot that touches a sample: reversals, credit notes, customer changes, journals, backdated documents, replaced evidence and re-uploaded registers. Each is a finding traced to the affected samples. Safe to call repeatedly. Next: verify_ledger_integrity.",
			fields: []catalogue.Field{fEngagement},
		},
		{
			name: "get_findings", group: "Findings", method: http.MethodGet, path: "/findings", roles: auditRoles,
			desc: "List findings with optional filters. Returns compact rows; call explain_finding for the detail of one.",
			fields: []catalogue.Field{
				fEngagement,
				str("category", "Only this category, for example NO_MOVEMENT or CUTOFF."),
				enum("severity", "Only this severity.", "High", "Medium", "Low"),
				enum("status", "Only this status.", "proposed", "confirmed", "rejected", "needs_info"),
				str("sample_id", "Only findings that affect this sample."),
				fLimit,
				fCursor,
			},
		},
		{
			name: "explain_finding", group: "Findings", method: http.MethodGet, path: "/findings/{finding_id}/explain", roles: auditRoles,
			desc:   "Get one finding in full: a plain-language reason, the rule and thresholds applied, the exact events and documents behind it, the amount, the proposed adjusting entry and the standards it rests on.",
			fields: []catalogue.Field{reqStr("finding_id", "Identifier from get_findings.")},
		},
		{
			name: "get_counterparty_graph", group: "Findings", method: http.MethodGet, path: "/graph", roles: auditRoles,
			desc:   "Get the counterparty graph: parties as nodes, goods and money flows as edges, related-party clusters, and the trading cycles detected.",
			fields: []catalogue.Field{fEngagement},
		},
		{
			name: "draft_findings_memo", group: "Outputs", method: http.MethodPost, path: "/memo", roles: auditRoles,
			desc:   "Produce the findings memo: each finding with its impact, proposed adjusting entry, standard reference and evidence, plus the integrity statement. Unconfirmed findings are marked Pending auditor confirmation. Returns files to download.",
			fields: []catalogue.Field{fEngagement},
		},
		{
			name: "export_workpaper", group: "Outputs", method: http.MethodPost, path: "/workpaper", roles: auditRoles,
			desc:   "Produce the audit workpaper as an .xlsx file with the Sales Register, Sales TOD, Sales Cut-off TOD and Credit Note TOD sheets, plus findings and the parameters needed to reproduce the samples. Returns a file to download.",
			fields: []catalogue.Field{fEngagement},
		},
		{
			name: "confirm_finding", group: "Sign-off", method: http.MethodPost, path: "/findings/{finding_id}/decisions", roles: managerOnly,
			desc: "Record the human auditor's decision on one finding. Only an audit_manager identity can call this; the auditing agent cannot confirm its own conclusions.",
			fields: []catalogue.Field{
				reqStr("finding_id", "Identifier from get_findings."),
				{Name: "decision", Type: "enum", Required: true, Values: []string{"confirmed", "rejected", "needs_info"}, Description: "The decision."},
				str("note", "Reason for the decision."),
			},
		},
		{
			name: "sign_off_engagement", group: "Sign-off", method: http.MethodPost, path: "/engagements/sign-off", roles: managerOnly,
			desc: "Close the engagement once every finding has a decision. Returns the findings still undecided otherwise.",
			fields: []catalogue.Field{
				fEngagement,
				str("note", "Sign-off note."),
			},
		},
	}
	out := make([]*Tool, 0, len(defs))
	for _, def := range defs {
		out = append(out, def.build(d))
	}
	return out
}

func auditorReadTools(d *Deps) []*Tool {
	return []*Tool{
		{
			Name:        "get_notifications",
			Group:       "Plan",
			Description: "List what the client has sent: sales register uploads, related-party list uploads and evidence uploads. Pass since_seq from the previous call to get only new items. Call it before open_engagement to confirm the register and related-party list have arrived.",
			Roles:       auditRoles,
			Fields: []catalogue.Field{
				integer("since_seq", "Return items after this sequence number. Use next_since_seq from the previous call. Default 0."),
				fLimit,
			},
			Handler: func(ctx context.Context, c *core.Call) (map[string]any, *core.ToolError) {
				since := core.Int(c.Args, "since_seq", 0)
				items, err := d.Store.Notifications(ctx, since, int(core.Int(c.Args, "limit", 100)))
				if err != nil {
					return nil, core.Internal(err)
				}
				next := since
				hasRegister, hasParties := false, false
				for _, n := range items {
					if n.Seq > next {
						next = n.Seq
					}
				}
				all, err := d.Store.Notifications(ctx, 0, 500)
				if err == nil {
					for _, n := range all {
						hasRegister = hasRegister || n.Kind == "sales_register_uploaded"
						hasParties = hasParties || n.Kind == "related_parties_uploaded"
					}
				}
				out := map[string]any{
					"notifications":            items,
					"next_since_seq":           next,
					"sales_register_uploaded":  hasRegister,
					"related_parties_uploaded": hasParties,
				}
				if hasRegister && hasParties {
					out["next_step"] = "Both uploads are present. Call open_engagement, or get_audit_plan if an engagement is already open."
				} else {
					out["next_step"] = "Wait for the client to call upload_sales_register and upload_related_parties, then call open_engagement."
				}
				return out, nil
			},
		},
		{
			Name:        "query_records",
			Group:       "Findings",
			Description: "Read records of one type from the engagement's snapshot, with optional filters. Use it to investigate beyond the detectors, for example every invoice of one customer near the period end. Records created after the snapshot are not returned.",
			Roles:       auditRoles,
			Fields:      append([]catalogue.Field{fEngagement}, filterFields(d, true)...),
			Handler: func(ctx context.Context, c *core.Call) (map[string]any, *core.ToolError) {
				eng, terr := resolveEngagement(ctx, d, c.Args)
				if terr != nil {
					return nil, terr
				}
				f, terr := documentFilter(c.Args, eng.SnapshotSeq)
				if terr != nil {
					return nil, terr
				}
				docs, err := d.Store.ListDocuments(ctx, f)
				if err != nil {
					return nil, core.Internal(err)
				}
				rows, next := listPage(docs, f.Limit)
				return map[string]any{"engagement_id": eng.ID, "snapshot_seq": eng.SnapshotSeq, "records": rows, "next_cursor": next}, nil
			},
		},
		{
			Name:        "get_sale_chain",
			Group:       "Findings",
			Description: "Get every record of one sale in order, from enquiry to settlement and reversal, with ledger postings and which stages are missing. Identify the sale by sale_id, by any document_id of the sale, or by invoice_no.",
			Roles:       auditRoles,
			Fields: []catalogue.Field{
				fEngagement,
				str("sale_id", "Identifier of the sale."),
				str("document_id", "Identifier of any document of the sale."),
				str("invoice_no", "Invoice number as printed on the invoice."),
			},
			Handler: func(ctx context.Context, c *core.Call) (map[string]any, *core.ToolError) {
				eng, terr := resolveEngagement(ctx, d, c.Args)
				if terr != nil {
					return nil, terr
				}
				saleID := core.Str(c.Args, "sale_id")
				if saleID == "" {
					doc, inv := core.Str(c.Args, "document_id"), core.Str(c.Args, "invoice_no")
					if doc == "" && inv == "" {
						return nil, core.Errf(core.CodeValidationFailed, "Pass one of sale_id, document_id or invoice_no.", "No sale was identified.")
					}
					found, err := d.Store.FindSaleID(ctx, doc, inv, eng.SnapshotSeq)
					if err == store.ErrNotFound {
						return nil, core.Errf(core.CodeNotFound, "Use query_records to find the document. A journal or master record belongs to no sale.", "No sale was found for that reference in the snapshot.")
					}
					if err != nil {
						return nil, core.Internal(err)
					}
					saleID = found
				}
				events, err := d.Store.SaleEvents(ctx, saleID, eng.SnapshotSeq)
				if err != nil {
					return nil, core.Internal(err)
				}
				if len(events) == 0 {
					return nil, core.Errf(core.CodeNotFound, "Use query_records to find the sale.", "Sale %s has no records in the snapshot.", saleID)
				}
				postings, err := d.Store.PostingsForSeqs(ctx, seqsOf(events))
				if err != nil {
					return nil, core.Internal(err)
				}
				return map[string]any{
					"engagement_id": eng.ID,
					"snapshot_seq":  eng.SnapshotSeq,
					"sale_id":       saleID,
					"stages":        saleStages(events),
					"events":        eventRows(events, postings),
				}, nil
			},
		},
		{
			Name:        "get_ledger_entries",
			Group:       "Findings",
			Description: "Read double-entry ledger lines from the snapshot by account, date range or sale. Each line names the event type that posted it, so revenue that did not come from an invoice is visible. Pass trial_balance true for totals by account instead of lines.",
			Roles:       auditRoles,
			Fields: []catalogue.Field{
				fEngagement,
				str("account", "Account code, for example 4000 for Sales Revenue or 1100 for Trade Receivables."),
				str("sale_id", "Only lines of this sale."),
				date("date_from", "Only lines dated on or after this date."),
				date("date_to", "Only lines dated on or before this date."),
				boolean("trial_balance", "Return totals by account instead of lines."),
				fLimit,
				fCursor,
			},
			Handler: func(ctx context.Context, c *core.Call) (map[string]any, *core.ToolError) {
				eng, terr := resolveEngagement(ctx, d, c.Args)
				if terr != nil {
					return nil, terr
				}
				if tb, _ := c.Args["trial_balance"].(bool); tb {
					rows, err := d.Store.TrialBalance(ctx, eng.SnapshotSeq, core.Str(c.Args, "date_from"), core.Str(c.Args, "date_to"))
					if err != nil {
						return nil, core.Internal(err)
					}
					return map[string]any{"engagement_id": eng.ID, "snapshot_seq": eng.SnapshotSeq, "accounts": rows}, nil
				}
				f := store.LedgerFilter{
					Account:  core.Str(c.Args, "account"),
					SaleID:   core.Str(c.Args, "sale_id"),
					DateFrom: core.Str(c.Args, "date_from"),
					DateTo:   core.Str(c.Args, "date_to"),
					MaxSeq:   eng.SnapshotSeq,
					Limit:    int(core.Int(c.Args, "limit", 100)),
				}
				if f.Limit <= 0 || f.Limit > 500 {
					f.Limit = 100
				}
				if cur := core.Str(c.Args, "cursor"); cur != "" {
					parts := strings.SplitN(cur, ".", 2)
					seq, err1 := strconv.ParseInt(parts[0], 10, 64)
					line := 0
					var err2 error
					if len(parts) == 2 {
						line, err2 = strconv.Atoi(parts[1])
					}
					if err1 != nil || err2 != nil {
						return nil, core.Errf(core.CodeValidationFailed, "Pass next_cursor from the previous page unchanged.", "cursor is not valid.")
					}
					f.AfterSeq, f.AfterLn = seq, line
				}
				lines, err := d.Store.LedgerEntries(ctx, f)
				if err != nil {
					return nil, core.Internal(err)
				}
				var next any
				if len(lines) == f.Limit {
					last := lines[len(lines)-1]
					next = fmt.Sprintf("%d.%d", last.Seq, last.LineNo)
				}
				return map[string]any{"engagement_id": eng.ID, "snapshot_seq": eng.SnapshotSeq, "entries": lines, "next_cursor": next}, nil
			},
		},
		{
			Name:        "verify_ledger_integrity",
			Group:       "Integrity",
			Description: "Recompute the hash chain of the business ledger and of the audit trail, and compare the hash at the engagement's snapshot with the one stored when the engagement opened. Reports the first altered record if any. A failure is recorded as a finding. Next: get_findings.",
			Roles:       auditRoles,
			Fields:      []catalogue.Field{fEngagement},
			Handler: func(ctx context.Context, c *core.Call) (map[string]any, *core.ToolError) {
				return verifyIntegrity(ctx, d, c)
			},
		},
	}
}

func sharedTools(d *Deps) []*Tool {
	return []*Tool{
		{
			Name:        "get_audit_trail",
			Group:       "Outputs",
			Description: "Read the tamper-evident log of tool calls: who called what, when, and the hashes that chain each entry to the one before. Includes the result of recomputing the chain. An auditor sees every entry; a client sees its own. Pass export true to store the whole trail as a file.",
			Roles:       everyone,
			Fields: []catalogue.Field{
				str("engagement_id", "Only entries of this engagement."),
				str("tool", "Only calls to this tool."),
				str("user", "Only calls by this user."),
				boolean("export", "Store the matching entries as a file and return its file_hash."),
				fLimit,
				fCursor,
			},
			Handler: func(ctx context.Context, c *core.Call) (map[string]any, *core.ToolError) {
				return auditTrail(ctx, d, c)
			},
		},
		{
			Name:  "verify_sampling_seal",
			Group: "Integrity",
			Description: "Check that nobody chose the sampling seed. The seed follows from a secret that was fixed when the register arrived, of which the client received only the hash, and from the frozen ledger. " +
				"Returns the commitment, and once an engagement is open the secret, the seed and the result of recomputing both hashes. A seed supplied by the auditor is reported as chosen. " +
				"With no engagement_id it reports on the latest register upload.",
			Roles:  everyone,
			Fields: []catalogue.Field{str("engagement_id", "Engagement to check. Optional.")},
			Handler: func(ctx context.Context, c *core.Call) (map[string]any, *core.ToolError) {
				args := map[string]any{}
				if id := core.Str(c.Args, "engagement_id"); id != "" {
					args["engagement_id"] = id
				}
				return d.Engine.Do(ctx, c.Identity, "GET", "/sampling/seal", args)
			},
		},
		{
			Name:        "get_merkle_proof",
			Group:       "Integrity",
			Description: "Get the proof that one ledger event belongs to its day's Merkle root. Use it to show that a single record has not been altered without recomputing the whole chain.",
			Roles:       everyone,
			Fields:      []catalogue.Field{{Name: "seq", Type: "int", Required: true, Description: "Sequence number of the event."}},
			Handler: func(ctx context.Context, c *core.Call) (map[string]any, *core.ToolError) {
				return d.Ledger.Proof(ctx, core.Int(c.Args, "seq", 0))
			},
		},
	}
}

func verifyIntegrity(ctx context.Context, d *Deps, c *core.Call) (map[string]any, *core.ToolError) {
	eng, terr := resolveEngagement(ctx, d, c.Args)
	if terr != nil && terr.Code != core.CodeNoEngagement {
		return nil, terr
	}
	var at int64
	if eng != nil {
		at = eng.SnapshotSeq
	}
	business, terr := d.Ledger.Verify(ctx, at)
	if terr != nil {
		return nil, terr
	}
	trail, terr := d.Ledger.TrailVerify(ctx)
	if terr != nil {
		return nil, terr
	}
	ok := truthy(business["ok"]) && truthy(trail["ok"])
	out := map[string]any{"business_chain": business, "trail_chain": trail}
	if eng != nil {
		recomputed := ""
		if atObj, isObj := business["at"].(map[string]any); isObj {
			recomputed, _ = atObj["hash"].(string)
		}
		match := recomputed != "" && recomputed == strings.TrimSpace(eng.SnapshotHash)
		ok = ok && match
		out["engagement_id"] = eng.ID
		out["snapshot"] = map[string]any{
			"seq":             eng.SnapshotSeq,
			"stored_hash":     strings.TrimSpace(eng.SnapshotHash),
			"recomputed_hash": recomputed,
			"match":           match,
		}
		report := map[string]any{
			"engagement_id":  eng.ID,
			"business_chain": business,
			"trail_chain":    trail,
			"snapshot_match": match,
		}
		if res, rerr := d.Engine.Do(ctx, c.Identity, http.MethodPost, "/integrity/report", report); rerr == nil {
			out["findings_created"] = res["findings_created"]
		} else {
			out["warning"] = "The result was not recorded in the engagement because the audit engine did not accept it: " + rerr.Message
		}
	} else {
		out["note"] = "No engagement is open, so there is no snapshot to compare. Both chains were still recomputed."
	}
	out["ok"] = ok
	if ok {
		out["summary"] = "Both chains verify. No record has been altered."
		out["next_step"] = "Call get_findings to review the findings."
	} else {
		out["summary"] = "Integrity check failed. See first_bad_seq in the chain results and the snapshot comparison."
		out["next_step"] = "Call get_findings with category LEDGER_INTEGRITY, and report the failure to the engagement partner."
	}
	return out, nil
}

func truthy(v any) bool {
	b, _ := v.(bool)
	return b
}

func auditTrail(ctx context.Context, d *Deps, c *core.Call) (map[string]any, *core.ToolError) {
	f := store.TrailFilter{
		EngagementID: core.Str(c.Args, "engagement_id"),
		Tool:         core.Str(c.Args, "tool"),
		User:         core.Str(c.Args, "user"),
		Limit:        int(core.Int(c.Args, "limit", 100)),
	}
	// A client sees only its own entries (PRD section 4.2).
	if c.Identity.Role == core.RoleClient {
		f.User = c.Identity.User
	}
	if cur := core.Str(c.Args, "cursor"); cur != "" {
		n, err := strconv.ParseInt(cur, 10, 64)
		if err != nil {
			return nil, core.Errf(core.CodeValidationFailed, "Pass next_cursor from the previous page unchanged.", "cursor is not valid.")
		}
		f.BeforeSeq = n
	}
	verification, terr := d.Ledger.TrailVerify(ctx)
	if terr != nil {
		return nil, terr
	}
	if export, _ := c.Args["export"].(bool); export {
		f.Ascending = true
		f.Limit = 5000
		f.BeforeSeq = 0
		var all []store.TrailEntry
		for {
			page, err := d.Store.Trail(ctx, f)
			if err != nil {
				return nil, core.Internal(err)
			}
			all = append(all, page...)
			if len(page) < f.Limit {
				break
			}
			f.BeforeSeq = page[len(page)-1].TrailSeq
		}
		doc := map[string]any{
			"format":       "audit-trail/1",
			"hashing":      "hash = SHA256(prev_hash || canonical_json(entry)); see contracts/ledger-api.md",
			"filter":       map[string]any{"engagement_id": f.EngagementID, "tool": f.Tool, "user": f.User},
			"verification": verification,
			"entries":      all,
		}
		data, err := json.MarshalIndent(doc, "", "  ")
		if err != nil {
			return nil, core.Internal(err)
		}
		name := "audit-trail.json"
		if f.EngagementID != "" {
			name = "audit-trail-" + f.EngagementID + ".json"
		}
		meta, err := d.Files.Put(ctx, data, name, "application/json")
		if err != nil {
			return nil, core.Internal(err)
		}
		return map[string]any{"file_hash": meta.Hash, "file_name": name, "entries": len(all), "verification": verification}, nil
	}
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 100
	}
	entries, err := d.Store.Trail(ctx, f)
	if err != nil {
		return nil, core.Internal(err)
	}
	var next any
	if len(entries) == f.Limit {
		next = strconv.FormatInt(entries[len(entries)-1].TrailSeq, 10)
	}
	return map[string]any{"entries": entries, "next_cursor": next, "verification": verification}, nil
}
