package tools

import (
	"context"
	"fmt"
	"html"
	"net/http"
	"sort"
	"strings"

	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/catalogue"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/core"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/files"
	"github.com/ELEVATE-1-0/ELEV05/mcp/internal/mail"
)

// Report emails. Each kind has a fixed audience, so a caller chooses what to
// send, never where it goes:
//
//	findings_review    audit manager and partner  potential findings, internal only
//	evidence_reminder  client staff               documents still awaited
//	findings_memo      client management          confirmed findings, after sign-off
//
// Potential findings never reach the client: only findings_memo goes to the
// client side, and only once the engagement is signed off.
var emailKinds = []string{"findings_review", "evidence_reminder", "findings_memo"}

func emailTools(d *Deps) []*Tool {
	return []*Tool{{
		Name:  "send_report_email",
		Group: "Outputs",
		Description: "Email a report about the engagement. kind findings_review tells the audit manager and partner how many findings await review; " +
			"evidence_reminder tells the client which documents are still awaited; findings_memo sends the confirmed findings memo to the client's management and needs the engagement signed off and the audit manager role. " +
			"Recipients come from the server's configuration, never from the call. Each email states the snapshot hash it rests on. " +
			"When email is not configured the message is returned as a preview and nothing is sent.",
		Roles: auditRoles,
		Fields: []catalogue.Field{
			fEngagement,
			{Name: "kind", Type: "enum", Required: true, Values: emailKinds, Description: "Which report to send."},
			str("file_hash", "For findings_memo: the file_hash of the memo returned by draft_findings_memo, quoted in the email so the reader can check the file."),
			str("note", "A short note from the sender, placed at the top of the email."),
		},
		Handler: func(ctx context.Context, c *core.Call) (map[string]any, *core.ToolError) {
			return sendReportEmail(ctx, d, c)
		},
	}}
}

func sendReportEmail(ctx context.Context, d *Deps, c *core.Call) (map[string]any, *core.ToolError) {
	if d.Mail == nil {
		return nil, core.Errf(core.CodeInternal, "Restart the server with email settings.", "Email is not available on this server.")
	}
	kind := core.Str(c.Args, "kind")
	note := strings.TrimSpace(core.Str(c.Args, "note"))
	if len(note) > 1000 {
		return nil, core.Errf(core.CodeValidationFailed, "Shorten the note to 1,000 characters or fewer.", "note is too long.")
	}

	q := map[string]any{}
	if id := core.Str(c.Args, "engagement_id"); id != "" {
		q["engagement_id"] = id
	}
	status, terr := d.Engine.Do(ctx, c.Identity, http.MethodGet, "/engagements/status", q)
	if terr != nil {
		return nil, terr
	}
	eng := emailEngagement{
		ID:           core.Str(status, "engagement_id"),
		Start:        core.Str(status, "period_start"),
		End:          core.Str(status, "period_end"),
		SnapshotHash: core.Str(status, "snapshot_hash"),
		SignedOff:    status["signed_off"] == true,
	}
	if eng.ID != "" {
		q["engagement_id"] = eng.ID
	}

	var msg mail.Message
	extra := map[string]any{}
	switch kind {
	case "findings_review":
		found, terr := d.Engine.Do(ctx, c.Identity, http.MethodGet, "/findings", map[string]any{"engagement_id": eng.ID, "limit": 500})
		if terr != nil {
			return nil, terr
		}
		msg = findingsReviewMessage(eng, toRupees(d, found), note)
		msg.Audience = mail.ToManager
	case "evidence_reminder":
		ev, terr := d.Engine.Do(ctx, c.Identity, http.MethodGet, "/evidence/status", map[string]any{"engagement_id": eng.ID})
		if terr != nil {
			return nil, terr
		}
		var pending int
		msg, pending = evidenceReminderMessage(eng, ev, note)
		if pending == 0 {
			return nil, core.Errf(core.CodeInvalidTransition, "Nothing to remind the client about. Call get_evidence_status to check.", "No documents are awaited from the client.")
		}
		msg.Audience = mail.ToClient
		extra["documents_awaited"] = pending
	case "findings_memo":
		if c.Identity.Role != core.RoleManager {
			return nil, core.Errf(core.CodeNotPermitted, "Ask the audit manager to send the memo.", "Only the audit manager can send findings to the client.")
		}
		if !eng.SignedOff {
			return nil, core.Errf(core.CodeInvalidTransition, "Sign off the engagement with sign_off_engagement first.", "Findings go to the client only after the engagement is signed off.")
		}
		hash := core.Str(c.Args, "file_hash")
		var meta files.Meta
		if hash != "" {
			if !files.ValidHash(hash) {
				return nil, core.Errf(core.CodeValidationFailed, "Pass the 64-character file_hash returned by draft_findings_memo.", "file_hash is not a SHA-256.")
			}
			m, err := d.Files.Stat(ctx, hash)
			if err != nil {
				return nil, core.Errf(core.CodeNotFound, "Call draft_findings_memo and pass the file_hash it returns.", "No file has hash %s.", hash)
			}
			meta = m
		}
		found, terr := d.Engine.Do(ctx, c.Identity, http.MethodGet, "/findings", map[string]any{"engagement_id": eng.ID, "status": "confirmed", "limit": 500})
		if terr != nil {
			return nil, terr
		}
		msg = findingsMemoMessage(eng, toRupees(d, found), meta, note)
		msg.Audience = mail.ToClientManagement
	default:
		return nil, core.Errf(core.CodeValidationFailed, "Pass kind as one of: "+strings.Join(emailKinds, ", ")+".", "Unknown kind %q.", kind)
	}

	res, err := d.Mail.Send(ctx, msg)
	if err != nil {
		return nil, &core.ToolError{Code: core.CodeInternal, Message: err.Error(), NextStep: "Check the SendGrid API key, the verified sender in EMAIL_FROM, and the recipient addresses, then retry."}
	}
	out := map[string]any{
		"engagement_id": eng.ID,
		"kind":          kind,
		"sent":          res.Sent,
		"preview":       res.Preview,
		"provider":      res.Provider,
		"message_id":    res.MessageID,
		"audience":      res.Audience,
		"recipients":    res.Recipients,
		"subject":       res.Subject,
		"text":          res.Text,
		"snapshot_hash": eng.SnapshotHash,
	}
	if res.Reason != "" {
		out["reason"] = res.Reason
	}
	for k, v := range extra {
		out[k] = v
	}
	return out, nil
}

type emailEngagement struct {
	ID, Start, End, SnapshotHash string
	SignedOff                    bool
}

func (e emailEngagement) period() string {
	if e.Start == "" {
		return "the audit period"
	}
	return e.Start + " to " + e.End
}

// footer ties every email to the frozen records it describes.
func (e emailEngagement) footer() []string {
	lines := []string{"", "Engagement " + e.ID + ", period " + e.period() + "."}
	if e.SnapshotHash != "" {
		lines = append(lines, "Snapshot hash "+e.SnapshotHash+". Every figure here is computed from that frozen copy of the records.")
	}
	lines = append(lines, "Open the Revenue Audit workspace to see the detail. This message was sent by the audit system and recorded in its audit trail.")
	return lines
}

func findingsReviewMessage(e emailEngagement, found map[string]any, note string) mail.Message {
	list := mapList(found["findings"])
	by := map[string]int{}
	awaiting := 0
	var open []map[string]any
	for _, f := range list {
		by[core.Str(f, "severity")]++
		if s := core.Str(f, "status"); s == "proposed" || s == "needs_info" {
			awaiting++
			open = append(open, f)
		}
	}
	awaitingAmount := onceBySubject(open)
	top := topFindings(list, 5)
	subject := fmt.Sprintf("Revenue audit %s: %d findings await your review", e.period(), awaiting)
	lines := []string{}
	if note != "" {
		lines = append(lines, note, "")
	}
	lines = append(lines,
		fmt.Sprintf("%d findings are awaiting review, flagging Rs %s of potential misstatement before review, each subject counted once.", awaiting, inrText(awaitingAmount)),
		fmt.Sprintf("By severity: %d high, %d medium, %d low.", by["High"], by["Medium"], by["Low"]),
		"These are potential findings for the audit team only. Do not forward them to the client before review.",
	)
	if len(top) > 0 {
		lines = append(lines, "", "Largest high-severity findings:")
		for i, f := range top {
			lines = append(lines, fmt.Sprintf("%d. %s (Rs %s)", i+1, core.Str(f, "title"), inrText(num(f["amount_impact"]))))
		}
	}
	lines = append(lines, e.footer()...)
	return mail.Message{Subject: subject, Text: strings.Join(lines, "\n"), HTML: toHTML(lines)}
}

func evidenceReminderMessage(e emailEngagement, ev map[string]any, note string) (mail.Message, int) {
	type item struct{ doc, sample string }
	var items []item
	for _, s := range mapList(ev["samples"]) {
		for _, doc := range mapList(s["documents"]) {
			if core.Str(doc, "status") == "pending" {
				items = append(items, item{core.Str(doc, "document_type"), core.Str(s, "sample_id")})
			}
		}
	}
	names := map[string]string{"invoice": "Invoice", "eway_bill": "E-way bill", "lr_copy": "LR copy", "credit_note": "Credit note", "sales_return": "Sales return"}
	subject := fmt.Sprintf("Documents requested for the revenue audit %s: %d awaited", e.period(), len(items))
	lines := []string{}
	if note != "" {
		lines = append(lines, note, "")
	}
	lines = append(lines, fmt.Sprintf("The auditors are still waiting for %d documents. Please upload them from the Requests page of the workspace.", len(items)), "")
	for i, it := range items {
		if i == 25 {
			lines = append(lines, fmt.Sprintf("and %d more, listed on the Requests page.", len(items)-25))
			break
		}
		n := names[it.doc]
		if n == "" {
			n = it.doc
		}
		lines = append(lines, fmt.Sprintf("- %s for sample %s", n, it.sample))
	}
	lines = append(lines, e.footer()...)
	return mail.Message{Subject: subject, Text: strings.Join(lines, "\n"), HTML: toHTML(lines)}, len(items)
}

func findingsMemoMessage(e emailEngagement, found map[string]any, memo files.Meta, note string) mail.Message {
	list := mapList(found["findings"])
	total := onceBySubject(list)
	subject := fmt.Sprintf("Revenue audit %s: findings memo", e.period())
	lines := []string{}
	if note != "" {
		lines = append(lines, note, "")
	}
	lines = append(lines,
		"The audit of revenue for "+e.period()+" is signed off.",
		fmt.Sprintf("%d findings were confirmed by the audit manager, with a total impact of Rs %s.", len(list), inrText(total)),
	)
	if memo.Hash != "" {
		lines = append(lines, "", "The findings memo is "+memo.Name+", SHA-256 "+memo.Hash+". The copy you receive from the workspace must have this hash.")
	}
	lines = append(lines, e.footer()...)
	return mail.Message{Subject: subject, Text: strings.Join(lines, "\n"), HTML: toHTML(lines)}
}

// toRupees converts the engine's paise to rupees, as the gateway does for every tool result.
func toRupees(d *Deps, v map[string]any) map[string]any {
	if d.Cat == nil {
		return v
	}
	if m, ok := d.Cat.ToRupees(v).(map[string]any); ok {
		return m
	}
	return v
}

// toHTML renders the plain lines as simple, escaped paragraphs.
func toHTML(lines []string) string {
	var b strings.Builder
	b.WriteString(`<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1b1d22">`)
	for _, l := range lines {
		if l == "" {
			b.WriteString("<br>")
			continue
		}
		b.WriteString("<p style=\"margin:0 0 6px\">" + html.EscapeString(l) + "</p>")
	}
	b.WriteString("</div>")
	return b.String()
}

// onceBySubject totals findings counting each subject (one invoice, one
// customer, one cycle) once, at the largest amount any of its findings
// carries, as the workspace does. Findings on the same subject would
// otherwise add the same rupees twice.
func onceBySubject(list []map[string]any) float64 {
	best := map[string]float64{}
	for i, f := range list {
		key := fmt.Sprint("finding:", i)
		if subj, ok := f["subject"].(map[string]any); ok && core.Str(subj, "id") != "" {
			key = core.Str(subj, "type") + ":" + core.Str(subj, "id")
		}
		if v := num(f["amount_impact"]); v > best[key] {
			best[key] = v
		} else if _, seen := best[key]; !seen {
			best[key] = v
		}
	}
	var total float64
	for _, v := range best {
		total += v
	}
	return total
}

func mapList(v any) []map[string]any {
	raw, _ := v.([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func num(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int:
		return float64(t)
	case int64:
		return float64(t)
	}
	return 0
}

func topFindings(list []map[string]any, n int) []map[string]any {
	var high []map[string]any
	for _, f := range list {
		if core.Str(f, "severity") == "High" && core.Str(f, "status") != "rejected" {
			high = append(high, f)
		}
	}
	sort.SliceStable(high, func(i, j int) bool { return num(high[i]["amount_impact"]) > num(high[j]["amount_impact"]) })
	if len(high) > n {
		high = high[:n]
	}
	return high
}

// rupees formats an amount in the Indian grouping, for example 12,34,567.89.
func inrText(v float64) string {
	neg := v < 0
	if neg {
		v = -v
	}
	whole := int64(v)
	paise := int64((v-float64(whole))*100 + 0.5)
	if paise == 100 {
		whole++
		paise = 0
	}
	s := fmt.Sprint(whole)
	if len(s) > 3 {
		head, tail := s[:len(s)-3], s[len(s)-3:]
		var parts []string
		for len(head) > 2 {
			parts = append([]string{head[len(head)-2:]}, parts...)
			head = head[:len(head)-2]
		}
		if head != "" {
			parts = append([]string{head}, parts...)
		}
		s = strings.Join(parts, ",") + "," + tail
	}
	out := fmt.Sprintf("%s.%02d", s, paise)
	if neg {
		out = "-" + out
	}
	return out
}
