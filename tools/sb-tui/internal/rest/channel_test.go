package rest

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGetChannel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/system/channel" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"channel": "dev"})
	}))
	defer srv.Close()

	ch, err := newTestClient(srv).GetChannel(context.Background())
	if err != nil {
		t.Fatalf("GetChannel: %v", err)
	}
	if ch != "dev" {
		t.Errorf("channel = %q, want dev", ch)
	}
}

func TestSetChannelPostsChannel(t *testing.T) {
	var body map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s", r.Method)
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "channel": body["channel"]})
	}))
	defer srv.Close()

	if err := newTestClient(srv).SetChannel(context.Background(), "latest"); err != nil {
		t.Fatalf("SetChannel: %v", err)
	}
	if body["channel"] != "latest" {
		t.Errorf("posted channel = %q, want latest", body["channel"])
	}
}
