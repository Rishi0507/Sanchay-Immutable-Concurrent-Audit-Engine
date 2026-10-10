package catalogue

import (
	"encoding/json"
	"strings"
	"testing"
)

func load(t *testing.T) *Catalogue {
	t.Helper()
	c, err := Load("../../../contracts/events.json")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	return c
}

func TestCatalogueIsComplete(t *testing.T) {
	c := load(t)
	if len(c.Events) != 27 {
		t.Fatalf("expected 27 event types, got %d", len(c.Events))
	}
	tools := map[string]bool{}
	for _, e := range c.Events {
		if e.Tool == "" || e.Description == "" {
			t.Errorf("%s: tool and description are required", e.Type)
		}
		if tools[e.Tool] {
			t.Errorf("tool %s is defined twice", e.Tool)
		}
		tools[e.Tool] = true
		switch e.Mode {
		case "create", "update", "reverse":
		default:
			t.Errorf("%s: bad mode %q", e.Type, e.Mode)
		}
		if e.BusinessDate != "" {
			found := false
			for _, f := range e.Fields {
				found = found || f.Name == e.BusinessDate
			}
			if !found {
				t.Errorf("%s: business_date field %q is not a field", e.Type, e.BusinessDate)
			}
		}
		for _, f := range e.RefFields() {
			if c.ByAggregate(f.Ref) == nil {
				t.Errorf("%s.%s refers to unknown aggregate %q", e.Type, f.Name, f.Ref)
			}
		}
	}
}

func TestNormaliseInvoice(t *testing.T) {
	c := load(t)
	ev := c.ByTool("issue_invoice")
	args := map[string]any{
		"invoice_no":    "G/0001/24",
		"date":          "2025-03-30",
		"customer_id":   "cus_1",
		"taxable_value": json.Number("100000.50"),
		"igst":          "18,000.09",
		"gross":         118000.59,
		"items":         []any{map[string]any{"item_code": "A1", "qty": 2.0, "rate": 50000.25}},
	}
	out, problems := Normalise(ev.Fields, args)
	if len(problems) > 0 {
		t.Fatalf("unexpected problems: %v", problems)
	}
	if out["taxable_value"] != int64(10000050) || out["igst"] != int64(1800009) || out["gross"] != int64(11800059) {
		t.Errorf("money was not converted to paise: %v", out)
	}
	item := out["items"].([]any)[0].(map[string]any)
	if item["rate"] != int64(5000025) {
		t.Errorf("nested money was not converted: %v", item)
	}
}

func TestNormaliseReportsEveryProblem(t *testing.T) {
	c := load(t)
	ev := c.ByTool("issue_invoice")
	_, problems := Normalise(ev.Fields, map[string]any{
		"date":    "30-03-2025",
		"gross":   -5.0,
		"unknown": 1,
	})
	joined := strings.Join(problems, " ")
	for _, want := range []string{"invoice_no is required", "customer_id is required", "taxable_value is required", "date must be a date", "gross must not be negative", "unknown is not a known field"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing problem %q in %q", want, joined)
		}
	}
}

func TestNormaliseEnumAndDatetime(t *testing.T) {
	c := load(t)
	ev := c.ByTool("create_sales_order")
	_, problems := Normalise(ev.Fields, map[string]any{
		"customer_id": "cus_1", "order_no": "SO-1", "date": "2025-01-05",
		"items": []any{map[string]any{"item_code": "A", "qty": 1}}, "delivery_terms": "fob",
	})
	if len(problems) != 1 || !strings.Contains(problems[0], "ex_works, delivered") {
		t.Errorf("expected one enum problem, got %v", problems)
	}
	dv := c.ByTool("record_dispatch")
	out, problems := Normalise(dv.Fields, map[string]any{"dispatched_at": "2025-03-30 14:05"})
	if len(problems) > 0 || out["dispatched_at"] != "2025-03-30T14:05:00Z" {
		t.Errorf("datetime not normalised: %v %v", out, problems)
	}
}

func TestToRupees(t *testing.T) {
	c := load(t)
	in := map[string]any{
		"gross":         json.Number("11800059"),
		"amount_impact": int64(250000),
		"count":         json.Number("12"),
		"tax_rate":      json.Number("18"),
		"lines":         []any{map[string]any{"debit": json.Number("500"), "account": "4000"}},
		"tests":         map[string]any{"Tax": "Pass"},
	}
	out := c.ToRupees(in).(map[string]any)
	if out["gross"] != 118000.59 || out["amount_impact"] != 2500.0 {
		t.Errorf("money keys not converted: %v", out)
	}
	if out["count"] != json.Number("12") || out["tax_rate"] != json.Number("18") {
		t.Errorf("non-money keys were changed: %v", out)
	}
	if out["lines"].([]any)[0].(map[string]any)["debit"] != 5.0 {
		t.Errorf("nested money not converted: %v", out)
	}
}

func TestSchema(t *testing.T) {
	c := load(t)
	s := Schema(c.ByTool("issue_invoice").Fields)
	raw, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	for _, want := range []string{`"additionalProperties":false`, `"required":["invoice_no","date","customer_id","taxable_value","gross"]`, "Amount in rupees."} {
		if !strings.Contains(text, want) {
			t.Errorf("schema lacks %s", want)
		}
	}
}
