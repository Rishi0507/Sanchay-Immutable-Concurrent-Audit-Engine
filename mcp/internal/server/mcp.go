package server

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/catalogue"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/core"
)

const serverVersion = "1.0.0"

var instructions = map[string]string{
	core.RoleClient: "You act as an employee of the client company. Use these tools to run the business: create parties, record each sale from enquiry to receipt, file returns and post journals. " +
		"To support the audit, call export_sales_register then upload_sales_register, call upload_related_parties, and answer list_evidence_requests with upload_evidence. " +
		"Amounts are in rupees. Dates are YYYY-MM-DD. Every write tool needs an idempotency_key; repeating a call with the same key is safe.",
	core.RoleAuditor: "You act as an independent statutory auditor. Start with get_audit_plan and follow next_tool. You read a frozen snapshot of the client's records and cannot change business data. " +
		"Every difference you find is a finding, never something to clean up. Findings need a human auditor's confirmation, which you cannot give. " +
		"Amounts are in rupees. Tools are safe to repeat. An error names the next step to take.",
	core.RoleManager: "You act as the human auditor in charge. You have every auditor tool, plus confirm_finding and sign_off_engagement. " +
		"Review each finding with explain_finding before deciding. Amounts are in rupees.",
}

// instructionsFor is the guidance an agent reads on connecting. A client
// employee in a department is told what that department does and where the
// other steps of a sale belong.
func instructionsFor(id core.Identity) string {
	text := instructions[id.Role]
	if id.Role != core.RoleClient || id.Department == "" {
		return text
	}
	for _, d := range core.Departments {
		if d.ID == id.Department {
			return "You work in the " + d.Name + " department of the client company. Your department handles: " + d.Duties +
				" You can read every record, but you can change only what your department owns. Other steps of a sale belong to other departments; " +
				"call get_access_policy to see who owns each one. " +
				"Amounts are in rupees. Dates are YYYY-MM-DD. Every write tool needs an idempotency_key; repeating a call with the same key is safe."
		}
	}
	return text
}

// mcpServers builds one MCP server per identity, so each session lists only
// the tools of its role and every call carries the right user.
type mcpServers struct {
	s     *Server
	mu    sync.Mutex
	cache map[core.Identity]*mcp.Server
}

func (m *mcpServers) forIdentity(id core.Identity) *mcp.Server {
	m.mu.Lock()
	defer m.mu.Unlock()
	if srv, ok := m.cache[id]; ok {
		return srv
	}
	srv := m.s.buildMCP(id)
	m.cache[id] = srv
	return srv
}

func (s *Server) buildMCP(id core.Identity) *mcp.Server {
	srv := mcp.NewServer(
		&mcp.Implementation{Name: "sanchay", Title: "Sanchay", Version: serverVersion},
		&mcp.ServerOptions{Instructions: instructionsFor(id), HasTools: true},
	)
	listed := map[string]bool{}
	for _, t := range s.ToolsFor(id) {
		name := t.Name
		listed[name] = true
		srv.AddTool(&mcp.Tool{
			Name:        name,
			Description: t.Description,
			InputSchema: catalogue.Schema(t.Fields),
		}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			return s.callResult(ctx, id, name, req.Params.Arguments), nil
		})
	}
	// A call to a tool that is not listed for this role still goes through
	// Invoke, so it is answered with PERMISSION_DENIED or UNKNOWN_TOOL and is
	// written to the audit trail (MS-4, AT-3).
	srv.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			if method == "tools/call" {
				if params, ok := req.GetParams().(*mcp.CallToolParamsRaw); ok && !listed[params.Name] {
					return s.callResult(ctx, id, params.Name, params.Arguments), nil
				}
			}
			return next(ctx, method, req)
		}
	})
	return srv
}

func (s *Server) callResult(ctx context.Context, id core.Identity, name string, raw json.RawMessage) *mcp.CallToolResult {
	result, terr := s.Invoke(ctx, id, name, raw)
	if terr != nil {
		body := map[string]any{"error": terr}
		text, _ := json.Marshal(body)
		return &mcp.CallToolResult{
			IsError:           true,
			Content:           []mcp.Content{&mcp.TextContent{Text: string(text)}},
			StructuredContent: body,
		}
	}
	text, _ := json.Marshal(result)
	return &mcp.CallToolResult{
		Content:           []mcp.Content{&mcp.TextContent{Text: string(text)}},
		StructuredContent: result,
	}
}

// MCPHandler serves MCP over Streamable HTTP. The bearer token selects the
// identity; a request with no valid token is refused before it reaches MCP.
func (s *Server) MCPHandler() http.Handler {
	servers := &mcpServers{s: s, cache: map[core.Identity]*mcp.Server{}}
	handler := mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
		id, ok := s.identityOf(r)
		if !ok {
			return nil
		}
		return servers.forIdentity(id)
	}, &mcp.StreamableHTTPOptions{Stateless: !s.stateful})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := s.identityOf(r); !ok {
			w.Header().Set("WWW-Authenticate", `Bearer realm="sanchay"`)
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": core.ToolError{
				Code:     core.CodePermissionDenied,
				Message:  "A valid bearer token is required.",
				NextStep: "Send the header Authorization: Bearer <token> with the token of your identity.",
			}})
			return
		}
		handler.ServeHTTP(w, r)
	})
}

// RunStdio serves MCP over standard input and output for one identity.
func (s *Server) RunStdio(ctx context.Context, id core.Identity) error {
	return s.buildMCP(id).Run(ctx, &mcp.StdioTransport{})
}
