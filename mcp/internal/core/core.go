// Package core holds the types shared by every part of the MCP server.
package core

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
)

// Roles an identity can hold (PRD section 4.1).
const (
	RoleClient  = "client_employee"
	RoleAuditor = "auditor"
	RoleManager = "audit_manager"
)

// Identity is who is calling. It is resolved from a bearer token and never
// taken from tool arguments.
type Identity struct {
	User string `json:"user"`
	Role string `json:"role"`
}

// Error codes returned to callers (PRD section 9.2).
const (
	CodePermissionDenied    = "PERMISSION_DENIED"
	CodeNoEngagement        = "NO_ENGAGEMENT"
	CodeNotFound            = "NOT_FOUND"
	CodeValidationFailed    = "VALIDATION_FAILED"
	CodeIdempotencyMismatch = "IDEMPOTENCY_MISMATCH"
	CodeEvidencePending     = "EVIDENCE_PENDING"
	CodeUnknownReference    = "UNKNOWN_REFERENCE"
	CodeVersionConflict     = "VERSION_CONFLICT"
	CodeUnbalancedPosting   = "UNBALANCED_POSTING"
	CodeInvalidTransition   = "INVALID_TRANSITION"
	CodeNotPermitted        = "NOT_PERMITTED"
	CodeUnknownTool         = "UNKNOWN_TOOL"
	CodeLedgerUnavailable   = "LEDGER_UNAVAILABLE"
	CodeEngineUnavailable   = "ENGINE_UNAVAILABLE"
	CodeInternal            = "INTERNAL_ERROR"
)

// ToolError is the error shape of TC-5: a code, a message and a next step
// that tells an agent how to recover.
type ToolError struct {
	Code     string `json:"code"`
	Message  string `json:"message"`
	NextStep string `json:"next_step,omitempty"`
	Status   int    `json:"-"`
}

func (e *ToolError) Error() string { return e.Code + ": " + e.Message }

// HTTPStatus maps the error to a status for the HTTP gateway.
func (e *ToolError) HTTPStatus() int {
	if e.Status != 0 {
		return e.Status
	}
	switch e.Code {
	case CodePermissionDenied, CodeNotPermitted:
		return http.StatusForbidden
	case CodeNotFound, CodeUnknownReference, CodeUnknownTool:
		return http.StatusNotFound
	case CodeValidationFailed:
		return http.StatusBadRequest
	case CodeUnbalancedPosting:
		return http.StatusUnprocessableEntity
	case CodeNoEngagement, CodeIdempotencyMismatch, CodeVersionConflict, CodeInvalidTransition, CodeEvidencePending:
		return http.StatusConflict
	case CodeLedgerUnavailable, CodeEngineUnavailable:
		return http.StatusBadGateway
	}
	return http.StatusInternalServerError
}

// Errf builds a ToolError.
func Errf(code, nextStep, format string, args ...any) *ToolError {
	return &ToolError{Code: code, Message: fmt.Sprintf(format, args...), NextStep: nextStep}
}

// Internal wraps an unexpected failure.
func Internal(err error) *ToolError {
	return &ToolError{Code: CodeInternal, Message: err.Error(), NextStep: "Retry the call. If it fails again, report the message."}
}

// Call is one tool invocation after authentication and input validation.
type Call struct {
	Identity Identity
	Tool     string
	Args     map[string]any
}

// Handler runs a tool. The result must marshal to a JSON object.
type Handler func(ctx context.Context, c *Call) (map[string]any, *ToolError)

// HashJSON returns the SHA-256 of the JSON encoding of v. Go sorts map keys
// when it marshals, so equal values give equal hashes.
func HashJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		b = []byte(fmt.Sprintf("%v", v))
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// ShortHash returns the first n hexadecimal characters of SHA-256 over s.
func ShortHash(s string, n int) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])[:n]
}

// Str reads a string argument, or "" when absent.
func Str(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

// Int reads an integer argument with a default.
func Int(m map[string]any, key string, def int64) int64 {
	switch v := m[key].(type) {
	case int64:
		return v
	case int:
		return int64(v)
	case float64:
		return int64(v)
	case json.Number:
		if i, err := v.Int64(); err == nil {
			return i
		}
	}
	return def
}
