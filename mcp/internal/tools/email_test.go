package tools

import (
	"strings"
	"testing"
)

func TestINRText(t *testing.T) {
	cases := map[float64]string{
		0:           "0.00",
		999.5:       "999.50",
		1234567.89:  "12,34,567.89",
		35_47_889:   "35,47,889.00",
		-120000.004: "-1,20,000.00",
	}
	for in, want := range cases {
		if got := inrText(in); got != want {
			t.Errorf("inrText(%v) = %q, want %q", in, got, want)
		}
	}
}

func TestFindingsReviewIsInternal(t *testing.T) {
	e := emailEngagement{ID: "eng_1", Start: "2025-04-01", End: "2026-03-31", SnapshotHash: "abc"}
	found := map[string]any{"findings": []any{
		map[string]any{"severity": "High", "status": "proposed", "title": "Circular trade", "amount_impact": 100000.0},
		map[string]any{"severity": "Low", "status": "confirmed", "title": "Minor", "amount_impact": 10.0},
	}}
	m := findingsReviewMessage(e, found, "")
	if !strings.Contains(m.Subject, "1 findings await") {
		t.Fatalf("subject %q", m.Subject)
	}
	for _, want := range []string{"1,00,000.00", "Do not forward them to the client", "Snapshot hash abc", "1. Circular trade"} {
		if !strings.Contains(m.Text, want) {
			t.Errorf("text is missing %q:\n%s", want, m.Text)
		}
	}
}

func TestEvidenceReminderListsPendingOnly(t *testing.T) {
	ev := map[string]any{"samples": []any{
		map[string]any{"sample_id": "smp_1", "documents": []any{
			map[string]any{"document_type": "invoice", "status": "verified"},
			map[string]any{"document_type": "eway_bill", "status": "pending"},
		}},
	}}
	m, n := evidenceReminderMessage(emailEngagement{ID: "eng_1"}, ev, "Please send these by Friday.")
	if n != 1 || !strings.Contains(m.Text, "E-way bill for sample smp_1") || strings.Contains(m.Text, "Invoice for") {
		t.Fatalf("pending %d, text:\n%s", n, m.Text)
	}
	if !strings.HasPrefix(m.Text, "Please send these by Friday.") {
		t.Fatalf("note should lead the email:\n%s", m.Text)
	}
}

func TestHTMLIsEscaped(t *testing.T) {
	if got := toHTML([]string{"<script>x</script>"}); strings.Contains(got, "<script>") {
		t.Fatalf("unescaped html: %s", got)
	}
}
