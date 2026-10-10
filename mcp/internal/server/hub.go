package server

import (
	"sync"
	"time"
)

// Notice is one message pushed to the UI over Server-Sent Events
// (PRD NT-3, rule C-6).
type Notice struct {
	Kind     string         `json:"kind"`
	Audience []string       `json:"-"`
	At       string         `json:"at"`
	Data     map[string]any `json:"data"`
}

type subscriber struct {
	role string
	ch   chan Notice
}

// Hub fans notices out to connected UI sessions.
type Hub struct {
	mu   sync.Mutex
	subs map[*subscriber]struct{}
}

// NewHub returns an empty hub.
func NewHub() *Hub { return &Hub{subs: map[*subscriber]struct{}{}} }

// Subscribe registers a listener for a role. Call the returned function to
// unsubscribe.
func (h *Hub) Subscribe(role string) (<-chan Notice, func()) {
	s := &subscriber{role: role, ch: make(chan Notice, 64)}
	h.mu.Lock()
	h.subs[s] = struct{}{}
	h.mu.Unlock()
	return s.ch, func() {
		h.mu.Lock()
		delete(h.subs, s)
		h.mu.Unlock()
	}
}

// Publish sends a notice to every subscriber whose role is in the audience.
// A slow subscriber misses the notice instead of blocking the caller.
func (h *Hub) Publish(n Notice) {
	if n.At == "" {
		n.At = time.Now().UTC().Format(time.RFC3339)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for s := range h.subs {
		for _, role := range n.Audience {
			if role == s.role {
				select {
				case s.ch <- n:
				default:
				}
				break
			}
		}
	}
}
