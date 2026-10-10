package tools

import (
	"bytes"
	"context"
	"encoding/csv"
	"fmt"
	"strconv"

	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/catalogue"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/core"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/store"
)

// recordTypes is filled from the catalogue at build time.
func recordTypeField(d *Deps, required bool) catalogue.Field {
	return catalogue.Field{
		Name:        "type",
		Type:        "enum",
		Required:    required,
		Values:      d.Cat.AggregateTypes(),
		Description: "Kind of record.",
	}
}

func filterFields(d *Deps, typeRequired bool) []catalogue.Field {
	return []catalogue.Field{
		recordTypeField(d, typeRequired),
		str("customer_id", "Only records of this customer."),
		str("vendor_id", "Only records of this vendor."),
		str("sale_id", "Only records of this sale."),
		date("date_from", "Only records dated on or after this date."),
		date("date_to", "Only records dated on or before this date."),
		str("text", "Only records whose data contains this text, for example an invoice number or a name."),
		fLimit,
		fCursor,
	}
}

func documentFilter(args map[string]any, maxSeq int64) (store.DocumentFilter, *core.ToolError) {
	f := store.DocumentFilter{
		AggregateType: core.Str(args, "type"),
		CustomerID:    core.Str(args, "customer_id"),
		VendorID:      core.Str(args, "vendor_id"),
		SaleID:        core.Str(args, "sale_id"),
		DateFrom:      core.Str(args, "date_from"),
		DateTo:        core.Str(args, "date_to"),
		Text:          core.Str(args, "text"),
		MaxSeq:        maxSeq,
		Limit:         int(core.Int(args, "limit", 50)),
	}
	if cur := core.Str(args, "cursor"); cur != "" {
		n, err := strconv.ParseInt(cur, 10, 64)
		if err != nil {
			return f, core.Errf(core.CodeValidationFailed, "Pass next_cursor from the previous page unchanged.", "cursor is not valid.")
		}
		f.AfterSeq = n
	}
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 50
	}
	return f, nil
}

func recordRows(docs []store.Document) []map[string]any {
	rows := make([]map[string]any, 0, len(docs))
	for _, doc := range docs {
		row := map[string]any{
			"id":          doc.AggregateID,
			"type":        doc.AggregateType,
			"seq":         doc.Seq,
			"date":        doc.BusinessDate,
			"sale_id":     doc.SaleID,
			"reversed":    doc.ReversedSeq != nil,
			"recorded_at": doc.RecordedAt,
			"recorded_by": doc.IdentityUser,
			"data":        doc.Payload,
		}
		rows = append(rows, row)
	}
	return rows
}

func listPage(docs []store.Document, limit int) (rows []map[string]any, next any) {
	rows = recordRows(docs)
	if len(docs) == limit && limit > 0 {
		next = strconv.FormatInt(docs[len(docs)-1].Seq, 10)
	}
	return rows, next
}

func eventRows(events []store.Event, postings map[int64][]store.Posting) []map[string]any {
	rows := make([]map[string]any, 0, len(events))
	for _, e := range events {
		row := map[string]any{
			"seq":         e.Seq,
			"event":       e.EventType,
			"type":        e.AggregateType,
			"id":          e.AggregateID,
			"version":     e.AggregateVersion,
			"date":        e.BusinessDate,
			"recorded_at": e.RecordedAt,
			"recorded_by": e.IdentityUser,
			"data":        e.Payload,
			"hash":        e.Hash,
		}
		if p := postings[e.Seq]; len(p) > 0 {
			lines := make([]map[string]any, 0, len(p))
			for _, l := range p {
				lines = append(lines, map[string]any{"account_code": l.AccountCode, "account_name": l.AccountName, "debit": l.Debit, "credit": l.Credit})
			}
			row["postings"] = lines
		}
		rows = append(rows, row)
	}
	return rows
}

func seqsOf(events []store.Event) []int64 {
	out := make([]int64, len(events))
	for i, e := range events {
		out[i] = e.Seq
	}
	return out
}

// saleStages reports which stages of a sale have a record (PRD section 6.5).
func saleStages(events []store.Event) map[string]any {
	stage := map[string]string{
		"EnquiryRecorded": "enquiry", "SalesOrderCreated": "order", "DispatchRecorded": "dispatch",
		"EWayBillGenerated": "eway_bill", "LorryReceiptRecorded": "lorry_receipt", "DeliveryRecorded": "delivery",
		"InvoiceIssued": "invoice", "ReceiptRecorded": "receipt", "CreditNoteIssued": "credit_note",
		"SalesReturnRecorded": "sales_return", "DocumentReversed": "reversal",
	}
	out := map[string]any{}
	for _, name := range []string{"enquiry", "order", "dispatch", "eway_bill", "lorry_receipt", "delivery", "invoice", "receipt", "credit_note", "sales_return", "reversal"} {
		out[name] = false
	}
	for _, e := range events {
		if s, ok := stage[e.EventType]; ok {
			out[s] = true
		}
	}
	return out
}

func clientReadTools(d *Deps) []*Tool {
	return []*Tool{
		{
			Name:        "list_records",
			Group:       "Read",
			Description: "List current business records of one type, with optional filters. Use it to find identifiers for other tools. Returns one page; pass next_cursor to continue.",
			Roles:       clientOnly,
			Fields:      filterFields(d, true),
			Handler: func(ctx context.Context, c *core.Call) (map[string]any, *core.ToolError) {
				f, terr := documentFilter(c.Args, 0)
				if terr != nil {
					return nil, terr
				}
				docs, err := d.Store.ListDocuments(ctx, f)
				if err != nil {
					return nil, core.Internal(err)
				}
				rows, next := listPage(docs, f.Limit)
				return map[string]any{"records": rows, "next_cursor": next}, nil
			},
		},
		{
			Name:        "get_record",
			Group:       "Read",
			Description: "Get one business record by identifier, with every version, its ledger postings and whether it is reversed.",
			Roles:       clientOnly,
			Fields:      []catalogue.Field{reqStr("id", "Identifier of the record, for example inv_3fa9c1d2e4b70a15.")},
			Handler: func(ctx context.Context, c *core.Call) (map[string]any, *core.ToolError) {
				return getRecord(ctx, d, core.Str(c.Args, "id"), 0)
			},
		},
		{
			Name:        "export_sales_register",
			Group:       "Read",
			Description: "Produce the sales register for a period from the current records, in the client's column layout, and store it. Returns file_hash. Next: call upload_sales_register with that file_hash.",
			Roles:       clientOnly,
			Fields: []catalogue.Field{
				reqDate("period_start", "First day of the period."),
				reqDate("period_end", "Last day of the period."),
				fEntity,
			},
			Handler: func(ctx context.Context, c *core.Call) (map[string]any, *core.ToolError) {
				return exportRegister(ctx, d, c)
			},
		},
		{
			Name:        "get_trial_balance",
			Group:       "Read",
			Description: "Get debit and credit totals by ledger account from the current ledger, optionally for a date range.",
			Roles:       clientOnly,
			Fields: []catalogue.Field{
				date("date_from", "Only postings dated on or after this date."),
				date("date_to", "Only postings dated on or before this date."),
			},
			Handler: func(ctx context.Context, c *core.Call) (map[string]any, *core.ToolError) {
				rows, err := d.Store.TrialBalance(ctx, 0, core.Str(c.Args, "date_from"), core.Str(c.Args, "date_to"))
				if err != nil {
					return nil, core.Internal(err)
				}
				return map[string]any{"accounts": rows}, nil
			},
		},
		{
			Name:        "list_evidence_requests",
			Group:       "Audit support",
			Description: "List the supporting documents the auditor has requested for its samples, and whether each has been uploaded. Call this after the auditor selects samples. Next: upload_evidence for each pending request.",
			Roles:       clientOnly,
			Fields: []catalogue.Field{
				enum("status", "Only requests in this state.", "pending", "received"),
				fLimit,
				fCursor,
			},
			Handler: func(ctx context.Context, c *core.Call) (map[string]any, *core.ToolError) {
				return d.Engine.Do(ctx, c.Identity, "GET", "/evidence/requests", c.Args)
			},
		},
	}
}

func getRecord(ctx context.Context, d *Deps, id string, maxSeq int64) (map[string]any, *core.ToolError) {
	events, err := d.Store.AggregateEvents(ctx, id, maxSeq)
	if err != nil {
		return nil, core.Internal(err)
	}
	if len(events) == 0 {
		return nil, core.Errf(core.CodeNotFound, "Use list_records or query_records to find the identifier.", "%s does not exist.", id)
	}
	postings, err := d.Store.PostingsForSeqs(ctx, seqsOf(events))
	if err != nil {
		return nil, core.Internal(err)
	}
	last := events[len(events)-1]
	reversed := false
	// The current data of a master record is every version merged in order.
	current := map[string]any{}
	for _, e := range events {
		if e.EventType == "DocumentReversed" {
			reversed = true
			continue
		}
		for k, v := range e.Payload {
			current[k] = v
		}
	}
	return map[string]any{
		"id":       id,
		"type":     last.AggregateType,
		"version":  last.AggregateVersion,
		"sale_id":  events[0].SaleID,
		"reversed": reversed,
		"data":     current,
		"history":  eventRows(events, postings),
	}, nil
}

// registerHeader is the client's column layout (PRD section 10.2).
var registerHeader = []string{
	"Bill no.", "Date", "Job No.", "Customer", "Ledger Account", "State Code", "GST No.",
	"Total Cost", "Discount", "Packing", "Freight", "Insurance", "IGST", "CGST", "SGST",
	"TCS Collection", "Round", "Gross Amt.", "Tax", "BU", "E Invoice",
}

func rupees(paise int64) string {
	return strconv.FormatFloat(float64(paise)/100, 'f', 2, 64)
}

func exportRegister(ctx context.Context, d *Deps, c *core.Call) (map[string]any, *core.ToolError) {
	from, to := core.Str(c.Args, "period_start"), core.Str(c.Args, "period_end")
	if to < from {
		return nil, core.Errf(core.CodeValidationFailed, "Swap the dates.", "period_end is before period_start.")
	}
	entity := core.Str(c.Args, "entity_id")
	if entity == "" {
		entity = d.DefaultEntity
	}
	rows, err := d.Store.RegisterRows(ctx, entity, from, to)
	if err != nil {
		return nil, core.Internal(err)
	}
	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	_ = w.Write(registerHeader)
	for _, r := range rows {
		tax := ""
		if r.TaxRate != nil {
			kind := "CGST/SGST"
			if r.IGST > 0 {
				kind = "IGST"
			}
			tax = fmt.Sprintf("%s %s%%", kind, strconv.FormatFloat(*r.TaxRate, 'f', -1, 64))
		}
		_ = w.Write([]string{
			r.InvoiceNo, r.Date, r.JobNo, r.Customer, r.LedgerAccount, r.StateCode, r.GSTIN,
			rupees(r.Taxable), rupees(r.Discount), rupees(r.Packing), rupees(r.Freight), rupees(r.Insurance),
			rupees(r.IGST), rupees(r.CGST), rupees(r.SGST), rupees(r.TCS), rupees(r.RoundOff), rupees(r.Gross),
			tax, r.BusinessUnit, r.EInvoice,
		})
	}
	w.Flush()
	if err := w.Error(); err != nil {
		return nil, core.Internal(err)
	}
	name := fmt.Sprintf("sales-register-%s-to-%s.csv", from, to)
	meta, err := d.Files.Put(ctx, buf.Bytes(), name, "text/csv")
	if err != nil {
		return nil, core.Internal(err)
	}
	return map[string]any{
		"file_hash":    meta.Hash,
		"file_name":    name,
		"row_count":    len(rows),
		"period_start": from,
		"period_end":   to,
		"next_step":    "Call upload_sales_register with this file_hash, file_name, period_start and period_end.",
	}, nil
}
