package tools

import "testing"

// A screen reloads when another person's call changed something. If a read were
// reported as a change, two auditors on one engagement would reload each other
// without end, and each reload is written to the audit trail.
func TestOnlyCallsThatChangeSomethingAreReportedAsChanges(t *testing.T) {
	all := build(t)
	reads := []string{
		"get_audit_plan", "get_engagement_status", "list_engagements", "get_register_rows", "get_samples",
		"get_evidence_status", "get_findings", "explain_finding", "get_counterparty_graph", "get_notifications",
		"get_audit_trail", "get_access_policy", "list_records", "list_evidence_requests", "query_records",
		"verify_ledger_integrity", "verify_sampling_seal", "ask_assistant",
	}
	for _, name := range reads {
		tool := all[name]
		if tool == nil {
			t.Errorf("%s is not a tool", name)
			continue
		}
		if tool.Changes {
			t.Errorf("%s only reads, but is reported as a change", name)
		}
	}
	changes := []string{
		"open_engagement", "import_register", "reconcile_register", "tag_related_parties", "run_detectors",
		"select_sales_tod", "request_evidence", "verify_evidence", "confirm_finding", "sign_off_engagement",
		"upload_evidence", "upload_sales_register",
	}
	for _, name := range changes {
		tool := all[name]
		if tool == nil {
			t.Errorf("%s is not a tool", name)
			continue
		}
		if !tool.Changes {
			t.Errorf("%s changes what others see, but is not reported as a change", name)
		}
	}
	for name, tool := range all {
		if tool.Write && !tool.Changes {
			t.Errorf("%s writes business data, but is not reported as a change", name)
		}
	}
}
