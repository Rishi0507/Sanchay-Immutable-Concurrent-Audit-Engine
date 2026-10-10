// Command mockengine is a stand-in for the audit engine. It answers every
// endpoint of contracts/engine-api.md with simple, deterministic results so
// the MCP server and the UI can be run before the real engine exists.
//
// It is a development aid only. It performs no real detection, sampling or
// evidence testing, and it keeps its state in memory. The real engine in
// engine/ replaces it.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

type apiError struct {
	status int
	Code   string `json:"code"`
	Msg    string `json:"message"`
	Next   string `json:"next_step,omitempty"`
}

func (e *apiError) Error() string { return e.Msg }

type sample struct {
	ID        string            `json:"sample_id"`
	Sheet     string            `json:"sheet"`
	Position  int               `json:"position"`
	Subject   string            `json:"subject_id"`
	SubjType  string            `json:"subject_type"`
	SaleID    *string           `json:"sale_id"`
	InvoiceNo string            `json:"invoice_no,omitempty"`
	CNNo      string            `json:"credit_note_no,omitempty"`
	Date      string            `json:"date"`
	Customer  string            `json:"customer"`
	Related   string            `json:"related"`
	Taxable   int64             `json:"taxable_value"`
	Codes     []string          `json:"reason_codes"`
	Reason    string            `json:"reason"`
	Tests     map[string]string `json:"tests"`
	Findings  []string          `json:"finding_ids"`
}

type finding map[string]any

type engagement struct {
	ID, PeriodStart, PeriodEnd, Seed, SnapshotHash, OpenedBy, OpenedAt string
	SnapshotSeq                                                        int64
	steps                                                              map[string]bool
	register                                                           []map[string]any
	columns                                                            []string
	samples                                                            map[string][]*sample
	requests                                                           []map[string]any
	findings                                                           map[string]finding
	order                                                              []string
	signedOff                                                          bool
}

type server struct {
	mu          sync.Mutex
	db          *pgxpool.Pool
	ledgerURL   string
	token       string
	filesDir    string
	engagements map[string]*engagement
}

var planSteps = []struct{ step, tool, purpose string }{
	{"open", "open_engagement", "Freeze the snapshot."},
	{"import", "import_register", "Carry the register into the workpaper."},
	{"reconcile", "reconcile_register", "Compare register and system of record."},
	{"tag", "tag_related_parties", "Tag related parties."},
	{"detect", "run_detectors", "Run population-level detectors."},
	{"sales_tod", "select_sales_tod", "Select Sales TOD samples."},
	{"cutoff_tod", "select_cutoff_tod", "Select cut-off samples."},
	{"credit_note_tod", "select_credit_note_tod", "Select credit note samples."},
	{"verify", "verify_evidence", "Test uploaded evidence."},
	{"changes", "check_post_testing_changes", "Detect client changes after the snapshot."},
	{"integrity", "verify_ledger_integrity", "Recompute the hash chains."},
	{"memo", "draft_findings_memo", "Produce the findings memo."},
	{"workpaper", "export_workpaper", "Produce the workpaper."},
}

func short(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "|")))
	return hex.EncodeToString(sum[:])[:16]
}

func main() {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, env("DATABASE_URL", "postgres://engine_audit:engine_audit@localhost:5432/audit"))
	if err != nil {
		log.Fatal(err)
	}
	s := &server{
		db:          pool,
		ledgerURL:   env("LEDGER_URL", "http://localhost:7001"),
		token:       env("SERVICE_TOKEN", "dev-service-token"),
		filesDir:    env("FILES_DIR", "./data/files"),
		engagements: map[string]*engagement{},
	}
	if err := s.restore(ctx); err != nil {
		log.Printf("restore: %v", err)
	}
	mux := http.NewServeMux()
	route := func(pattern string, h func(r *http.Request, args map[string]any) (any, error)) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			args := map[string]any{}
			if r.Method == http.MethodGet {
				for k, v := range r.URL.Query() {
					args[k] = v[0]
				}
			} else {
				_ = json.NewDecoder(r.Body).Decode(&args)
			}
			s.mu.Lock()
			out, err := h(r, args)
			s.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			if err != nil {
				ae, ok := err.(*apiError)
				if !ok {
					ae = &apiError{status: 500, Code: "INTERNAL_ERROR", Msg: err.Error()}
				}
				w.WriteHeader(ae.status)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": ae})
				return
			}
			_ = json.NewEncoder(w).Encode(out)
		})
	}

	route("GET /health", func(*http.Request, map[string]any) (any, error) {
		return map[string]any{"status": "ok", "mock": true}, nil
	})
	route("POST /engagements", s.open)
	route("GET /engagements", s.list)
	route("GET /engagements/status", s.status)
	route("GET /plan", s.plan)
	route("POST /register/import", s.importRegister)
	route("POST /register/reconcile", s.reconcile)
	route("GET /register/rows", s.registerRows)
	route("POST /related-parties/tag", s.tag)
	route("POST /detectors/run", s.detect)
	route("POST /samples/sales", s.selectSheet("sales_tod"))
	route("POST /samples/cutoff", s.selectSheet("cutoff_tod"))
	route("POST /samples/credit-notes", s.selectSheet("credit_note_tod"))
	route("GET /samples", s.samples)
	route("GET /evidence/status", s.evidenceStatus)
	route("GET /evidence/requests", s.evidenceRequests)
	route("POST /evidence/requests", s.requestEvidence)
	route("POST /evidence/verify", s.verify)
	route("POST /changes/check", s.changes)
	route("GET /findings", s.findings)
	route("GET /findings/{id}/explain", s.explain)
	route("POST /findings/{id}/decisions", s.decide)
	route("POST /engagements/sign-off", s.signOff)
	route("GET /graph", s.graph)
	route("POST /memo", s.memo)
	route("POST /workpaper", s.workpaper)
	route("POST /integrity/report", s.integrity)

	addr := env("ENGINE_ADDR", ":7002")
	log.Printf("mock audit engine on %s (stand-in, no real detection)", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

// restore reloads engagements that an earlier run stored in the database.
func (s *server) restore(ctx context.Context) error {
	rows, err := s.db.Query(ctx, `SELECT engagement_id, period_start::text, period_end::text, seed, snapshot_seq,
		snapshot_hash, opened_by, to_char(opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM audit.engagements`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		e := newEngagement()
		if err := rows.Scan(&e.ID, &e.PeriodStart, &e.PeriodEnd, &e.Seed, &e.SnapshotSeq, &e.SnapshotHash, &e.OpenedBy, &e.OpenedAt); err != nil {
			return err
		}
		e.SnapshotHash = strings.TrimSpace(e.SnapshotHash)
		s.engagements[e.ID] = e
	}
	return rows.Err()
}

func newEngagement() *engagement {
	return &engagement{steps: map[string]bool{"open": true}, samples: map[string][]*sample{}, findings: map[string]finding{}}
}

func (s *server) pick(args map[string]any) (*engagement, error) {
	if id, _ := args["engagement_id"].(string); id != "" {
		if e, ok := s.engagements[id]; ok {
			return e, nil
		}
		return nil, &apiError{status: 404, Code: "NOT_FOUND", Msg: "Engagement " + id + " does not exist."}
	}
	var open []*engagement
	for _, e := range s.engagements {
		if !e.signedOff {
			open = append(open, e)
		}
	}
	if len(open) == 1 {
		return open[0], nil
	}
	if len(open) == 0 {
		return nil, &apiError{status: 409, Code: "NO_ENGAGEMENT", Msg: "No engagement is open.", Next: "Call open_engagement with period_start and period_end."}
	}
	return nil, &apiError{status: 409, Code: "NO_ENGAGEMENT", Msg: "More than one engagement is open.", Next: "Pass engagement_id."}
}

func (s *server) open(r *http.Request, args map[string]any) (any, error) {
	ctx := r.Context()
	start, _ := args["period_start"].(string)
	end, _ := args["period_end"].(string)
	if start == "" || end == "" {
		return nil, &apiError{status: 400, Code: "VALIDATION_FAILED", Msg: "period_start and period_end are required."}
	}
	var uploads int
	if err := s.db.QueryRow(ctx, `SELECT count(DISTINCT event_type) FROM business.events
		WHERE event_type IN ('SalesRegisterUploaded', 'RelatedPartyListUploaded')`).Scan(&uploads); err != nil {
		return nil, err
	}
	if uploads < 2 {
		return nil, &apiError{status: 409, Code: "VALIDATION_FAILED", Msg: "The sales register and the related-party list must both be uploaded first.", Next: "Ask the client to call upload_sales_register and upload_related_parties."}
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, s.ledgerURL+"/head", nil)
	req.Header.Set("X-Service-Token", s.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var head struct {
		Seq  int64  `json:"seq"`
		Hash string `json:"hash"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&head); err != nil {
		return nil, err
	}
	e := newEngagement()
	e.PeriodStart, e.PeriodEnd = start, end
	e.Seed, _ = args["seed"].(string)
	if e.Seed == "" {
		e.Seed = short("seed", head.Hash, start, end)
	}
	e.SnapshotSeq, e.SnapshotHash = head.Seq, head.Hash
	e.OpenedBy = r.Header.Get("X-Identity-User")
	e.OpenedAt = time.Now().UTC().Format(time.RFC3339)
	e.ID = "eng_" + short(start, end, e.Seed, strconv.FormatInt(head.Seq, 10))
	if _, err := s.db.Exec(ctx, `INSERT INTO audit.engagements (engagement_id, entity_ids, period_start, period_end, seed,
		snapshot_seq, snapshot_hash, opened_by) VALUES ($1, $2, $3::date, $4::date, $5, $6, $7, $8)
		ON CONFLICT (engagement_id) DO NOTHING`, e.ID, []string{"E1"}, start, end, e.Seed, e.SnapshotSeq, e.SnapshotHash, e.OpenedBy); err != nil {
		return nil, err
	}
	if existing, ok := s.engagements[e.ID]; ok {
		e = existing
	} else {
		s.engagements[e.ID] = e
	}
	return e.header(), nil
}

func (e *engagement) header() map[string]any {
	return map[string]any{
		"engagement_id": e.ID, "period_start": e.PeriodStart, "period_end": e.PeriodEnd, "seed": e.Seed,
		"snapshot_seq": e.SnapshotSeq, "snapshot_hash": e.SnapshotHash, "merkle_root": nil,
		"opened_by": e.OpenedBy, "opened_at": e.OpenedAt, "signed_off": e.signedOff,
	}
}

func (s *server) list(*http.Request, map[string]any) (any, error) {
	out := []map[string]any{}
	for _, e := range s.engagements {
		out = append(out, e.header())
	}
	return map[string]any{"engagements": out}, nil
}

func (e *engagement) planSteps() ([]map[string]any, string) {
	var steps []map[string]any
	next := ""
	for _, p := range planSteps {
		status := "ready"
		if e.steps[p.step] {
			status = "done"
		} else if next == "" {
			next = p.tool
		}
		steps = append(steps, map[string]any{"step": p.step, "tool": p.tool, "purpose": p.purpose, "status": status})
	}
	return steps, next
}

func (s *server) plan(_ *http.Request, args map[string]any) (any, error) {
	e, err := s.pick(args)
	if err != nil {
		if ae, ok := err.(*apiError); ok && ae.Code == "NO_ENGAGEMENT" {
			var steps []map[string]any
			for i, p := range planSteps {
				status := "blocked"
				if i == 0 {
					status = "ready"
				}
				steps = append(steps, map[string]any{"step": p.step, "tool": p.tool, "purpose": p.purpose, "status": status})
			}
			return map[string]any{"steps": steps, "next_tool": "open_engagement"}, nil
		}
		return nil, err
	}
	steps, next := e.planSteps()
	return map[string]any{"engagement_id": e.ID, "steps": steps, "next_tool": next}, nil
}

func (s *server) status(_ *http.Request, args map[string]any) (any, error) {
	e, err := s.pick(args)
	if err != nil {
		return nil, err
	}
	out := e.header()
	steps, next := e.planSteps()
	bySeverity := map[string]int{"High": 0, "Medium": 0, "Low": 0}
	for _, f := range e.findings {
		bySeverity[f["severity"].(string)]++
	}
	bySheet := map[string]int{}
	for sheet, list := range e.samples {
		bySheet[sheet] = len(list)
	}
	pending := 0
	for _, r := range s.withStatus(context.Background(), e) {
		if r["status"] == "pending" {
			pending++
		}
	}
	out["steps"], out["next_tool"] = steps, next
	out["counts"] = map[string]any{"findings_by_severity": bySeverity, "samples_by_sheet": bySheet, "evidence_pending": pending}
	return out, nil
}

var registerColumns = []string{"Bill no.", "Date", "Customer", "State Code", "GST No.", "Total Cost", "IGST", "CGST", "SGST", "Gross Amt."}

func rupees(p int64) string { return strconv.FormatFloat(float64(p)/100, 'f', 2, 64) }

// importRegister stands in for reading the uploaded file: it lays out the
// invoices of the snapshot as register rows.
func (s *server) importRegister(r *http.Request, args map[string]any) (any, error) {
	e, err := s.pick(args)
	if err != nil {
		return nil, err
	}
	if e.register == nil {
		rows, err := s.db.Query(r.Context(), `SELECT i.invoice_id, i.invoice_no, to_char(i.date, 'DD-MM-YYYY'),
			coalesce(c.payload->>'name', ''), coalesce(i.place_of_supply, ''), coalesce(i.customer_gstin, c.payload->>'gstin', ''),
			i.taxable_value, i.igst, i.cgst, i.sgst, i.gross
			FROM business.v_invoices i LEFT JOIN business.events c ON c.aggregate_id = i.customer_id AND c.aggregate_version = 1
			WHERE i.seq <= $1 AND i.date BETWEEN $2::date AND $3::date ORDER BY i.date, i.invoice_no`, e.SnapshotSeq, e.PeriodStart, e.PeriodEnd)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		e.register = []map[string]any{}
		for rows.Next() {
			var id, no, date, customer, state, gstin string
			var taxable, igst, cgst, sgst, gross int64
			if err := rows.Scan(&id, &no, &date, &customer, &state, &gstin, &taxable, &igst, &cgst, &sgst, &gross); err != nil {
				return nil, err
			}
			e.register = append(e.register, map[string]any{
				"row_no": len(e.register) + 1, "invoice_id": id, "finding_ids": []string{},
				"raw": map[string]any{"Bill no.": no, "Date": date, "Customer": customer, "State Code": state, "GST No.": gstin,
					"Total Cost": rupees(taxable), "IGST": rupees(igst), "CGST": rupees(cgst), "SGST": rupees(sgst), "Gross Amt.": rupees(gross)},
			})
		}
		e.columns = registerColumns
	}
	e.steps["import"] = true
	return map[string]any{"engagement_id": e.ID, "rows": len(e.register), "columns": e.columns, "unrecognised_columns": []string{}, "missing_columns": []string{}}, nil
}

func (s *server) ensure(r *http.Request, e *engagement, args map[string]any, steps ...string) ([]string, error) {
	var ran []string
	for _, step := range steps {
		if e.steps[step] {
			continue
		}
		var err error
		switch step {
		case "import":
			_, err = s.importRegister(r, args)
		case "reconcile":
			_, err = s.reconcile(r, args)
		case "tag":
			_, err = s.tag(r, args)
		case "detect":
			_, err = s.detect(r, args)
		}
		if err != nil {
			return ran, err
		}
		ran = append(ran, step)
	}
	return ran, nil
}

func (e *engagement) add(f finding) bool {
	id := f["finding_id"].(string)
	if _, ok := e.findings[id]; ok {
		return false
	}
	f["engagement_id"] = e.ID
	f["status"] = "proposed"
	f["created_at"] = time.Now().UTC().Format(time.RFC3339)
	if _, ok := f["sample_ids"]; !ok {
		f["sample_ids"] = []string{}
	}
	e.findings[id] = f
	e.order = append(e.order, id)
	return true
}

func (s *server) reconcile(r *http.Request, args map[string]any) (any, error) {
	e, err := s.pick(args)
	if err != nil {
		return nil, err
	}
	ran, err := s.ensure(r, e, args, "import")
	if err != nil {
		return nil, err
	}
	for _, row := range e.register {
		row["recon_status"] = "MATCHED"
	}
	e.steps["reconcile"] = true
	return map[string]any{"engagement_id": e.ID, "summary": map[string]int{"MATCHED": len(e.register)}, "findings_created": 0, "auto_ran": ran}, nil
}

func (s *server) tag(r *http.Request, args map[string]any) (any, error) {
	e, err := s.pick(args)
	if err != nil {
		return nil, err
	}
	ran, err := s.ensure(r, e, args, "import", "reconcile")
	if err != nil {
		return nil, err
	}
	disclosed := map[string]bool{}
	rows, err := s.db.Query(r.Context(), `SELECT lower(p->>'name') FROM business.v_related_party_lists l,
		jsonb_array_elements(l.parties) p WHERE l.seq <= $1`, e.SnapshotSeq)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		disclosed[name] = true
	}
	related := 0
	for _, row := range e.register {
		name := strings.ToLower(fmt.Sprint(row["raw"].(map[string]any)["Customer"]))
		if disclosed[name] {
			row["rp_tag"] = "Related Party"
			related++
		} else {
			row["rp_tag"] = "Non Related Party"
		}
	}
	e.steps["tag"] = true
	return map[string]any{"engagement_id": e.ID, "customers": len(e.register), "related_disclosed": related, "related_suggested": 0, "suggestions": []any{}, "findings_created": 0, "auto_ran": ran}, nil
}

// detect raises two simple, real findings so the screens have content:
// invoices with no dispatch, and credits to Sales that did not come from an
// invoice.
func (s *server) detect(r *http.Request, args map[string]any) (any, error) {
	e, err := s.pick(args)
	if err != nil {
		return nil, err
	}
	ran, err := s.ensure(r, e, args, "import", "reconcile", "tag")
	if err != nil {
		return nil, err
	}
	created := 0
	noMove, err := s.db.Query(r.Context(), `SELECT i.invoice_id, i.invoice_no, i.taxable_value, i.seq FROM business.v_invoices i
		WHERE i.seq <= $1 AND NOT EXISTS (SELECT 1 FROM business.v_dispatches d WHERE d.sale_id = i.sale_id AND d.seq <= $1)
		ORDER BY i.seq LIMIT 50`, e.SnapshotSeq)
	if err != nil {
		return nil, err
	}
	defer noMove.Close()
	hits := map[string]int{}
	for noMove.Next() {
		var id, no string
		var taxable, seq int64
		if err := noMove.Scan(&id, &no, &taxable, &seq); err != nil {
			return nil, err
		}
		hits["D-05"]++
		if e.add(finding{
			"finding_id": "fnd_" + short(e.ID, "NO_MOVEMENT", id), "detector_id": "D-05", "category": "NO_MOVEMENT", "subtype": "NO_DISPATCH",
			"severity": "High", "title": "Invoice " + no + " has no dispatch behind it",
			"subject": map[string]any{"type": "invoice", "id": id, "label": no}, "amount_impact": taxable, "period_effect": "Overstated",
			"proposed_adjustment": []map[string]any{{"account": "4000 Sales Revenue", "debit": taxable, "credit": 0}, {"account": "1100 Trade Receivables", "debit": 0, "credit": taxable}},
			"standard_refs":       []string{"SA 240", "SA 500", "Ind AS 115"},
			"lineage":             map[string]any{"event_seqs": []int64{seq}, "document_ids": []string{id}, "rule_id": "D-05.no_dispatch"},
			"reason":              "Revenue was recognised on invoice " + no + ", but no dispatch, e-way bill, lorry receipt or delivery is recorded for the sale.",
		}) {
			created++
		}
	}
	journals, err := s.db.Query(r.Context(), `SELECT p.seq, p.aggregate_id, p.credit FROM business.v_ledger p
		WHERE p.seq <= $1 AND p.account_code = '4000' AND p.credit > 0 AND p.source_event_type <> 'InvoiceIssued' ORDER BY p.seq LIMIT 50`, e.SnapshotSeq)
	if err != nil {
		return nil, err
	}
	defer journals.Close()
	for journals.Next() {
		var seq, credit int64
		var id string
		if err := journals.Scan(&seq, &id, &credit); err != nil {
			return nil, err
		}
		hits["D-09"]++
		if e.add(finding{
			"finding_id": "fnd_" + short(e.ID, "NON_SALE_REVENUE", id), "detector_id": "D-09", "category": "NON_SALE_REVENUE",
			"severity": "High", "title": "Revenue posted by a manual journal",
			"subject": map[string]any{"type": "journal", "id": id}, "amount_impact": credit, "period_effect": "Overstated",
			"proposed_adjustment": []map[string]any{{"account": "4000 Sales Revenue", "debit": credit, "credit": 0}, {"account": "9000 Suspense", "debit": 0, "credit": credit}},
			"standard_refs":       []string{"SA 240", "SA 330"},
			"lineage":             map[string]any{"event_seqs": []int64{seq}, "document_ids": []string{id}, "rule_id": "D-09.non_invoice_credit"},
			"reason":              "A credit to Sales Revenue was posted by a journal, not by an invoice. It has no sale behind it.",
		}) {
			created++
		}
	}
	e.steps["detect"] = true
	results := []map[string]any{}
	for _, d := range []struct{ id, cat string }{{"D-05", "NO_MOVEMENT"}, {"D-09", "NON_SALE_REVENUE"}} {
		results = append(results, map[string]any{"detector_id": d.id, "category": d.cat, "hits": hits[d.id]})
	}
	return map[string]any{"engagement_id": e.ID, "results": results, "findings_created": created, "indicators": map[string]any{}, "auto_ran": ran}, nil
}

var sheetDocs = map[string][]string{
	"sales_tod":       {"invoice", "eway_bill", "lr_copy"},
	"cutoff_tod":      {"invoice", "eway_bill", "lr_copy"},
	"credit_note_tod": {"credit_note", "sales_return"},
}

func (s *server) selectSheet(sheet string) func(*http.Request, map[string]any) (any, error) {
	return func(r *http.Request, args map[string]any) (any, error) {
		e, err := s.pick(args)
		if err != nil {
			return nil, err
		}
		ran, err := s.ensure(r, e, args, "import", "reconcile", "tag", "detect")
		if err != nil {
			return nil, err
		}
		created := 0
		if _, done := e.samples[sheet]; !done {
			var query string
			switch sheet {
			case "sales_tod":
				query = `SELECT i.invoice_id, i.sale_id, i.invoice_no, i.date::text, coalesce(c.payload->>'name', ''), i.taxable_value, 'KEY_ITEM'
					FROM business.v_invoices i LEFT JOIN business.events c ON c.aggregate_id = i.customer_id AND c.aggregate_version = 1
					WHERE i.seq <= $1 AND i.date BETWEEN $2::date AND $3::date ORDER BY i.taxable_value DESC, i.invoice_no LIMIT 30`
			case "cutoff_tod":
				query = `(SELECT i.invoice_id, i.sale_id, i.invoice_no, i.date::text, coalesce(c.payload->>'name', ''), i.taxable_value, 'BEFORE_PERIOD_END'
					FROM business.v_invoices i LEFT JOIN business.events c ON c.aggregate_id = i.customer_id AND c.aggregate_version = 1
					WHERE i.seq <= $1 AND i.date <= $3::date AND i.date >= $2::date ORDER BY i.date DESC, i.invoice_no DESC LIMIT 10)
					UNION ALL
					(SELECT i.invoice_id, i.sale_id, i.invoice_no, i.date::text, coalesce(c.payload->>'name', ''), i.taxable_value, 'AFTER_PERIOD_END'
					FROM business.v_invoices i LEFT JOIN business.events c ON c.aggregate_id = i.customer_id AND c.aggregate_version = 1
					WHERE i.seq <= $1 AND i.date > $3::date ORDER BY i.date, i.invoice_no LIMIT 15)`
			default:
				query = `SELECT n.credit_note_id, n.sale_id, n.credit_note_no, n.date::text, '', n.taxable_value,
					CASE WHEN n.date > $3::date THEN 'POST_PERIOD_END' ELSE 'IN_PERIOD' END
					FROM business.v_credit_notes n WHERE n.seq <= $1 AND n.date >= $2::date ORDER BY n.date DESC, n.credit_note_no LIMIT 20`
			}
			rows, err := s.db.Query(r.Context(), query, e.SnapshotSeq, e.PeriodStart, e.PeriodEnd)
			if err != nil {
				return nil, err
			}
			defer rows.Close()
			list := []*sample{}
			for rows.Next() {
				sm := &sample{Sheet: sheet, SubjType: "invoice", Related: "Non Related Party", Tests: map[string]string{}, Findings: []string{}}
				var code string
				if err := rows.Scan(&sm.Subject, &sm.SaleID, &sm.InvoiceNo, &sm.Date, &sm.Customer, &sm.Taxable, &code); err != nil {
					return nil, err
				}
				if sheet == "credit_note_tod" {
					sm.SubjType, sm.CNNo, sm.InvoiceNo = "credit_note", sm.InvoiceNo, ""
				}
				sm.Position = len(list) + 1
				sm.ID = "smp_" + short(e.ID, sheet, sm.Subject)
				sm.Codes = []string{code}
				sm.Reason = fmt.Sprintf("%s (position %d). Stand-in selection, not risk weighted.", code, sm.Position)
				sm.Tests["Evidence"] = "Pending evidence"
				for id, f := range e.findings {
					if subj, ok := f["subject"].(map[string]any); ok && subj["id"] == sm.Subject {
						sm.Findings = append(sm.Findings, id)
						f["sample_ids"] = append(f["sample_ids"].([]string), sm.ID)
					}
				}
				list = append(list, sm)
				for _, doc := range sheetDocs[sheet] {
					e.requests = append(e.requests, map[string]any{
						"request_id": "req_" + short(sm.ID, doc), "sample_id": sm.ID, "sheet": sheet, "document_type": doc,
						"subject": map[string]any{"invoice_no": sm.InvoiceNo + sm.CNNo, "date": sm.Date, "customer": sm.Customer, "amount": sm.Taxable},
					})
					created++
				}
			}
			e.samples[sheet] = list
		}
		e.steps[sheet] = true
		return map[string]any{"engagement_id": e.ID, "sheet": sheet, "seed": e.Seed, "snapshot_seq": e.SnapshotSeq, "population": len(e.register),
			"samples": e.samples[sheet], "evidence_requests_created": created, "auto_ran": ran}, nil
	}
}

func (s *server) samples(_ *http.Request, args map[string]any) (any, error) {
	e, err := s.pick(args)
	if err != nil {
		return nil, err
	}
	sheet, _ := args["sheet"].(string)
	list := e.samples[sheet]
	if list == nil {
		list = []*sample{}
	}
	return map[string]any{"engagement_id": e.ID, "sheet": sheet, "samples": list}, nil
}

// withStatus marks each request received when matching evidence exists.
func (s *server) withStatus(ctx context.Context, e *engagement) []map[string]any {
	got := map[string]string{}
	rows, err := s.db.Query(ctx, `SELECT sample_id, document_type, file_hash FROM business.v_evidence ORDER BY seq`)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var sid, doc, hash string
			if rows.Scan(&sid, &doc, &hash) == nil {
				got[sid+"|"+doc] = hash
			}
		}
	}
	out := make([]map[string]any, 0, len(e.requests))
	for _, r := range e.requests {
		copy := map[string]any{}
		for k, v := range r {
			copy[k] = v
		}
		if hash, ok := got[fmt.Sprint(r["sample_id"])+"|"+fmt.Sprint(r["document_type"])]; ok {
			copy["status"], copy["file_hash"] = "received", hash
		} else {
			copy["status"] = "pending"
		}
		out = append(out, copy)
	}
	return out
}

func (s *server) evidenceRequests(r *http.Request, args map[string]any) (any, error) {
	want, _ := args["status"].(string)
	out := []map[string]any{}
	for _, e := range s.engagements {
		for _, req := range s.withStatus(r.Context(), e) {
			if want == "" || req["status"] == want {
				out = append(out, req)
			}
		}
	}
	return map[string]any{"requests": out, "next_cursor": nil}, nil
}

func (s *server) evidenceStatus(r *http.Request, args map[string]any) (any, error) {
	e, err := s.pick(args)
	if err != nil {
		return nil, err
	}
	bySample := map[string][]map[string]any{}
	var order []string
	pending, received := 0, 0
	for _, req := range s.withStatus(r.Context(), e) {
		sid := fmt.Sprint(req["sample_id"])
		if _, ok := bySample[sid]; !ok {
			order = append(order, sid)
		}
		bySample[sid] = append(bySample[sid], map[string]any{"document_type": req["document_type"], "status": req["status"], "file_hash": req["file_hash"]})
		if req["status"] == "pending" {
			pending++
		} else {
			received++
		}
	}
	out := []map[string]any{}
	for _, sid := range order {
		out = append(out, map[string]any{"sample_id": sid, "documents": bySample[sid]})
	}
	return map[string]any{"engagement_id": e.ID, "samples": out, "pending": pending, "received": received, "verified": 0}, nil
}

func (s *server) requestEvidence(_ *http.Request, args map[string]any) (any, error) {
	e, err := s.pick(args)
	if err != nil {
		return nil, err
	}
	created := 0
	ids, _ := args["sample_ids"].([]any)
	docs, _ := args["document_types"].([]any)
	for _, id := range ids {
		for _, doc := range docs {
			e.requests = append(e.requests, map[string]any{"request_id": "req_" + short(fmt.Sprint(id), fmt.Sprint(doc), "extra"), "sample_id": id, "sheet": "", "document_type": doc, "note": args["note"]})
			created++
		}
	}
	return map[string]any{"engagement_id": e.ID, "requests_created": created}, nil
}

func (s *server) verify(r *http.Request, args map[string]any) (any, error) {
	e, err := s.pick(args)
	if err != nil {
		return nil, err
	}
	pending := map[string]bool{}
	for _, req := range s.withStatus(r.Context(), e) {
		if req["status"] == "pending" {
			pending[fmt.Sprint(req["sample_id"])] = true
		}
	}
	only, _ := args["sample_id"].(string)
	results := []map[string]any{}
	for _, list := range e.samples {
		for _, sm := range list {
			if only != "" && sm.ID != only {
				continue
			}
			if pending[sm.ID] {
				sm.Tests["Evidence"] = "Pending evidence"
			} else {
				sm.Tests["Evidence"] = "Pass"
			}
			results = append(results, map[string]any{"sample_id": sm.ID, "tests": sm.Tests, "checks": []any{}})
		}
	}
	e.steps["verify"] = true
	return map[string]any{"engagement_id": e.ID, "results": results, "findings_created": 0}, nil
}

func (s *server) changes(r *http.Request, args map[string]any) (any, error) {
	e, err := s.pick(args)
	if err != nil {
		return nil, err
	}
	bySale := map[string][]string{}
	for _, list := range e.samples {
		for _, sm := range list {
			if sm.SaleID != nil {
				bySale[*sm.SaleID] = append(bySale[*sm.SaleID], sm.ID)
			}
		}
	}
	rows, err := s.db.Query(r.Context(), `SELECT seq, event_type, identity_user, sale_id,
		to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM business.events
		WHERE seq > $1 AND sale_id IS NOT NULL AND event_type <> 'EvidenceUploaded' ORDER BY seq`, e.SnapshotSeq)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	changes := []map[string]any{}
	created := 0
	var head int64
	for rows.Next() {
		var seq int64
		var eventType, user, saleID, at string
		if err := rows.Scan(&seq, &eventType, &user, &saleID, &at); err != nil {
			return nil, err
		}
		head = seq
		samples := bySale[saleID]
		if len(samples) == 0 {
			continue
		}
		id := "fnd_" + short(e.ID, "POST_TESTING_CHANGE", strconv.FormatInt(seq, 10))
		if e.add(finding{
			"finding_id": id, "detector_id": "D-15", "category": "POST_TESTING_CHANGE", "severity": "High",
			"title":   eventType + " recorded after testing began",
			"subject": map[string]any{"type": "sample", "id": samples[0]}, "amount_impact": int64(0), "period_effect": "None",
			"proposed_adjustment": []any{}, "standard_refs": []string{"SA 230", "SA 500"},
			"lineage":    map[string]any{"event_seqs": []int64{seq}, "rule_id": "D-15.sampled_sale_changed"},
			"reason":     fmt.Sprintf("%s appended a %s event to a sampled sale after the snapshot at event %d.", user, eventType, e.SnapshotSeq),
			"sample_ids": samples,
		}) {
			created++
		}
		for _, list := range e.samples {
			for _, sm := range list {
				for _, sid := range samples {
					if sm.ID == sid {
						sm.Tests["Evidence"] = "Changed after testing"
					}
				}
			}
		}
		changes = append(changes, map[string]any{"seq": seq, "event_type": eventType, "identity_user": user, "recorded_at": at, "sample_ids": samples, "finding_ids": []string{id}})
	}
	e.steps["changes"] = true
	return map[string]any{"engagement_id": e.ID, "changes": changes, "findings_created": created, "head_seq": head}, nil
}

func compact(f finding) map[string]any {
	out := map[string]any{}
	for k, v := range f {
		if k != "lineage" && k != "proposed_adjustment" {
			out[k] = v
		}
	}
	return out
}

func (s *server) findings(_ *http.Request, args map[string]any) (any, error) {
	e, err := s.pick(args)
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	rank := map[string]int{"High": 0, "Medium": 1, "Low": 2}
	for _, id := range e.order {
		f := e.findings[id]
		if v, _ := args["category"].(string); v != "" && f["category"] != v {
			continue
		}
		if v, _ := args["severity"].(string); v != "" && f["severity"] != v {
			continue
		}
		if v, _ := args["status"].(string); v != "" && f["status"] != v {
			continue
		}
		out = append(out, compact(f))
	}
	sort.SliceStable(out, func(i, j int) bool { return rank[out[i]["severity"].(string)] < rank[out[j]["severity"].(string)] })
	return map[string]any{"engagement_id": e.ID, "findings": out, "next_cursor": nil, "totals": map[string]any{"count": len(out)}}, nil
}

func (s *server) find(id string) (*engagement, finding, error) {
	for _, e := range s.engagements {
		if f, ok := e.findings[id]; ok {
			return e, f, nil
		}
	}
	return nil, nil, &apiError{status: 404, Code: "NOT_FOUND", Msg: "Finding " + id + " does not exist.", Next: "Call get_findings for valid identifiers."}
}

func (s *server) explain(r *http.Request, _ map[string]any) (any, error) {
	_, f, err := s.find(r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	for k, v := range f {
		out[k] = v
	}
	out["explanation"] = f["reason"]
	out["documents"] = []any{}
	return out, nil
}

func (s *server) decide(r *http.Request, args map[string]any) (any, error) {
	if r.Header.Get("X-Identity-Role") != "audit_manager" {
		return nil, &apiError{status: 403, Code: "PERMISSION_DENIED", Msg: "Only an audit_manager can decide a finding."}
	}
	_, f, err := s.find(r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	decision, _ := args["decision"].(string)
	f["status"] = decision
	f["decided_by"] = r.Header.Get("X-Identity-User")
	f["decided_at"] = time.Now().UTC().Format(time.RFC3339)
	f["decision_note"] = args["note"]
	return map[string]any{"finding_id": f["finding_id"], "engagement_id": f["engagement_id"], "status": decision, "decided_by": f["decided_by"], "decided_at": f["decided_at"]}, nil
}

func (s *server) signOff(r *http.Request, args map[string]any) (any, error) {
	if r.Header.Get("X-Identity-Role") != "audit_manager" {
		return nil, &apiError{status: 403, Code: "PERMISSION_DENIED", Msg: "Only an audit_manager can sign off."}
	}
	e, err := s.pick(args)
	if err != nil {
		return nil, err
	}
	var open []string
	for id, f := range e.findings {
		if f["status"] == "proposed" {
			open = append(open, id)
		}
	}
	if len(open) > 0 {
		sort.Strings(open)
		return nil, &apiError{status: 400, Code: "VALIDATION_FAILED", Msg: fmt.Sprintf("%d findings have no decision: %s", len(open), strings.Join(open, ", ")), Next: "Call confirm_finding for each."}
	}
	if _, err := s.db.Exec(r.Context(), `INSERT INTO audit.sign_offs (engagement_id, signed_by, note) VALUES ($1, $2, $3)
		ON CONFLICT DO NOTHING`, e.ID, r.Header.Get("X-Identity-User"), args["note"]); err != nil {
		return nil, err
	}
	e.signedOff = true
	return map[string]any{"engagement_id": e.ID, "signed_by": r.Header.Get("X-Identity-User"), "signed_at": time.Now().UTC().Format(time.RFC3339)}, nil
}

func (s *server) graph(r *http.Request, args map[string]any) (any, error) {
	e, err := s.pick(args)
	if err != nil {
		return nil, err
	}
	nodes := []map[string]any{{"id": "company", "label": "Company", "kind": "company", "related": false}}
	edges := []map[string]any{}
	rows, err := s.db.Query(r.Context(), `SELECT i.customer_id, coalesce(c.payload->>'name', i.customer_id), sum(i.taxable_value)::bigint, count(*)
		FROM business.v_invoices i LEFT JOIN business.events c ON c.aggregate_id = i.customer_id AND c.aggregate_version = 1
		WHERE i.seq <= $1 GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 60`, e.SnapshotSeq)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, name string
		var value, count int64
		if err := rows.Scan(&id, &name, &value, &count); err != nil {
			return nil, err
		}
		nodes = append(nodes, map[string]any{"id": id, "label": name, "kind": "customer", "related": false})
		edges = append(edges, map[string]any{"source": "company", "target": id, "kind": "goods", "value": value, "count": count})
	}
	return map[string]any{"engagement_id": e.ID, "nodes": nodes, "edges": edges, "cycles": []any{}}, nil
}

// put writes a file in the same layout as the MCP server's directory store.
func (s *server) put(data []byte, name, contentType string) (map[string]any, error) {
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	path := filepath.Join(s.filesDir, hash[:2], hash)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return nil, err
	}
	meta, _ := json.Marshal(map[string]any{"file_hash": hash, "file_name": name, "content_type": contentType, "size": len(data)})
	if err := os.WriteFile(path+".json", meta, 0o644); err != nil {
		return nil, err
	}
	return map[string]any{"file_hash": hash, "file_name": name, "content_type": contentType}, nil
}

func (s *server) memo(_ *http.Request, args map[string]any) (any, error) {
	e, err := s.pick(args)
	if err != nil {
		return nil, err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# Findings memo\n\nEngagement %s, period %s to %s. Snapshot at event %d.\n\n", e.ID, e.PeriodStart, e.PeriodEnd, e.SnapshotSeq)
	var total int64
	for _, id := range e.order {
		f := e.findings[id]
		amount, _ := f["amount_impact"].(int64)
		total += amount
		status := fmt.Sprint(f["status"])
		if status == "proposed" {
			status = "Pending auditor confirmation"
		}
		fmt.Fprintf(&b, "## %s\n\n%s\n\nImpact: Rs %s. Status: %s.\n\n", f["title"], f["reason"], rupees(amount), status)
	}
	file, err := s.put([]byte(b.String()), "findings-memo-"+e.ID+".md", "text/markdown")
	if err != nil {
		return nil, err
	}
	e.steps["memo"] = true
	return map[string]any{"engagement_id": e.ID, "files": []any{file}, "findings": len(e.order), "total_adjustment": total, "head_hash": e.SnapshotHash}, nil
}

func (s *server) workpaper(_ *http.Request, args map[string]any) (any, error) {
	e, err := s.pick(args)
	if err != nil {
		return nil, err
	}
	var b strings.Builder
	b.WriteString(strings.Join(append(append([]string{}, e.columns...), "Related / Non Related", "Recon Status"), ",") + "\n")
	for _, row := range e.register {
		raw := row["raw"].(map[string]any)
		cells := []string{}
		for _, c := range e.columns {
			cells = append(cells, `"`+strings.ReplaceAll(fmt.Sprint(raw[c]), `"`, `""`)+`"`)
		}
		cells = append(cells, fmt.Sprint(row["rp_tag"]), fmt.Sprint(row["recon_status"]))
		b.WriteString(strings.Join(cells, ",") + "\n")
	}
	file, err := s.put([]byte(b.String()), "workpaper-"+e.ID+".csv", "text/csv")
	if err != nil {
		return nil, err
	}
	e.steps["workpaper"] = true
	return map[string]any{"engagement_id": e.ID, "file": file, "sheets": []string{"Sales Register"}, "head_hash": e.SnapshotHash}, nil
}

func (s *server) integrity(_ *http.Request, args map[string]any) (any, error) {
	e, err := s.pick(args)
	if err != nil {
		return nil, err
	}
	e.steps["integrity"] = true
	created := 0
	if match, _ := args["snapshot_match"].(bool); !match {
		if e.add(finding{
			"finding_id": "fnd_" + short(e.ID, "LEDGER_INTEGRITY"), "detector_id": "D-16", "category": "LEDGER_INTEGRITY", "severity": "High",
			"title": "The ledger no longer matches the engagement snapshot", "subject": map[string]any{"type": "chain", "id": "business"},
			"amount_impact": int64(0), "period_effect": "None", "proposed_adjustment": []any{}, "standard_refs": []string{"SA 230"},
			"lineage": map[string]any{"rule_id": "D-16.snapshot_hash"}, "reason": "The hash recomputed at the snapshot differs from the hash stored when the engagement opened, or a chain failed verification.",
		}) {
			created++
		}
	}
	return map[string]any{"engagement_id": e.ID, "findings_created": created}, nil
}

func (s *server) registerRows(_ *http.Request, args map[string]any) (any, error) {
	e, err := s.pick(args)
	if err != nil {
		return nil, err
	}
	want, _ := args["recon_status"].(string)
	limit := 100
	if v, err := strconv.Atoi(fmt.Sprint(args["limit"])); err == nil && v > 0 {
		limit = v
	}
	after := 0
	if v, err := strconv.Atoi(fmt.Sprint(args["cursor"])); err == nil {
		after = v
	}
	rows := []map[string]any{}
	var next any
	for _, row := range e.register {
		n := row["row_no"].(int)
		if n <= after || (want != "" && row["recon_status"] != want) {
			continue
		}
		if len(rows) == limit {
			next = strconv.Itoa(rows[len(rows)-1]["row_no"].(int))
			break
		}
		rows = append(rows, row)
	}
	columns := e.columns
	if columns == nil {
		columns = []string{}
	}
	return map[string]any{"engagement_id": e.ID, "columns": columns, "rows": rows, "next_cursor": next}, nil
}
