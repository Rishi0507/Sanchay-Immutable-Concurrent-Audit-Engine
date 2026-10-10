// Package store holds the MCP server's database reads. It connects with the
// mcp_read role, which has SELECT only (PRD section 4.4).
package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store wraps a connection pool.
type Store struct {
	pool *pgxpool.Pool
}

// Open connects to the database.
func Open(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	return &Store{pool: pool}, nil
}

// Close releases the pool.
func (s *Store) Close() { s.pool.Close() }

// Ping checks the connection.
func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

// ErrNotFound is returned when a single-row lookup finds nothing.
var ErrNotFound = errors.New("not found")

// Aggregate is the current state of one document or master record.
type Aggregate struct {
	ID       string
	Type     string
	Version  int64
	Reversed bool
	EntityID string
	SaleID   *string
}

// AggregateInfo returns the current state of an aggregate.
func (s *Store) AggregateInfo(ctx context.Context, id string) (*Aggregate, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT min(aggregate_type), max(aggregate_version),
		       bool_or(event_type = 'DocumentReversed'), min(entity_id), min(sale_id)
		FROM business.events WHERE aggregate_id = $1`, id)
	var a Aggregate
	var typ, entity *string
	var version *int64
	var reversed *bool
	if err := row.Scan(&typ, &version, &reversed, &entity, &a.SaleID); err != nil {
		return nil, err
	}
	if typ == nil || version == nil {
		return nil, ErrNotFound
	}
	a.ID, a.Type, a.Version, a.EntityID = id, *typ, *version, *entity
	a.Reversed = reversed != nil && *reversed
	return &a, nil
}

// Event is one row of the event log.
type Event struct {
	Seq              int64          `json:"seq"`
	EventType        string         `json:"event_type"`
	AggregateType    string         `json:"aggregate_type"`
	AggregateID      string         `json:"aggregate_id"`
	AggregateVersion int64          `json:"aggregate_version"`
	EntityID         string         `json:"entity_id"`
	SaleID           *string        `json:"sale_id"`
	BusinessDate     *string        `json:"business_date"`
	RecordedAt       string         `json:"recorded_at"`
	IdentityUser     string         `json:"recorded_by"`
	Payload          map[string]any `json:"payload"`
	Hash             string         `json:"hash"`
}

const eventColumns = `seq, event_type, aggregate_type, aggregate_id, aggregate_version, entity_id,
	sale_id, business_date::text, to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
	identity_user, payload, hash`

func scanEvents(rows pgx.Rows) ([]Event, error) {
	defer rows.Close()
	var out []Event
	for rows.Next() {
		var e Event
		var payload []byte
		if err := rows.Scan(&e.Seq, &e.EventType, &e.AggregateType, &e.AggregateID, &e.AggregateVersion,
			&e.EntityID, &e.SaleID, &e.BusinessDate, &e.RecordedAt, &e.IdentityUser, &payload, &e.Hash); err != nil {
			return nil, err
		}
		e.Payload = decodeObject(payload)
		out = append(out, e)
	}
	return out, rows.Err()
}

func decodeObject(raw []byte) map[string]any {
	var m map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&m); err != nil {
		return map[string]any{}
	}
	return m
}

// AggregateEvents returns every event of one aggregate. maxSeq of 0 means no
// snapshot limit.
func (s *Store) AggregateEvents(ctx context.Context, id string, maxSeq int64) ([]Event, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+eventColumns+` FROM business.events
		WHERE aggregate_id = $1 AND ($2 = 0 OR seq <= $2) ORDER BY seq`, id, maxSeq)
	if err != nil {
		return nil, err
	}
	return scanEvents(rows)
}

// SaleEvents returns every event of one sale in sequence order.
func (s *Store) SaleEvents(ctx context.Context, saleID string, maxSeq int64) ([]Event, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+eventColumns+` FROM business.events
		WHERE sale_id = $1 AND ($2 = 0 OR seq <= $2) ORDER BY seq`, saleID, maxSeq)
	if err != nil {
		return nil, err
	}
	return scanEvents(rows)
}

// FindSaleID resolves a sale from a document identifier or an invoice number.
func (s *Store) FindSaleID(ctx context.Context, documentID, invoiceNo string, maxSeq int64) (string, error) {
	var saleID *string
	var err error
	if documentID != "" {
		err = s.pool.QueryRow(ctx, `SELECT sale_id FROM business.events
			WHERE aggregate_id = $1 AND aggregate_version = 1 AND ($2 = 0 OR seq <= $2)`, documentID, maxSeq).Scan(&saleID)
	} else {
		err = s.pool.QueryRow(ctx, `SELECT sale_id FROM business.events
			WHERE event_type = 'InvoiceIssued' AND payload->>'invoice_no' = $1 AND ($2 = 0 OR seq <= $2)
			ORDER BY seq LIMIT 1`, invoiceNo, maxSeq).Scan(&saleID)
	}
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && saleID == nil) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return *saleID, nil
}

// DocumentFilter selects documents for list and query tools.
type DocumentFilter struct {
	AggregateType string
	CustomerID    string
	VendorID      string
	SaleID        string
	DateFrom      string
	DateTo        string
	Text          string
	MaxSeq        int64
	AfterSeq      int64
	Limit         int
}

// Document is the creating event of an aggregate plus its reversal state.
type Document struct {
	Event
	ReversedSeq *int64 `json:"reversed_seq"`
}

// ListDocuments returns documents in sequence order, one page at a time.
func (s *Store) ListDocuments(ctx context.Context, f DocumentFilter) ([]Document, error) {
	var where []string
	var args []any
	add := func(cond string, v any) {
		args = append(args, v)
		where = append(where, fmt.Sprintf(cond, len(args)))
	}
	where = append(where, "e.aggregate_version = 1")
	if f.AggregateType != "" {
		add("e.aggregate_type = $%d", f.AggregateType)
	}
	if f.CustomerID != "" {
		add("e.payload->>'customer_id' = $%d", f.CustomerID)
	}
	if f.VendorID != "" {
		add("e.payload->>'vendor_id' = $%d", f.VendorID)
	}
	if f.SaleID != "" {
		add("e.sale_id = $%d", f.SaleID)
	}
	if f.DateFrom != "" {
		add("e.business_date >= $%d::date", f.DateFrom)
	}
	if f.DateTo != "" {
		add("e.business_date <= $%d::date", f.DateTo)
	}
	if f.Text != "" {
		add("e.payload::text ILIKE '%%' || $%d || '%%'", f.Text)
	}
	if f.MaxSeq > 0 {
		add("e.seq <= $%d", f.MaxSeq)
	}
	if f.AfterSeq > 0 {
		add("e.seq > $%d", f.AfterSeq)
	}
	limit := f.Limit
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	// A reversal counts only when it falls inside the snapshot.
	args = append(args, f.MaxSeq)
	maxArg := len(args)
	q := fmt.Sprintf(`SELECT e.seq, e.event_type, e.aggregate_type, e.aggregate_id, e.aggregate_version, e.entity_id,
		e.sale_id, e.business_date::text, to_char(e.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
		e.identity_user, e.payload, e.hash,
		(SELECT min(r.seq) FROM business.events r
		  WHERE r.aggregate_id = e.aggregate_id AND r.event_type = 'DocumentReversed'
		    AND ($%d = 0 OR r.seq <= $%d))
		FROM business.events e WHERE %s ORDER BY e.seq LIMIT %d`, maxArg, maxArg, strings.Join(where, " AND "), limit)
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Document
	for rows.Next() {
		var d Document
		var payload []byte
		if err := rows.Scan(&d.Seq, &d.EventType, &d.AggregateType, &d.AggregateID, &d.AggregateVersion,
			&d.EntityID, &d.SaleID, &d.BusinessDate, &d.RecordedAt, &d.IdentityUser, &payload, &d.Hash, &d.ReversedSeq); err != nil {
			return nil, err
		}
		d.Payload = decodeObject(payload)
		out = append(out, d)
	}
	return out, rows.Err()
}

// Posting is one ledger line.
type Posting struct {
	Seq             int64   `json:"seq"`
	LineNo          int     `json:"line_no"`
	AccountCode     string  `json:"account_code"`
	AccountName     string  `json:"account_name"`
	Debit           int64   `json:"debit"`
	Credit          int64   `json:"credit"`
	SaleID          *string `json:"sale_id"`
	SourceEventType string  `json:"source_event_type"`
	BusinessDate    *string `json:"business_date"`
	AggregateID     string  `json:"document_id"`
}

// LedgerFilter selects ledger lines.
type LedgerFilter struct {
	Account  string
	SaleID   string
	DateFrom string
	DateTo   string
	MaxSeq   int64
	AfterSeq int64
	AfterLn  int
	Limit    int
}

// LedgerEntries returns ledger lines in sequence order.
func (s *Store) LedgerEntries(ctx context.Context, f LedgerFilter) ([]Posting, error) {
	var where []string
	var args []any
	add := func(cond string, v any) {
		args = append(args, v)
		where = append(where, fmt.Sprintf(cond, len(args)))
	}
	where = append(where, "true")
	if f.Account != "" {
		add("account_code = $%d", f.Account)
	}
	if f.SaleID != "" {
		add("sale_id = $%d", f.SaleID)
	}
	if f.DateFrom != "" {
		add("business_date >= $%d::date", f.DateFrom)
	}
	if f.DateTo != "" {
		add("business_date <= $%d::date", f.DateTo)
	}
	if f.MaxSeq > 0 {
		add("seq <= $%d", f.MaxSeq)
	}
	if f.AfterSeq > 0 {
		args = append(args, f.AfterSeq, f.AfterLn)
		where = append(where, fmt.Sprintf("(seq, line_no) > ($%d, $%d)", len(args)-1, len(args)))
	}
	limit := f.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	q := fmt.Sprintf(`SELECT seq, line_no, account_code, account_name, debit, credit, sale_id,
		source_event_type, business_date::text, aggregate_id
		FROM business.v_ledger WHERE %s ORDER BY seq, line_no LIMIT %d`, strings.Join(where, " AND "), limit)
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Posting
	for rows.Next() {
		var p Posting
		if err := rows.Scan(&p.Seq, &p.LineNo, &p.AccountCode, &p.AccountName, &p.Debit, &p.Credit,
			&p.SaleID, &p.SourceEventType, &p.BusinessDate, &p.AggregateID); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// PostingsForSeqs returns the ledger lines of a set of events.
func (s *Store) PostingsForSeqs(ctx context.Context, seqs []int64) (map[int64][]Posting, error) {
	out := map[int64][]Posting{}
	if len(seqs) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT seq, line_no, account_code, account_name, debit, credit, sale_id,
		source_event_type, business_date::text, aggregate_id
		FROM business.v_ledger WHERE seq = ANY($1) ORDER BY seq, line_no`, seqs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var p Posting
		if err := rows.Scan(&p.Seq, &p.LineNo, &p.AccountCode, &p.AccountName, &p.Debit, &p.Credit,
			&p.SaleID, &p.SourceEventType, &p.BusinessDate, &p.AggregateID); err != nil {
			return nil, err
		}
		out[p.Seq] = append(out[p.Seq], p)
	}
	return out, rows.Err()
}

// TrialBalanceRow is the balance of one account.
type TrialBalanceRow struct {
	AccountCode string `json:"account_code"`
	AccountName string `json:"account_name"`
	Debit       int64  `json:"total_debit"`
	Credit      int64  `json:"total_credit"`
	Balance     int64  `json:"balance"`
}

// TrialBalance returns account totals as at a sequence number (LG-5).
func (s *Store) TrialBalance(ctx context.Context, maxSeq int64, dateFrom, dateTo string) ([]TrialBalanceRow, error) {
	rows, err := s.pool.Query(ctx, `SELECT account_code, account_name, sum(debit)::bigint, sum(credit)::bigint
		FROM business.v_ledger
		WHERE ($1 = 0 OR seq <= $1)
		  AND ($2 = '' OR business_date >= nullif($2, '')::date)
		  AND ($3 = '' OR business_date <= nullif($3, '')::date)
		GROUP BY account_code, account_name ORDER BY account_code`, maxSeq, dateFrom, dateTo)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TrialBalanceRow
	for rows.Next() {
		var r TrialBalanceRow
		if err := rows.Scan(&r.AccountCode, &r.AccountName, &r.Debit, &r.Credit); err != nil {
			return nil, err
		}
		r.Balance = r.Debit - r.Credit
		out = append(out, r)
	}
	return out, rows.Err()
}

// Engagement is one row of audit.engagements.
type Engagement struct {
	ID           string   `json:"engagement_id"`
	EntityIDs    []string `json:"entity_ids"`
	PeriodStart  string   `json:"period_start"`
	PeriodEnd    string   `json:"period_end"`
	Seed         string   `json:"seed"`
	SnapshotSeq  int64    `json:"snapshot_seq"`
	SnapshotHash string   `json:"snapshot_hash"`
	OpenedBy     string   `json:"opened_by"`
	SignedOff    bool     `json:"signed_off"`
}

const engagementQuery = `SELECT e.engagement_id, e.entity_ids, e.period_start::text, e.period_end::text,
	e.seed, e.snapshot_seq, e.snapshot_hash, e.opened_by, (s.engagement_id IS NOT NULL)
	FROM audit.engagements e LEFT JOIN audit.sign_offs s USING (engagement_id)`

func scanEngagement(row pgx.Row) (*Engagement, error) {
	var e Engagement
	if err := row.Scan(&e.ID, &e.EntityIDs, &e.PeriodStart, &e.PeriodEnd, &e.Seed, &e.SnapshotSeq,
		&e.SnapshotHash, &e.OpenedBy, &e.SignedOff); err != nil {
		return nil, err
	}
	return &e, nil
}

// Engagement returns one engagement by ID.
func (s *Store) Engagement(ctx context.Context, id string) (*Engagement, error) {
	e, err := scanEngagement(s.pool.QueryRow(ctx, engagementQuery+` WHERE e.engagement_id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return e, err
}

// OpenEngagements returns the engagements that are not signed off, newest
// first.
func (s *Store) OpenEngagements(ctx context.Context) ([]Engagement, error) {
	rows, err := s.pool.Query(ctx, engagementQuery+` WHERE s.engagement_id IS NULL ORDER BY e.opened_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Engagement
	for rows.Next() {
		e, err := scanEngagement(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *e)
	}
	return out, rows.Err()
}

// Notification is a client upload the auditor side should know about.
type Notification struct {
	Seq        int64          `json:"seq"`
	Kind       string         `json:"kind"`
	DocumentID string         `json:"document_id"`
	RecordedAt string         `json:"recorded_at"`
	By         string         `json:"uploaded_by"`
	Detail     map[string]any `json:"detail"`
}

// Notifications returns upload events after a sequence number (NT-1).
func (s *Store) Notifications(ctx context.Context, sinceSeq int64, limit int) ([]Notification, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `SELECT seq, event_type, aggregate_id,
		to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), identity_user, payload
		FROM business.events
		WHERE event_type IN ('SalesRegisterUploaded', 'RelatedPartyListUploaded', 'EvidenceUploaded') AND seq > $1
		ORDER BY seq LIMIT $2`, sinceSeq, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Notification
	for rows.Next() {
		var n Notification
		var eventType string
		var payload []byte
		if err := rows.Scan(&n.Seq, &eventType, &n.DocumentID, &n.RecordedAt, &n.By, &payload); err != nil {
			return nil, err
		}
		p := decodeObject(payload)
		switch eventType {
		case "SalesRegisterUploaded":
			n.Kind = "sales_register_uploaded"
			n.Detail = pick(p, "file_name", "file_hash", "row_count", "period_start", "period_end")
		case "RelatedPartyListUploaded":
			n.Kind = "related_parties_uploaded"
			n.Detail = pick(p, "as_of", "file_name", "file_hash")
			if parties, ok := p["parties"].([]any); ok {
				n.Detail["party_count"] = len(parties)
			}
		default:
			n.Kind = "evidence_uploaded"
			n.Detail = pick(p, "sample_id", "document_type", "file_name", "file_hash")
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func pick(m map[string]any, keys ...string) map[string]any {
	out := map[string]any{}
	for _, k := range keys {
		if v, ok := m[k]; ok {
			out[k] = v
		}
	}
	return out
}

// TrailEntry is one row of the trail chain.
type TrailEntry struct {
	TrailSeq     int64   `json:"trail_seq"`
	TS           string  `json:"ts"`
	User         string  `json:"user"`
	Role         string  `json:"role"`
	Tool         string  `json:"tool"`
	ArgsHash     string  `json:"args_hash"`
	ResultHash   string  `json:"result_hash"`
	Status       string  `json:"status"`
	EngagementID *string `json:"engagement_id"`
	PrevHash     string  `json:"prev_hash"`
	Hash         string  `json:"hash"`
}

// TrailFilter selects trail entries.
type TrailFilter struct {
	User         string
	Tool         string
	EngagementID string
	BeforeSeq    int64
	Limit        int
	Ascending    bool
}

// Trail returns trail entries, newest first unless Ascending is set.
func (s *Store) Trail(ctx context.Context, f TrailFilter) ([]TrailEntry, error) {
	var where []string
	var args []any
	add := func(cond string, v any) {
		args = append(args, v)
		where = append(where, fmt.Sprintf(cond, len(args)))
	}
	where = append(where, "true")
	if f.User != "" {
		add("identity_user = $%d", f.User)
	}
	if f.Tool != "" {
		add("tool = $%d", f.Tool)
	}
	if f.EngagementID != "" {
		add("engagement_id = $%d", f.EngagementID)
	}
	if f.BeforeSeq > 0 {
		if f.Ascending {
			add("trail_seq > $%d", f.BeforeSeq)
		} else {
			add("trail_seq < $%d", f.BeforeSeq)
		}
	}
	limit := f.Limit
	if limit <= 0 || limit > 5000 {
		limit = 100
	}
	order := "DESC"
	if f.Ascending {
		order = "ASC"
	}
	q := fmt.Sprintf(`SELECT trail_seq, to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		identity_user, identity_role, tool, args_hash, result_hash, status, engagement_id, prev_hash, hash
		FROM trail.entries WHERE %s ORDER BY trail_seq %s LIMIT %d`, strings.Join(where, " AND "), order, limit)
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TrailEntry
	for rows.Next() {
		var t TrailEntry
		if err := rows.Scan(&t.TrailSeq, &t.TS, &t.User, &t.Role, &t.Tool, &t.ArgsHash, &t.ResultHash,
			&t.Status, &t.EngagementID, &t.PrevHash, &t.Hash); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// RegisterRow is one invoice laid out for the client's sales register.
type RegisterRow struct {
	InvoiceNo, Date, JobNo, Customer, LedgerAccount, StateCode, GSTIN string
	Taxable, Discount, Packing, Freight, Insurance                    int64
	IGST, CGST, SGST, TCS, RoundOff, Gross                            int64
	TaxRate                                                           *float64
	BusinessUnit, EInvoice                                            string
}

// RegisterRows returns the unreversed invoices of a period for the register
// export.
func (s *Store) RegisterRows(ctx context.Context, entityID, from, to string) ([]RegisterRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT i.invoice_no, to_char(i.date, 'DD-MM-YYYY'), coalesce(i.job_no, ''),
		       coalesce(c.payload->>'name', ''), coalesce(i.payload->>'ledger_account', 'SALES ACCOUNT'),
		       coalesce(i.place_of_supply, c.payload->>'state_code', ''),
		       coalesce(i.customer_gstin, c.payload->>'gstin', ''),
		       i.taxable_value, i.discount, i.packing, i.freight, i.insurance,
		       i.igst, i.cgst, i.sgst, i.tcs, i.round_off, i.gross,
		       (i.payload->>'tax_rate')::float8, coalesce(i.business_unit, ''),
		       coalesce(i.payload->>'einvoice_status', CASE WHEN i.irn IS NULL THEN 'Incomplete' ELSE 'Complete' END)
		FROM business.v_invoices i
		LEFT JOIN business.events c ON c.aggregate_id = i.customer_id AND c.aggregate_version = 1
		WHERE i.reversed_seq IS NULL AND i.entity_id = $1 AND i.date BETWEEN $2::date AND $3::date
		ORDER BY i.date, i.invoice_no`, entityID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RegisterRow
	for rows.Next() {
		var r RegisterRow
		if err := rows.Scan(&r.InvoiceNo, &r.Date, &r.JobNo, &r.Customer, &r.LedgerAccount, &r.StateCode, &r.GSTIN,
			&r.Taxable, &r.Discount, &r.Packing, &r.Freight, &r.Insurance,
			&r.IGST, &r.CGST, &r.SGST, &r.TCS, &r.RoundOff, &r.Gross, &r.TaxRate, &r.BusinessUnit, &r.EInvoice); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Counts returns record counts by aggregate type, for the client overview.
func (s *Store) Counts(ctx context.Context) (map[string]int64, error) {
	rows, err := s.pool.Query(ctx, `SELECT aggregate_type, count(*) FROM business.events
		WHERE aggregate_version = 1 GROUP BY aggregate_type`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var k string
		var n int64
		if err := rows.Scan(&k, &n); err != nil {
			return nil, err
		}
		out[k] = n
	}
	return out, rows.Err()
}

// Now is the database clock, used where a consistent timestamp matters.
func (s *Store) Now(ctx context.Context) (time.Time, error) {
	var t time.Time
	err := s.pool.QueryRow(ctx, `SELECT now()`).Scan(&t)
	return t, err
}
