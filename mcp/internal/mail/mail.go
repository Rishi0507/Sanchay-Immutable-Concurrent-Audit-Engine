// Package mail sends report emails through Twilio SendGrid (v3 Mail Send API).
//
// Without an API key the mailer runs in preview mode: it builds the message
// and returns it without sending, so the rest of the system behaves the same
// in a demo that has no email account.
package mail

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Audiences a report can be addressed to. Each maps to a configured list of
// addresses; tool arguments never carry addresses.
const (
	ToManager          = "manager"           // the audit manager who reviews findings
	ToPartner          = "partner"           // the engagement partner who signs the opinion
	ToAuditor          = "auditor"           // the audit team
	ToClient           = "client"            // the client's staff who answer evidence requests
	ToClientManagement = "client_management" // the client's management and audit committee
)

// Config is read from the environment by the server.
type Config struct {
	APIKey   string              // SENDGRID_API_KEY; empty means preview mode
	From     string              // EMAIL_FROM, a sender verified in SendGrid
	FromName string              // EMAIL_FROM_NAME
	Endpoint string              // SENDGRID_ENDPOINT, for tests; defaults to the public API
	To       map[string][]string // audience to addresses
}

// Message is one email to one audience.
type Message struct {
	Audience string
	Subject  string
	Text     string
	HTML     string
}

// Result says what happened to a message. It is returned to the caller and,
// through the tool result, hashed into the audit trail.
type Result struct {
	Sent       bool     `json:"sent"`
	Preview    bool     `json:"preview"`
	Provider   string   `json:"provider"`
	MessageID  string   `json:"message_id,omitempty"`
	Audience   string   `json:"audience"`
	Recipients []string `json:"recipients"`
	Subject    string   `json:"subject"`
	Text       string   `json:"text"`
	Reason     string   `json:"reason,omitempty"`
}

// Mailer sends messages.
type Mailer struct {
	cfg  Config
	http *http.Client
}

// New returns a mailer. It never fails: missing settings put it in preview mode.
func New(cfg Config) *Mailer {
	if cfg.Endpoint == "" {
		cfg.Endpoint = "https://api.sendgrid.com/v3/mail/send"
	}
	if cfg.FromName == "" {
		cfg.FromName = "Revenue Audit"
	}
	return &Mailer{cfg: cfg, http: &http.Client{Timeout: 15 * time.Second}}
}

// Configured reports whether real sending is possible.
func (m *Mailer) Configured() bool {
	return m.cfg.APIKey != "" && m.cfg.From != ""
}

// Recipients returns the addresses configured for an audience.
func (m *Mailer) Recipients(audience string) []string {
	return m.cfg.To[audience]
}

// Send delivers the message, or previews it when sending is not configured
// or the audience has no addresses.
func (m *Mailer) Send(ctx context.Context, msg Message) (Result, error) {
	to := m.Recipients(msg.Audience)
	res := Result{Provider: "sendgrid", Audience: msg.Audience, Recipients: to, Subject: msg.Subject, Text: msg.Text}
	switch {
	case !m.Configured():
		res.Preview = true
		res.Reason = "Email is not configured: set SENDGRID_API_KEY and EMAIL_FROM. Nothing was sent."
		return res, nil
	case len(to) == 0:
		res.Preview = true
		res.Reason = fmt.Sprintf("No addresses are configured for %s: set %s. Nothing was sent.", msg.Audience, EnvFor(msg.Audience))
		return res, nil
	}

	personal := make([]map[string]string, len(to))
	for i, addr := range to {
		personal[i] = map[string]string{"email": addr}
	}
	content := []map[string]string{{"type": "text/plain", "value": msg.Text}}
	if msg.HTML != "" {
		content = append(content, map[string]string{"type": "text/html", "value": msg.HTML})
	}
	body := map[string]any{
		// One personalization per message keeps every recipient visible to the others,
		// which suits a small, named audit distribution list.
		"personalizations": []map[string]any{{"to": personal}},
		"from":             map[string]string{"email": m.cfg.From, "name": m.cfg.FromName},
		"subject":          msg.Subject,
		"content":          content,
		// Links in audit emails point at the app; rewriting them for click tracking would hide where they go.
		"tracking_settings": map[string]any{"click_tracking": map[string]bool{"enable": false}},
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return res, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.cfg.Endpoint, bytes.NewReader(raw))
	if err != nil {
		return res, err
	}
	req.Header.Set("Authorization", "Bearer "+m.cfg.APIKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := m.http.Do(req)
	if err != nil {
		return res, fmt.Errorf("sendgrid unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return res, fmt.Errorf("sendgrid answered %d: %s", resp.StatusCode, strings.TrimSpace(string(detail)))
	}
	res.Sent = true
	res.MessageID = resp.Header.Get("X-Message-Id")
	return res, nil
}

// EnvFor names the environment variable that lists an audience's addresses.
func EnvFor(audience string) string {
	return "EMAIL_TO_" + strings.ToUpper(audience)
}

// ParseList splits a comma- or semicolon-separated list of addresses.
func ParseList(s string) []string {
	var out []string
	for _, part := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ';' }) {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}
