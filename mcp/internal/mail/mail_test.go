package mail

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPreviewWithoutKey(t *testing.T) {
	m := New(Config{To: map[string][]string{ToManager: {"manager@example.com"}}})
	res, err := m.Send(context.Background(), Message{Audience: ToManager, Subject: "s", Text: "t"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Sent || !res.Preview || !strings.Contains(res.Reason, "SENDGRID_API_KEY") {
		t.Fatalf("want a preview naming the missing key, got %+v", res)
	}
}

func TestPreviewWithoutRecipients(t *testing.T) {
	m := New(Config{APIKey: "k", From: "audit@example.com"})
	res, err := m.Send(context.Background(), Message{Audience: ToClient, Subject: "s", Text: "t"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Sent || !res.Preview || !strings.Contains(res.Reason, "EMAIL_TO_CLIENT") {
		t.Fatalf("want a preview naming EMAIL_TO_CLIENT, got %+v", res)
	}
}

func TestSendsThroughSendGrid(t *testing.T) {
	var got map[string]any
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &got)
		w.Header().Set("X-Message-Id", "msg-123")
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	m := New(Config{APIKey: "SG.test", From: "audit@example.com", Endpoint: srv.URL, To: map[string][]string{ToManager: {"a@example.com", "b@example.com"}}})
	res, err := m.Send(context.Background(), Message{Audience: ToManager, Subject: "Findings", Text: "plain", HTML: "<p>plain</p>"})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Sent || res.MessageID != "msg-123" || len(res.Recipients) != 2 {
		t.Fatalf("unexpected result %+v", res)
	}
	if auth != "Bearer SG.test" {
		t.Fatalf("authorization header %q", auth)
	}
	if got["subject"] != "Findings" {
		t.Fatalf("subject %v", got["subject"])
	}
	to := got["personalizations"].([]any)[0].(map[string]any)["to"].([]any)
	if len(to) != 2 || to[0].(map[string]any)["email"] != "a@example.com" {
		t.Fatalf("recipients %v", to)
	}
	if from := got["from"].(map[string]any); from["email"] != "audit@example.com" {
		t.Fatalf("from %v", from)
	}
}

func TestSendGridErrorIsReported(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"errors":[{"message":"The from address does not match a verified Sender Identity."}]}`))
	}))
	defer srv.Close()
	m := New(Config{APIKey: "SG.test", From: "audit@example.com", Endpoint: srv.URL, To: map[string][]string{ToClient: {"c@example.com"}}})
	_, err := m.Send(context.Background(), Message{Audience: ToClient, Subject: "s", Text: "t"})
	if err == nil || !strings.Contains(err.Error(), "403") || !strings.Contains(err.Error(), "verified Sender") {
		t.Fatalf("want the SendGrid error passed through, got %v", err)
	}
}

func TestParseList(t *testing.T) {
	got := ParseList(" a@x.com, b@x.com; ;c@x.com ")
	if strings.Join(got, "|") != "a@x.com|b@x.com|c@x.com" {
		t.Fatalf("got %v", got)
	}
}
