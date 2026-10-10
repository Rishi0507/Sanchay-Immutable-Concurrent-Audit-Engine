// Package engine is the client of the audit engine (contracts/engine-api.md).
// The MCP server holds no audit logic; each auditor tool is one call here.
package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/core"
)

// Client talks to the audit engine over HTTP.
type Client struct {
	base  string
	token string
	http  *http.Client
}

// New builds a client for the given base address.
func New(base, serviceToken string) *Client {
	return &Client{base: base, token: serviceToken, http: &http.Client{Timeout: 5 * time.Minute}}
}

type errorBody struct {
	Error *core.ToolError `json:"error"`
}

// Do calls one engine endpoint. For GET the args become the query string; for
// other methods they become the JSON body.
func (c *Client) Do(ctx context.Context, id core.Identity, method, path string, args map[string]any) (map[string]any, *core.ToolError) {
	target := c.base + path
	var reader io.Reader
	if method == http.MethodGet {
		q := url.Values{}
		for k, v := range args {
			switch t := v.(type) {
			case []any:
				for _, item := range t {
					q.Add(k, fmt.Sprint(item))
				}
			default:
				q.Set(k, fmt.Sprint(t))
			}
		}
		if len(q) > 0 {
			target += "?" + q.Encode()
		}
	} else {
		if args == nil {
			args = map[string]any{}
		}
		b, err := json.Marshal(args)
		if err != nil {
			return nil, core.Internal(err)
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, core.Internal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Service-Token", c.token)
	req.Header.Set("X-Identity-User", id.User)
	req.Header.Set("X-Identity-Role", id.Role)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &core.ToolError{
			Code:     core.CodeEngineUnavailable,
			Message:  "The audit engine did not respond: " + err.Error(),
			NextStep: "Retry shortly. Audit tools are safe to repeat.",
		}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, core.Internal(err)
	}
	if resp.StatusCode >= 400 {
		var eb errorBody
		if json.Unmarshal(raw, &eb) == nil && eb.Error != nil {
			eb.Error.Status = resp.StatusCode
			return nil, eb.Error
		}
		return nil, &core.ToolError{Code: core.CodeInternal, Message: fmt.Sprintf("audit engine returned %d: %s", resp.StatusCode, truncate(string(raw), 400)), Status: http.StatusBadGateway}
	}
	var out map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		return nil, core.Internal(fmt.Errorf("decode engine response: %w", err))
	}
	return out, nil
}

// Health reports whether the engine answers.
func (c *Client) Health(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	_, err := c.Do(ctx, core.Identity{User: "mcp", Role: core.RoleAuditor}, http.MethodGet, "/health", nil)
	return err == nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
