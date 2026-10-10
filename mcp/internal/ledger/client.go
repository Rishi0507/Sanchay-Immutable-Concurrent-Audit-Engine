// Package ledger is the client of the ledger core (contracts/ledger-api.md).
package ledger

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/core"
)

// Client talks to the ledger core over HTTP.
type Client struct {
	base  string
	token string
	http  *http.Client
}

// New builds a client for the given base address.
func New(base, serviceToken string) *Client {
	return &Client{base: base, token: serviceToken, http: &http.Client{Timeout: 60 * time.Second}}
}

// AppendRequest is the body of POST /append.
type AppendRequest struct {
	EventType       string         `json:"event_type"`
	EntityID        string         `json:"entity_id"`
	AggregateType   string         `json:"aggregate_type"`
	AggregateID     string         `json:"aggregate_id"`
	ExpectedVersion int64          `json:"expected_version"`
	SaleID          *string        `json:"sale_id"`
	Payload         map[string]any `json:"payload"`
	BusinessDate    *string        `json:"business_date"`
	Identity        core.Identity  `json:"identity"`
	IdempotencyKey  string         `json:"idempotency_key"`
}

// AppendResult is the response of POST /append.
type AppendResult struct {
	Seq              int64  `json:"seq"`
	Hash             string `json:"hash"`
	AggregateVersion int64  `json:"aggregate_version"`
	Duplicate        bool   `json:"duplicate"`
}

// Head is the response of GET /head.
type Head struct {
	Seq  int64  `json:"seq"`
	Hash string `json:"hash"`
}

// TrailEntry is the body of POST /trail/append.
type TrailEntry struct {
	Identity     core.Identity `json:"identity"`
	Tool         string        `json:"tool"`
	ArgsHash     string        `json:"args_hash"`
	ResultHash   string        `json:"result_hash"`
	Status       string        `json:"status"`
	EngagementID *string       `json:"engagement_id"`
}

type errorBody struct {
	Error *core.ToolError `json:"error"`
}

var nextSteps = map[string]string{
	core.CodeUnknownReference:    "Check the identifiers in the call. Use list_records to find the right one, or create the missing record first.",
	core.CodeVersionConflict:     "The record changed since it was read. Call get_record for the current version and retry.",
	core.CodeUnbalancedPosting:   "Check the amounts. Debits must equal credits, and gross must equal the sum of its components.",
	core.CodeInvalidTransition:   "The document cannot move to that state. Call get_record to see its current state.",
	core.CodeNotPermitted:        "Only a client_employee identity can change business data.",
	core.CodeIdempotencyMismatch: "This idempotency_key was used for a different request. Use a new key for a new request.",
	core.CodeValidationFailed:    "Correct the fields named in the message and retry.",
}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) *core.ToolError {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return core.Internal(err)
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, reader)
	if err != nil {
		return core.Internal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Service-Token", c.token)
	resp, err := c.http.Do(req)
	if err != nil {
		return &core.ToolError{Code: core.CodeLedgerUnavailable, Message: "The ledger core did not respond: " + err.Error(), NextStep: "Retry shortly. Write tools are safe to repeat with the same idempotency_key."}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return core.Internal(err)
	}
	if resp.StatusCode >= 400 {
		var eb errorBody
		if json.Unmarshal(raw, &eb) == nil && eb.Error != nil {
			if eb.Error.NextStep == "" {
				eb.Error.NextStep = nextSteps[eb.Error.Code]
			}
			eb.Error.Status = resp.StatusCode
			return eb.Error
		}
		return &core.ToolError{Code: core.CodeInternal, Message: fmt.Sprintf("ledger core returned %d: %s", resp.StatusCode, string(raw)), Status: http.StatusBadGateway}
	}
	if out == nil {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(out); err != nil {
		return core.Internal(fmt.Errorf("decode ledger response: %w", err))
	}
	return nil
}

// Append appends one business event.
func (c *Client) Append(ctx context.Context, r *AppendRequest) (*AppendResult, *core.ToolError) {
	var out AppendResult
	if err := c.do(ctx, http.MethodPost, "/append", r, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Head returns the current head of the business chain.
func (c *Client) Head(ctx context.Context) (*Head, *core.ToolError) {
	var out Head
	if err := c.do(ctx, http.MethodGet, "/head", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Verify recomputes the business chain. at is optional; pass 0 to omit it.
func (c *Client) Verify(ctx context.Context, at int64) (map[string]any, *core.ToolError) {
	q := url.Values{}
	if at > 0 {
		q.Set("at", strconv.FormatInt(at, 10))
	}
	path := "/verify"
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	var out map[string]any
	if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// TrailVerify recomputes the trail chain.
func (c *Client) TrailVerify(ctx context.Context) (map[string]any, *core.ToolError) {
	var out map[string]any
	if err := c.do(ctx, http.MethodGet, "/trail/verify", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Merkle returns the Merkle root of a date.
func (c *Client) Merkle(ctx context.Context, date string) (map[string]any, *core.ToolError) {
	var out map[string]any
	if err := c.do(ctx, http.MethodGet, "/merkle/"+url.PathEscape(date), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Proof returns the Merkle path of one event.
func (c *Client) Proof(ctx context.Context, seq int64) (map[string]any, *core.ToolError) {
	var out map[string]any
	if err := c.do(ctx, http.MethodGet, "/proof/"+strconv.FormatInt(seq, 10), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// TrailAppend appends one trail entry.
func (c *Client) TrailAppend(ctx context.Context, e *TrailEntry) *core.ToolError {
	return c.do(ctx, http.MethodPost, "/trail/append", e, nil)
}

// Health reports whether the ledger core answers.
func (c *Client) Health(ctx context.Context) bool {
	return c.do(ctx, http.MethodGet, "/health", nil, nil) == nil
}
