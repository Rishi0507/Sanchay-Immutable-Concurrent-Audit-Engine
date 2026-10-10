// Package catalogue loads contracts/events.json and turns its field
// specifications into JSON Schema, input validation and money conversion.
// Every tool, catalogue-driven or not, describes its inputs with Field, so
// there is one validator and one schema generator.
package catalogue

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Field describes one input field.
type Field struct {
	Name        string   `json:"name"`
	Type        string   `json:"type"`
	Required    bool     `json:"required"`
	Description string   `json:"description"`
	Values      []string `json:"values"`
	Ref         string   `json:"ref"`
	Shared      string   `json:"shared"`
	Fields      []Field  `json:"fields"`
}

// Account is one entry of the chart of accounts.
type Account struct {
	Code string `json:"code"`
	Name string `json:"name"`
	Type string `json:"type"`
}

// Event describes one event type and the tool that creates it.
type Event struct {
	Type         string  `json:"type"`
	Tool         string  `json:"tool"`
	Aggregate    string  `json:"aggregate"`
	Prefix       string  `json:"prefix"`
	Mode         string  `json:"mode"`
	Sale         string  `json:"sale"`
	Posts        bool    `json:"posts"`
	BusinessDate string  `json:"business_date"`
	Description  string  `json:"description"`
	Fields       []Field `json:"fields"`
}

// Catalogue is the parsed contract.
type Catalogue struct {
	Version  int                `json:"version"`
	Accounts []Account          `json:"accounts"`
	Shared   map[string][]Field `json:"shared"`
	Events   []Event            `json:"events"`

	byTool      map[string]*Event
	byType      map[string]*Event
	byAggregate map[string]*Event
	moneyKeys   map[string]bool
}

// Load reads and indexes the catalogue file.
func Load(path string) (*Catalogue, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read catalogue: %w", err)
	}
	var c Catalogue
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("parse catalogue: %w", err)
	}
	c.byTool = map[string]*Event{}
	c.byType = map[string]*Event{}
	c.byAggregate = map[string]*Event{}
	c.moneyKeys = map[string]bool{}
	for i := range c.Events {
		e := &c.Events[i]
		fields, err := c.expand(e.Fields)
		if err != nil {
			return nil, fmt.Errorf("event %s: %w", e.Type, err)
		}
		e.Fields = fields
		c.byTool[e.Tool] = e
		c.byType[e.Type] = e
		if e.Mode == "create" {
			c.byAggregate[e.Aggregate] = e
		}
		collectMoney(e.Fields, c.moneyKeys)
	}
	for _, k := range extraMoneyKeys {
		c.moneyKeys[k] = true
	}
	return &c, nil
}

// extraMoneyKeys are money fields that appear in service responses but not in
// event payloads. See contracts/README.md.
var extraMoneyKeys = []string{
	"amount_impact", "total_adjustment", "sales_value", "debit", "credit",
	"balance", "total", "total_debit", "total_credit",
}

func (c *Catalogue) expand(fields []Field) ([]Field, error) {
	out := make([]Field, len(fields))
	for i, f := range fields {
		if f.Shared != "" {
			shared, ok := c.Shared[f.Shared]
			if !ok {
				return nil, fmt.Errorf("field %s: unknown shared block %q", f.Name, f.Shared)
			}
			f.Fields = shared
		}
		if len(f.Fields) > 0 {
			sub, err := c.expand(f.Fields)
			if err != nil {
				return nil, err
			}
			f.Fields = sub
		}
		out[i] = f
	}
	return out, nil
}

func collectMoney(fields []Field, into map[string]bool) {
	for _, f := range fields {
		if f.Type == "money" || f.Type == "signed_money" {
			into[f.Name] = true
		}
		collectMoney(f.Fields, into)
	}
}

// ByTool returns the event created by a tool.
func (c *Catalogue) ByTool(tool string) *Event { return c.byTool[tool] }

// ByType returns the event of a type.
func (c *Catalogue) ByType(t string) *Event { return c.byType[t] }

// ByAggregate returns the event that creates an aggregate type.
func (c *Catalogue) ByAggregate(a string) *Event { return c.byAggregate[a] }

// AggregateTypes lists the aggregate types that have a creating event.
func (c *Catalogue) AggregateTypes() []string {
	out := make([]string, 0, len(c.byAggregate))
	for k := range c.byAggregate {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// RefFields returns the names of the ref and ref_list fields of an event, in
// declaration order.
func (e *Event) RefFields() []Field {
	var out []Field
	for _, f := range e.Fields {
		if f.Type == "ref" || f.Type == "ref_list" {
			out = append(out, f)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// JSON Schema

// Schema builds a JSON Schema object for a set of fields.
func Schema(fields []Field) map[string]any {
	props := map[string]any{}
	var required []string
	for _, f := range fields {
		props[f.Name] = fieldSchema(f)
		if f.Required {
			required = append(required, f.Name)
		}
	}
	s := map[string]any{
		"type":                 "object",
		"properties":           props,
		"additionalProperties": false,
	}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

func fieldSchema(f Field) map[string]any {
	s := map[string]any{}
	desc := f.Description
	add := func(note string) {
		if desc == "" {
			desc = note
		} else {
			desc = strings.TrimRight(desc, " ") + " " + note
		}
	}
	switch f.Type {
	case "string":
		s["type"] = "string"
	case "int":
		s["type"] = "integer"
	case "number":
		s["type"] = "number"
	case "bool":
		s["type"] = "boolean"
	case "date":
		s["type"] = "string"
		s["format"] = "date"
		add("Format YYYY-MM-DD.")
	case "datetime":
		s["type"] = "string"
		s["format"] = "date-time"
		add("Format RFC 3339, for example 2025-03-30T14:05:00Z.")
	case "money":
		s["type"] = "number"
		s["minimum"] = 0
		add("Amount in rupees.")
	case "signed_money":
		s["type"] = "number"
		add("Amount in rupees, may be negative.")
	case "enum":
		s["type"] = "string"
		s["enum"] = f.Values
	case "ref":
		s["type"] = "string"
		add(fmt.Sprintf("Identifier of an existing %s.", f.Ref))
	case "ref_list":
		s["type"] = "array"
		s["items"] = map[string]any{"type": "string"}
		add(fmt.Sprintf("Identifiers of existing %s records.", f.Ref))
	case "string_list":
		s["type"] = "array"
		s["items"] = map[string]any{"type": "string"}
	case "array":
		s["type"] = "array"
		s["items"] = Schema(f.Fields)
	case "object":
		s["type"] = "object"
	default:
		s["type"] = "string"
	}
	if desc != "" {
		s["description"] = desc
	}
	return s
}

// ---------------------------------------------------------------------------
// Validation and normalisation

// Normalise checks args against fields and returns a cleaned copy: money in
// paise, dates and times in canonical form, absent optional values dropped.
// It returns every problem found, so an agent can fix them in one retry.
func Normalise(fields []Field, args map[string]any) (map[string]any, []string) {
	var problems []string
	out := normaliseObject(fields, args, "", &problems)
	return out, problems
}

func normaliseObject(fields []Field, args map[string]any, path string, problems *[]string) map[string]any {
	known := map[string]Field{}
	names := make([]string, 0, len(fields))
	for _, f := range fields {
		known[f.Name] = f
		names = append(names, f.Name)
	}
	for k := range args {
		if _, ok := known[k]; !ok {
			*problems = append(*problems, fmt.Sprintf("%s%s is not a known field. Allowed fields: %s.", path, k, strings.Join(names, ", ")))
		}
	}
	out := map[string]any{}
	for _, f := range fields {
		v, present := args[f.Name]
		if !present || v == nil || v == "" {
			if f.Required {
				*problems = append(*problems, fmt.Sprintf("%s%s is required.", path, f.Name))
			}
			continue
		}
		nv, err := normaliseValue(f, v, path+f.Name, problems)
		if err != "" {
			*problems = append(*problems, fmt.Sprintf("%s%s %s", path, f.Name, err))
			continue
		}
		if nv != nil {
			out[f.Name] = nv
		}
	}
	return out
}

func normaliseValue(f Field, v any, path string, problems *[]string) (any, string) {
	switch f.Type {
	case "string", "ref":
		switch t := v.(type) {
		case string:
			return t, ""
		case json.Number:
			return t.String(), ""
		case float64:
			return strconv.FormatFloat(t, 'f', -1, 64), ""
		}
		return nil, "must be a string."
	case "int":
		n, ok := toFloat(v)
		if !ok || n != math.Trunc(n) {
			return nil, "must be a whole number."
		}
		return int64(n), ""
	case "number":
		n, ok := toFloat(v)
		if !ok {
			return nil, "must be a number."
		}
		return n, ""
	case "bool":
		switch t := v.(type) {
		case bool:
			return t, ""
		case string:
			if b, err := strconv.ParseBool(t); err == nil {
				return b, ""
			}
		}
		return nil, "must be true or false."
	case "date":
		s, ok := v.(string)
		if !ok {
			return nil, "must be a date string in the form YYYY-MM-DD."
		}
		d, err := parseDate(s)
		if err != nil {
			return nil, "must be a date in the form YYYY-MM-DD."
		}
		return d, ""
	case "datetime":
		s, ok := v.(string)
		if !ok {
			return nil, "must be a date and time string in RFC 3339 form."
		}
		d, err := parseDateTime(s)
		if err != nil {
			return nil, "must be a date and time in RFC 3339 form, for example 2025-03-30T14:05:00Z."
		}
		return d, ""
	case "money", "signed_money":
		n, ok := toFloat(v)
		if !ok {
			return nil, "must be an amount in rupees, for example 118000.50."
		}
		if f.Type == "money" && n < 0 {
			return nil, "must not be negative."
		}
		return int64(math.Round(n * 100)), ""
	case "enum":
		s, ok := v.(string)
		if ok {
			for _, allowed := range f.Values {
				if s == allowed {
					return s, ""
				}
			}
		}
		return nil, fmt.Sprintf("must be one of: %s.", strings.Join(f.Values, ", "))
	case "ref_list", "string_list":
		list, ok := v.([]any)
		if !ok {
			if s, isStr := v.(string); isStr {
				return []any{s}, ""
			}
			return nil, "must be a list of strings."
		}
		out := make([]any, 0, len(list))
		for _, item := range list {
			s, ok := item.(string)
			if !ok || s == "" {
				return nil, "must be a list of non-empty strings."
			}
			out = append(out, s)
		}
		if len(out) == 0 {
			return nil, ""
		}
		return out, ""
	case "array":
		list, ok := v.([]any)
		if !ok {
			return nil, "must be a list of objects."
		}
		out := make([]any, 0, len(list))
		for i, item := range list {
			obj, ok := item.(map[string]any)
			if !ok {
				return nil, fmt.Sprintf("item %d must be an object.", i+1)
			}
			out = append(out, normaliseObject(f.Fields, obj, fmt.Sprintf("%s[%d].", path, i), problems))
		}
		return out, ""
	case "object":
		obj, ok := v.(map[string]any)
		if !ok {
			return nil, "must be an object."
		}
		return obj, ""
	}
	return v, ""
}

func toFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case int:
		return float64(t), true
	case int64:
		return float64(t), true
	case json.Number:
		f, err := t.Float64()
		return f, err == nil
	case string:
		s := strings.ReplaceAll(strings.TrimSpace(t), ",", "")
		f, err := strconv.ParseFloat(s, 64)
		return f, err == nil
	}
	return 0, false
}

func parseDate(s string) (string, error) {
	s = strings.TrimSpace(s)
	if t, err := time.Parse("2006-01-02", s); err == nil {
		return t.Format("2006-01-02"), nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UTC().Format("2006-01-02"), nil
	}
	return "", fmt.Errorf("bad date")
}

func parseDateTime(s string) (string, error) {
	s = strings.TrimSpace(s)
	layouts := []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02T15:04", "2006-01-02 15:04", "2006-01-02"}
	for _, l := range layouts {
		if t, err := time.Parse(l, s); err == nil {
			return t.UTC().Format(time.RFC3339), nil
		}
	}
	return "", fmt.Errorf("bad datetime")
}

// DatePart returns the YYYY-MM-DD part of a normalised date or datetime.
func DatePart(v any) string {
	s, _ := v.(string)
	if len(s) >= 10 {
		return s[:10]
	}
	return ""
}

// ---------------------------------------------------------------------------
// Money conversion at the tool boundary

// IsMoneyKey reports whether a JSON key holds paise in service data.
func (c *Catalogue) IsMoneyKey(k string) bool {
	if c.moneyKeys[k] {
		return true
	}
	return strings.HasSuffix(k, "_amount") || strings.HasSuffix(k, "_value") || strings.HasSuffix(k, "_total")
}

// ToRupees walks decoded JSON and converts integer paise under money keys to
// rupees. Values that are not whole numbers are left alone.
func (c *Catalogue) ToRupees(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			if c.IsMoneyKey(k) {
				if p, ok := wholeNumber(val); ok {
					out[k] = float64(p) / 100
					continue
				}
			}
			out[k] = c.ToRupees(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = c.ToRupees(val)
		}
		return out
	}
	return v
}

func wholeNumber(v any) (int64, bool) {
	switch t := v.(type) {
	case int64:
		return t, true
	case int:
		return int64(t), true
	case int32:
		return int64(t), true
	case json.Number:
		i, err := t.Int64()
		return i, err == nil
	case float64:
		if t == math.Trunc(t) && math.Abs(t) < 1e15 {
			return int64(t), true
		}
	}
	return 0, false
}
