// Package server exposes the tools over MCP and over the HTTP gateway used by
// the UI. Both paths go through Invoke, so there is one place for permission
// checks, validation, the audit trail and notifications (PRD rule C-1).
package server

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/catalogue"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/core"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/files"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/ledger"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/tools"
)

// Server holds the tool registry and the services around it.
type Server struct {
	cat        *catalogue.Catalogue
	ledger     *ledger.Client
	files      files.Store
	hub        *Hub
	log        *slog.Logger
	tools      map[string]*tools.Tool
	ordered    []*tools.Tool
	identities map[string]core.Identity
	corsOrigin string
	stateful   bool
	health     func(ctx context.Context) map[string]any
}

// Options configures a Server.
type Options struct {
	Catalogue  *catalogue.Catalogue
	Ledger     *ledger.Client
	Files      files.Store
	Tools      []*tools.Tool
	Identities map[string]core.Identity
	Logger     *slog.Logger
	CORSOrigin string
	Stateful   bool
	Health     func(ctx context.Context) map[string]any
}

// New builds a Server.
func New(o Options) *Server {
	s := &Server{
		cat:        o.Catalogue,
		ledger:     o.Ledger,
		files:      o.Files,
		hub:        NewHub(),
		log:        o.Logger,
		tools:      map[string]*tools.Tool{},
		ordered:    o.Tools,
		identities: o.Identities,
		corsOrigin: o.CORSOrigin,
		stateful:   o.Stateful,
		health:     o.Health,
	}
	if s.log == nil {
		s.log = slog.Default()
	}
	for _, t := range o.Tools {
		s.tools[t.Name] = t
	}
	return s
}

// ToolsFor returns the tools a role may call, in display order (MS-3).
func (s *Server) ToolsFor(role string) []*tools.Tool {
	var out []*tools.Tool
	for _, t := range s.ordered {
		if t.Allows(role) {
			out = append(out, t)
		}
	}
	return out
}

// Identify resolves a bearer token to an identity.
func (s *Server) Identify(token string) (core.Identity, bool) {
	id, ok := s.identities[token]
	return id, ok
}

// Invoke runs one tool call for an identity.
func (s *Server) Invoke(ctx context.Context, id core.Identity, name string, raw json.RawMessage) (map[string]any, *core.ToolError) {
	args, terr := decodeArgs(raw)
	var result map[string]any
	if terr == nil {
		result, terr = s.run(ctx, id, name, args)
	}
	s.record(ctx, id, name, args, result, terr)
	return result, terr
}

func decodeArgs(raw json.RawMessage) (map[string]any, *core.ToolError) {
	args := map[string]any{}
	if len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		return args, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&args); err != nil {
		return map[string]any{}, core.Errf(core.CodeValidationFailed, "Send the arguments as a JSON object.", "The arguments are not a JSON object: %v", err)
	}
	return args, nil
}

func (s *Server) run(ctx context.Context, id core.Identity, name string, args map[string]any) (map[string]any, *core.ToolError) {
	t, ok := s.tools[name]
	if !ok {
		return nil, core.Errf(core.CodeUnknownTool, "List the available tools and pick one of them.", "There is no tool named %s.", name)
	}
	if !t.Allows(id.Role) {
		return nil, core.Errf(core.CodePermissionDenied,
			"Use a tool listed for your role. An auditor identity cannot change business data, and only an audit_manager can confirm findings.",
			"The %s role may not call %s. It is available to: %s.", id.Role, name, strings.Join(t.Roles, ", "))
	}
	clean, problems := catalogue.Normalise(t.Fields, args)
	if len(problems) > 0 {
		return nil, &core.ToolError{
			Code:     core.CodeValidationFailed,
			Message:  strings.Join(problems, " "),
			NextStep: "Correct the fields named above and call " + name + " again.",
		}
	}
	out, terr := t.Handler(ctx, &core.Call{Identity: id, Tool: name, Args: clean})
	if terr != nil {
		return nil, terr
	}
	return s.present(out), nil
}

// present turns a handler result into plain JSON data with money in rupees.
func (s *Server) present(out map[string]any) map[string]any {
	if out == nil {
		return map[string]any{}
	}
	raw, err := json.Marshal(out)
	if err != nil {
		return map[string]any{"error": "result could not be encoded: " + err.Error()}
	}
	var generic map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&generic); err != nil {
		return out
	}
	converted, _ := s.cat.ToRupees(generic).(map[string]any)
	return converted
}

// record appends the call to the trail chain and publishes notices. Every
// call is recorded, including denied and failed ones (AT-3).
func (s *Server) record(ctx context.Context, id core.Identity, name string, args, result map[string]any, terr *core.ToolError) {
	status := "ok"
	var resultHash string
	if terr != nil {
		status = strings.ToLower(terr.Code)
		resultHash = core.HashJSON(terr)
	} else {
		resultHash = core.HashJSON(result)
	}
	entry := &ledger.TrailEntry{
		Identity:   id,
		Tool:       name,
		ArgsHash:   core.HashJSON(redact(args)),
		ResultHash: resultHash,
		Status:     status,
	}
	engagement := core.Str(args, "engagement_id")
	if engagement == "" && result != nil {
		engagement = core.Str(result, "engagement_id")
	}
	if engagement != "" {
		entry.EngagementID = &engagement
	}
	// The trail write must not be cancelled with the caller's request.
	tctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if err := s.ledger.TrailAppend(tctx, entry); err != nil {
		s.log.Error("trail append failed", "tool", name, "user", id.User, "error", err.Message)
	}

	s.hub.Publish(Notice{
		Kind:     "activity",
		Audience: []string{core.RoleAuditor, core.RoleManager},
		Data:     map[string]any{"tool": name, "user": id.User, "role": id.Role, "status": status, "engagement_id": engagement},
	})
	if terr != nil {
		return
	}
	t := s.tools[name]
	if t == nil {
		return
	}
	switch t.Notify {
	case tools.NotifyAuditor:
		s.hub.Publish(Notice{
			Kind:     "client_upload",
			Audience: []string{core.RoleAuditor, core.RoleManager},
			Data:     map[string]any{"tool": name, "user": id.User, "seq": result["seq"], "file_hash": result["file_hash"]},
		})
	case tools.NotifyClient:
		s.hub.Publish(Notice{
			Kind:     "evidence_requested",
			Audience: []string{core.RoleClient},
			Data:     map[string]any{"tool": name, "engagement_id": engagement, "requests_created": firstOf(result, "evidence_requests_created", "requests_created")},
		})
	}
}

func firstOf(m map[string]any, keys ...string) any {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			return v
		}
	}
	return nil
}

// redact keeps large inline file content out of the hashed arguments' source
// map. The content itself is identified by its file hash in the result.
func redact(args map[string]any) map[string]any {
	if _, ok := args["content_base64"]; !ok {
		return args
	}
	out := make(map[string]any, len(args))
	for k, v := range args {
		if k == "content_base64" {
			if str, isStr := v.(string); isStr {
				out[k] = "sha256:" + core.ShortHash(str, 64)
				continue
			}
		}
		out[k] = v
	}
	return out
}
