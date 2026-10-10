package core

// Departments of the client company. They separate duties inside the
// client_employee role: the person who takes an order is not the person who
// ships the goods, raises the invoice or maintains the vendor list.
//
// A client_employee identity that belongs to a department may call only the
// tools of that department. An identity with no department is not restricted,
// which is how the seeding loader and earlier tokens keep working.
const (
	DeptSales    = "sales"
	DeptDispatch = "dispatch"
	DeptAccounts = "accounts"
	DeptAdmin    = "admin"
)

// Department describes one department for callers and for the interface.
type Department struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Duties string `json:"duties"`
}

// Departments lists every department, in the order a sale passes through them.
var Departments = []Department{
	{DeptSales, "Sales", "Customers, prices, promotions, enquiries and sales orders."},
	{DeptDispatch, "Dispatch", "Dispatches, e-way bills, lorry receipts, deliveries, and goods returned or received."},
	{DeptAccounts, "Accounts", "Invoices, tax filings, receipts, bank statements, credit notes, reversals, purchases, payments and journals."},
	{DeptAdmin, "Admin", "Vendors, company officers, the related-party list and the sales register given to the auditor."},
}

// DepartmentName returns the display name of a department, or "" when the
// identifier is not a department.
func DepartmentName(id string) string {
	for _, d := range Departments {
		if d.ID == id {
			return d.Name
		}
	}
	return ""
}
