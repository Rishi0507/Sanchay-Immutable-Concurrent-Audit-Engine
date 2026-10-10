// Package tools defines every MCP tool: its name, description, roles, input
// fields and handler. The server package exposes them over MCP and HTTP.
package tools

import (
	"context"
	"sort"

	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/catalogue"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/core"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/engine"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/files"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/ledger"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/mail"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/store"
)

// Audiences for notifications raised by a tool (PRD section 9.6).
const (
	NotifyNone    = ""
	NotifyAuditor = "auditor"
	NotifyClient  = "client"
)

// Tool is one callable tool.
type Tool struct {
	Name        string
	Group       string
	Description string
	Roles       []string
	Departments []string // client departments that may call it; empty means every client employee
	Fields      []catalogue.Field
	Write       bool
	Changes     bool // the call changes what other people see: a client record or a step of the audit
	Notify      string
	Handler     core.Handler
}

// AllowsRole reports whether a role may call the tool.
func (t *Tool) AllowsRole(role string) bool {
	for _, r := range t.Roles {
		if r == role {
			return true
		}
	}
	return false
}

// Allows reports whether an identity may call the tool. The role must be
// listed. A client employee who belongs to a department must also be in one
// of the tool's departments, when the tool names any.
func (t *Tool) Allows(id core.Identity) bool {
	if !t.AllowsRole(id.Role) {
		return false
	}
	if id.Role != core.RoleClient || id.Department == "" || len(t.Departments) == 0 {
		return true
	}
	for _, d := range t.Departments {
		if d == id.Department {
			return true
		}
	}
	return false
}

// Deps are the services the handlers use.
type Deps struct {
	Cat           *catalogue.Catalogue
	Ledger        *ledger.Client
	Engine        *engine.Client
	Store         *store.Store
	Files         files.Store
	Mail          *mail.Mailer
	DefaultEntity string
}

var (
	clientOnly  = []string{core.RoleClient}
	auditRoles  = []string{core.RoleAuditor, core.RoleManager}
	managerOnly = []string{core.RoleManager}
	everyone    = []string{core.RoleClient, core.RoleAuditor, core.RoleManager}
)

// Build returns every tool, sorted by group then name.
func Build(d *Deps) []*Tool {
	var all []*Tool
	all = append(all, clientEventTools(d)...)
	all = append(all, clientReadTools(d)...)
	all = append(all, auditorEngineTools(d)...)
	all = append(all, auditorReadTools(d)...)
	all = append(all, sharedTools(d)...)
	all = append(all, emailTools(d)...)
	for _, t := range all {
		t.Departments = toolDepartments[t.Name]
	}
	all = append(all, accessPolicyTool(all))
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].Group != all[j].Group {
			return groupOrder(all[i].Group) < groupOrder(all[j].Group)
		}
		return false
	})
	return all
}

var groups = []string{
	"Parties", "Pricing and promotions", "Sale", "Tax", "Settlement", "Reversal",
	"Purchases", "General ledger", "Audit support", "Read",
	"Plan", "Engagement", "Register", "Related parties", "Detectors", "Sampling",
	"Evidence", "Integrity", "Findings", "Outputs", "Sign-off",
}

func groupOrder(g string) int {
	for i, name := range groups {
		if name == g {
			return i
		}
	}
	return len(groups)
}

// Field helpers keep tool definitions short.

func str(name, desc string) catalogue.Field {
	return catalogue.Field{Name: name, Type: "string", Description: desc}
}

func reqStr(name, desc string) catalogue.Field {
	return catalogue.Field{Name: name, Type: "string", Description: desc, Required: true}
}

func date(name, desc string) catalogue.Field {
	return catalogue.Field{Name: name, Type: "date", Description: desc}
}

func reqDate(name, desc string) catalogue.Field {
	return catalogue.Field{Name: name, Type: "date", Description: desc, Required: true}
}

func integer(name, desc string) catalogue.Field {
	return catalogue.Field{Name: name, Type: "int", Description: desc}
}

func enum(name, desc string, values ...string) catalogue.Field {
	return catalogue.Field{Name: name, Type: "enum", Description: desc, Values: values}
}

func strList(name, desc string) catalogue.Field {
	return catalogue.Field{Name: name, Type: "string_list", Description: desc}
}

func boolean(name, desc string) catalogue.Field {
	return catalogue.Field{Name: name, Type: "bool", Description: desc}
}

var (
	fEngagement = str("engagement_id", "Engagement to work on. Optional when exactly one engagement is open.")
	fLimit      = integer("limit", "Maximum rows to return. Default 50, maximum 500.")
	fCursor     = str("cursor", "Value of next_cursor from the previous page.")
	fIdemKey    = reqStr("idempotency_key", "Any unique string for this request. Repeating a call with the same key is safe and returns the first result.")
	fEntity     = str("entity_id", "Legal entity the record belongs to. Defaults to the main entity.")
)

// resolveEngagement applies TC-7: use the named engagement, or the only open
// one.
func resolveEngagement(ctx context.Context, d *Deps, args map[string]any) (*store.Engagement, *core.ToolError) {
	if id := core.Str(args, "engagement_id"); id != "" {
		e, err := d.Store.Engagement(ctx, id)
		if err == store.ErrNotFound {
			return nil, core.Errf(core.CodeNotFound, "Call get_engagement_status with no arguments to see the open engagement.", "Engagement %s does not exist.", id)
		}
		if err != nil {
			return nil, core.Internal(err)
		}
		return e, nil
	}
	open, err := d.Store.OpenEngagements(ctx)
	if err != nil {
		return nil, core.Internal(err)
	}
	switch len(open) {
	case 0:
		return nil, core.Errf(core.CodeNoEngagement, "Call open_engagement with period_start and period_end.", "No engagement is open.")
	case 1:
		return &open[0], nil
	}
	ids := make([]string, len(open))
	for i, e := range open {
		ids[i] = e.ID
	}
	return nil, &core.ToolError{Code: core.CodeNoEngagement, Message: "More than one engagement is open.", NextStep: "Pass engagement_id. Open engagements: " + join(ids)}
}

func join(items []string) string {
	out := ""
	for i, s := range items {
		if i > 0 {
			out += ", "
		}
		out += s
	}
	return out
}
