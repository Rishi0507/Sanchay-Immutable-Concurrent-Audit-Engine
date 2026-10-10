package tools

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/csv"
	"mime"
	"path/filepath"
	"strings"

	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/catalogue"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/core"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/files"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/ledger"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/store"
)

// toolGroups places each catalogue tool in a UI and documentation group
// (PRD section 9.3).
var toolGroups = map[string]string{
	"create_customer": "Parties", "update_customer": "Parties", "create_vendor": "Parties",
	"update_vendor": "Parties", "record_company_officer": "Parties",
	"set_price": "Pricing and promotions", "create_promotion": "Pricing and promotions",
	"record_enquiry": "Sale", "create_sales_order": "Sale", "record_dispatch": "Sale",
	"generate_eway_bill": "Sale", "record_lr": "Sale", "record_delivery": "Sale", "issue_invoice": "Sale",
	"file_gstr1":     "Tax",
	"record_receipt": "Settlement", "import_bank_statement": "Settlement",
	"issue_credit_note": "Reversal", "record_sales_return": "Reversal", "reverse_document": "Reversal",
	"record_purchase_invoice": "Purchases", "record_goods_receipt": "Purchases", "record_payment": "Purchases",
	"post_journal":          "General ledger",
	"upload_sales_register": "Audit support", "upload_related_parties": "Audit support", "upload_evidence": "Audit support",
}

// nextSteps tells the agent what usually follows a successful call.
var nextSteps = map[string]string{
	"create_customer":         "Record the sale: record_enquiry, then create_sales_order.",
	"record_enquiry":          "Call create_sales_order with this enquiry_id.",
	"create_sales_order":      "Call record_dispatch with this order_id when goods leave.",
	"record_dispatch":         "Call generate_eway_bill and record_lr, then record_delivery.",
	"record_delivery":         "Call issue_invoice if the invoice is not yet issued.",
	"issue_invoice":           "Include the invoice in file_gstr1 for its period, and call record_receipt when paid.",
	"issue_credit_note":       "Call record_sales_return with this credit_note_id if goods came back.",
	"upload_sales_register":   "Call upload_related_parties if the related-party list is not yet uploaded. The auditor has been notified.",
	"upload_related_parties":  "The auditor has been notified. Call list_evidence_requests later to see the samples the auditor selects.",
	"upload_evidence":         "Call list_evidence_requests to see what is still outstanding.",
	"record_purchase_invoice": "Call record_goods_receipt and record_payment for this purchase.",
}

// fileTools take a file by hash or inline, in addition to their payload.
var fileTools = map[string]bool{
	"upload_sales_register": true, "upload_related_parties": true, "upload_evidence": true,
}

func clientEventTools(d *Deps) []*Tool {
	var out []*Tool
	for i := range d.Cat.Events {
		ev := &d.Cat.Events[i]
		out = append(out, eventTool(d, ev))
	}
	return out
}

func eventTool(d *Deps, ev *catalogue.Event) *Tool {
	t := &Tool{
		Name:        ev.Tool,
		Group:       toolGroups[ev.Tool],
		Description: ev.Description,
		Roles:       clientOnly,
		Write:       true,
	}
	fields := append([]catalogue.Field{}, ev.Fields...)
	if fileTools[ev.Tool] {
		for i := range fields {
			if fields[i].Name == "file_hash" {
				fields[i].Required = false
				fields[i].Description = "SHA-256 of a file already stored, as returned by export_sales_register or by POST /api/files. Give this or content_base64."
			}
		}
		fields = append(fields, str("content_base64", "The file content in base64. Give this or file_hash. Use file_hash for large files."))
		t.Notify = NotifyAuditor
	}
	switch ev.Mode {
	case "update":
		idField := ev.Aggregate + "_id"
		fields = append([]catalogue.Field{reqStr(idField, "Identifier of the "+ev.Aggregate+" to change.")}, fields...)
		fields = append(fields, integer("expected_version", "Version the caller last read. Optional; the current version is used when omitted."))
	case "reverse":
		fields = append([]catalogue.Field{reqStr("document_id", "Identifier of the document to reverse.")}, fields...)
		fields = append(fields, integer("expected_version", "Version the caller last read. Optional; the current version is used when omitted."))
	}
	fields = append(fields, fIdemKey)
	if ev.Mode == "create" {
		fields = append(fields, fEntity)
	}
	t.Fields = fields
	t.Handler = func(ctx context.Context, c *core.Call) (map[string]any, *core.ToolError) {
		return appendEvent(ctx, d, ev, c)
	}
	return t
}

var controlKeys = map[string]bool{
	"idempotency_key": true, "entity_id": true, "expected_version": true, "document_id": true, "content_base64": true,
}

func appendEvent(ctx context.Context, d *Deps, ev *catalogue.Event, c *core.Call) (map[string]any, *core.ToolError) {
	key := core.Str(c.Args, "idempotency_key")
	payload := map[string]any{}
	for k, v := range c.Args {
		if !controlKeys[k] {
			payload[k] = v
		}
	}
	if declines(ev, c.Args) {
		// The client states that the document does not exist. There is no file to store.
		if core.Str(c.Args, "file_hash") != "" || core.Str(c.Args, "content_base64") != "" {
			return nil, core.Errf(core.CodeValidationFailed, "Send the file, or set not_available with a note. Not both.", "A file was sent together with not_available.")
		}
		delete(payload, "file_name")
	} else if fileTools[ev.Tool] {
		if terr := resolveFile(ctx, d, ev, c.Args, payload); terr != nil {
			return nil, terr
		}
	}

	req := &ledger.AppendRequest{
		EventType:      ev.Type,
		Identity:       c.Identity,
		IdempotencyKey: key,
		Payload:        payload,
		RecordedAt:     core.SimTime(ctx),
	}
	idField := ev.Aggregate + "_id"

	switch ev.Mode {
	case "create":
		req.AggregateType = ev.Aggregate
		req.AggregateID = ev.Prefix + "_" + core.ShortHash(ev.Tool+"|"+key, 16)
		req.EntityID = core.Str(c.Args, "entity_id")
		if req.EntityID == "" {
			req.EntityID = d.DefaultEntity
		}
		req.SaleID = resolveSale(ctx, d, ev, payload, key)
	case "update", "reverse":
		target := core.Str(c.Args, idField)
		if ev.Mode == "reverse" {
			target = core.Str(c.Args, "document_id")
			idField = "document_id"
		}
		delete(payload, idField)
		agg, err := d.Store.AggregateInfo(ctx, target)
		if err == store.ErrNotFound {
			return nil, core.Errf(core.CodeUnknownReference, "Use list_records to find the identifier.", "%s does not exist.", target)
		}
		if err != nil {
			return nil, core.Internal(err)
		}
		if ev.Mode == "update" && agg.Type != ev.Aggregate {
			return nil, core.Errf(core.CodeValidationFailed, "Pass the identifier of a "+ev.Aggregate+".", "%s is a %s, not a %s.", target, agg.Type, ev.Aggregate)
		}
		req.AggregateType = agg.Type
		req.AggregateID = target
		req.EntityID = agg.EntityID
		req.SaleID = agg.SaleID
		req.ExpectedVersion = core.Int(c.Args, "expected_version", agg.Version)
		if ev.Mode == "reverse" {
			payload["target_id"] = target
			payload["target_type"] = agg.Type
		}
	}

	if ev.BusinessDate != "" {
		if dpart := catalogue.DatePart(payload[ev.BusinessDate]); dpart != "" {
			req.BusinessDate = &dpart
		}
	}

	res, terr := d.Ledger.Append(ctx, req)
	if terr != nil {
		return nil, terr
	}
	out := map[string]any{
		idField:     req.AggregateID,
		"seq":       res.Seq,
		"hash":      res.Hash,
		"version":   res.AggregateVersion,
		"duplicate": res.Duplicate,
	}
	if req.SaleID != nil {
		out["sale_id"] = *req.SaleID
	}
	if h, ok := payload["file_hash"].(string); ok {
		out["file_hash"] = h
	}
	if next := nextSteps[ev.Tool]; next != "" {
		out["next_step"] = next
	}
	if ev.Tool == "upload_sales_register" {
		sealSampling(ctx, d, c.Identity, res.Seq, out)
	}
	return out, nil
}

// declines reports whether an evidence request is answered with "no such
// document" instead of a file.
func declines(ev *catalogue.Event, args map[string]any) bool {
	no, _ := args["not_available"].(bool)
	return ev.Tool == "upload_evidence" && no
}

// sealSampling has the engine fix the secret behind the sampling seed as the
// register arrives, and hands its hash to the client in the upload result. The
// client then holds proof that the seed was settled before the auditor saw the
// register. If the engine is unreachable the upload still stands, and the seal
// is made when the engagement opens.
func sealSampling(ctx context.Context, d *Deps, id core.Identity, seq int64, out map[string]any) {
	seal, terr := d.Engine.Do(ctx, id, "POST", "/sampling/seal", map[string]any{"upload_seq": seq})
	if terr != nil {
		return
	}
	out["sampling_commitment"] = seal["commitment"]
	out["sampling_note"] = "The auditor's sampling seed is sealed. Keep sampling_commitment: after the engagement opens, verify_sampling_seal shows the secret, and its SHA-256 must equal this value."
}

// resolveSale links the event to a sale according to the catalogue rule.
func resolveSale(ctx context.Context, d *Deps, ev *catalogue.Event, payload map[string]any, key string) *string {
	fresh := func() *string {
		s := "sale_" + core.ShortHash("sale|"+ev.Tool+"|"+key, 16)
		return &s
	}
	switch ev.Sale {
	case "new":
		return fresh()
	case "inherit", "inherit_or_new":
		for _, f := range ev.RefFields() {
			var ids []string
			switch v := payload[f.Name].(type) {
			case string:
				ids = []string{v}
			case []any:
				for _, item := range v {
					if s, ok := item.(string); ok {
						ids = append(ids, s)
					}
				}
			}
			for _, id := range ids {
				if agg, err := d.Store.AggregateInfo(ctx, id); err == nil && agg.SaleID != nil {
					return agg.SaleID
				}
			}
		}
		if ev.Sale == "inherit_or_new" {
			return fresh()
		}
	}
	return nil
}

// resolveFile stores inline content, or checks that a quoted hash exists.
func resolveFile(ctx context.Context, d *Deps, ev *catalogue.Event, args, payload map[string]any) *core.ToolError {
	name := core.Str(args, "file_name")
	if b64 := core.Str(args, "content_base64"); b64 != "" {
		data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
		if err != nil {
			return core.Errf(core.CodeValidationFailed, "Send standard base64, or upload the file with POST /api/files and pass file_hash.", "content_base64 is not valid base64.")
		}
		if name == "" {
			name = ev.Aggregate
		}
		meta, err := d.Files.Put(ctx, data, name, contentTypeFor(name))
		if err != nil {
			return core.Internal(err)
		}
		payload["file_hash"] = meta.Hash
		payload["file_name"] = name
		if ev.Tool == "upload_sales_register" {
			if _, ok := payload["row_count"]; !ok {
				if n := countCSVRows(name, data); n >= 0 {
					payload["row_count"] = n
				}
			}
		}
		return nil
	}
	hash := core.Str(args, "file_hash")
	if hash == "" {
		if ev.Tool == "upload_related_parties" {
			return nil
		}
		return core.Errf(core.CodeValidationFailed, "Pass file_hash from export_sales_register or POST /api/files, or pass content_base64.", "A file is required: give file_hash or content_base64.")
	}
	meta, err := d.Files.Stat(ctx, hash)
	if err == files.ErrNotFound {
		return core.Errf(core.CodeNotFound, "Store the file first with POST /api/files or export_sales_register, or pass content_base64.", "No stored file has hash %s.", hash)
	}
	if err != nil {
		return core.Internal(err)
	}
	if name == "" && meta.Name != "" {
		payload["file_name"] = meta.Name
	}
	if ev.Tool == "upload_sales_register" {
		if _, ok := payload["row_count"]; !ok {
			if data, m, err := d.Files.Get(ctx, hash); err == nil {
				if n := countCSVRows(m.Name, data); n >= 0 {
					payload["row_count"] = n
				}
			}
		}
	}
	if _, ok := payload["file_name"]; !ok {
		payload["file_name"] = ev.Aggregate
	}
	return nil
}

func contentTypeFor(name string) string {
	if ct := mime.TypeByExtension(strings.ToLower(filepath.Ext(name))); ct != "" {
		return ct
	}
	switch strings.ToLower(filepath.Ext(name)) {
	case ".xlsx":
		return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	case ".csv":
		return "text/csv"
	case ".pdf":
		return "application/pdf"
	}
	return "application/octet-stream"
}

// countCSVRows returns the number of data rows of a CSV file, or -1 when the
// file is not CSV.
func countCSVRows(name string, data []byte) int {
	if !strings.HasSuffix(strings.ToLower(name), ".csv") {
		return -1
	}
	r := csv.NewReader(bytes.NewReader(data))
	r.FieldsPerRecord = -1
	rows, err := r.ReadAll()
	if err != nil || len(rows) == 0 {
		return -1
	}
	return len(rows) - 1
}
