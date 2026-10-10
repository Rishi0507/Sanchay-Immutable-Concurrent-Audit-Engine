package tools

import (
	"testing"

	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/catalogue"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/core"
)

func build(t *testing.T) map[string]*Tool {
	t.Helper()
	cat, err := catalogue.Load("../../../contracts/events.json")
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]*Tool{}
	for _, tool := range Build(&Deps{Cat: cat}) {
		out[tool.Name] = tool
	}
	return out
}

// A tool that changes business data must belong to a department. A new event
// in the catalogue with no owner would otherwise be open to every employee.
func TestEveryClientWriteToolHasADepartment(t *testing.T) {
	all := build(t)
	for name, tool := range all {
		if tool.Write && tool.AllowsRole(core.RoleClient) && len(tool.Departments) == 0 {
			t.Errorf("%s changes business data but belongs to no department", name)
		}
	}
	for name, depts := range toolDepartments {
		if all[name] == nil {
			t.Errorf("toolDepartments names %s, which is not a tool", name)
		}
		for _, d := range depts {
			if core.DepartmentName(d) == "" {
				t.Errorf("%s names unknown department %q", name, d)
			}
		}
	}
}

func TestDepartmentsSeparateTheStepsOfASale(t *testing.T) {
	all := build(t)
	who := func(dept string) core.Identity {
		return core.Identity{User: dept + ".employee", Role: core.RoleClient, Department: dept}
	}
	cases := []struct {
		dept, tool string
		want       bool
	}{
		{core.DeptSales, "create_sales_order", true},
		{core.DeptSales, "issue_invoice", false},
		{core.DeptSales, "record_dispatch", false},
		{core.DeptDispatch, "record_dispatch", true},
		{core.DeptDispatch, "issue_credit_note", false},
		{core.DeptAccounts, "issue_invoice", true},
		{core.DeptAccounts, "create_vendor", false}, // the department that pays does not maintain the vendor list
		{core.DeptAccounts, "create_sales_order", false},
		{core.DeptAdmin, "create_vendor", true},
		{core.DeptAdmin, "record_payment", false},
		{core.DeptSales, "list_records", true}, // reading stays open
		{core.DeptSales, "get_trial_balance", false},
		{core.DeptAccounts, "get_trial_balance", true},
	}
	for _, c := range cases {
		if got := all[c.tool].Allows(who(c.dept)); got != c.want {
			t.Errorf("%s calling %s: got %v, want %v", c.dept, c.tool, got, c.want)
		}
	}
	// No single department can take an order, ship it, bill it and collect on it.
	chain := []string{"create_sales_order", "record_dispatch", "issue_invoice", "record_receipt"}
	for _, d := range core.Departments {
		whole := true
		for _, tool := range chain {
			whole = whole && all[tool].Allows(who(d.ID))
		}
		if whole {
			t.Errorf("%s can run a sale from order to receipt alone", d.ID)
		}
	}
}

func TestDepartmentsDoNotWidenOtherRoles(t *testing.T) {
	all := build(t)
	unrestricted := core.Identity{User: "client.employee", Role: core.RoleClient}
	auditor := core.Identity{User: "auditor.agent", Role: core.RoleAuditor}
	// A department set on a non-client identity must not grant client tools.
	odd := core.Identity{User: "auditor.agent", Role: core.RoleAuditor, Department: core.DeptAccounts}
	for name, tool := range all {
		if tool.AllowsRole(core.RoleClient) && !tool.Allows(unrestricted) {
			t.Errorf("a client employee with no department lost %s", name)
		}
		if tool.Write && tool.AllowsRole(core.RoleClient) && !tool.AllowsRole(core.RoleAuditor) && (tool.Allows(auditor) || tool.Allows(odd)) {
			t.Errorf("an auditor may call %s, which changes business data", name)
		}
	}
}
