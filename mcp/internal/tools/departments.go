package tools

import (
	"context"

	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/core"
)

var (
	sales    = core.DeptSales
	dispatch = core.DeptDispatch
	accounts = core.DeptAccounts
	admin    = core.DeptAdmin
)

// toolDepartments names the client departments that may call each tool. The
// split follows the life of a sale, so that no single department can take an
// order, ship it, bill it and collect on it. A tool that is absent here is
// open to every client employee: those are the tools that only read.
var toolDepartments = map[string][]string{
	// Sales owns the customer and the commitment.
	"create_customer": {sales}, "update_customer": {sales},
	"set_price": {sales}, "create_promotion": {sales},
	"record_enquiry": {sales}, "create_sales_order": {sales},

	// Dispatch owns the physical movement of goods, outward and inward.
	"record_dispatch": {dispatch}, "generate_eway_bill": {dispatch}, "record_lr": {dispatch},
	"record_delivery": {dispatch}, "record_sales_return": {dispatch}, "record_goods_receipt": {dispatch},

	// Accounts owns revenue, tax, cash and the general ledger.
	"issue_invoice": {accounts}, "file_gstr1": {accounts},
	"record_receipt": {accounts}, "import_bank_statement": {accounts},
	"issue_credit_note": {accounts}, "reverse_document": {accounts},
	"record_purchase_invoice": {accounts}, "record_payment": {accounts},
	"post_journal": {accounts},

	// Admin owns the vendor list and the company's own particulars, apart from the department that pays.
	"create_vendor": {admin}, "update_vendor": {admin},
	"record_company_officer": {admin}, "upload_related_parties": {admin},

	// What the auditor receives. Transport documents come from Dispatch.
	"upload_sales_register": {accounts, admin},
	"upload_evidence":       {accounts, dispatch, admin},

	// Reads that expose the whole ledger.
	"export_sales_register": {accounts, admin},
	"get_trial_balance":     {accounts, admin},
}

// accessPolicyTool describes who may call what. It lets an agent find the
// department that owns a step, and lets the auditor see how duties are split.
func accessPolicyTool(all []*Tool) *Tool {
	return &Tool{
		Name:  "get_access_policy",
		Group: "Read",
		Description: "See who may do what: your own identity, the client departments with their duties, and for every client tool the departments allowed to call it. " +
			"Use it when a call is refused, to find the department that owns that step.",
		Roles: everyone,
		Handler: func(_ context.Context, c *core.Call) (map[string]any, *core.ToolError) {
			var list []map[string]any
			for _, t := range all {
				if !t.AllowsRole(core.RoleClient) {
					continue
				}
				depts := t.Departments
				if len(depts) == 0 {
					depts = []string{sales, dispatch, accounts, admin}
				}
				list = append(list, map[string]any{
					"name": t.Name, "group": t.Group, "write": t.Write, "departments": depts,
					"allowed": t.Allows(c.Identity),
				})
			}
			you := map[string]any{"user": c.Identity.User, "role": c.Identity.Role}
			if c.Identity.Department != "" {
				you["department"] = c.Identity.Department
			}
			return map[string]any{
				"you":         you,
				"departments": core.Departments,
				"tools":       list,
				"note":        "A client employee with no department is not restricted. Auditor roles read the business and never change it.",
			}, nil
		},
	}
}
