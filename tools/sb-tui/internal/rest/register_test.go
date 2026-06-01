package rest

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRegisterNasSourcePostsCreds(t *testing.T) {
	var got map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/system/external-backup/register" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sb_test" {
			t.Errorf("missing bearer: %q", got)
		}
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &got)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "changed": true})
	}))
	defer srv.Close()

	if err := newTestClient(srv).RegisterNasSource(context.Background(), "192.168.178.1", "fritz9746", "pw"); err != nil {
		t.Fatalf("RegisterNasSource: %v", err)
	}
	if got["host"] != "192.168.178.1" || got["username"] != "fritz9746" || got["password"] != "pw" {
		t.Errorf("posted creds = %+v", got)
	}
}

func TestRegisterNasSourceSurfacesError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": "host is required"})
	}))
	defer srv.Close()

	err := newTestClient(srv).RegisterNasSource(context.Background(), "", "u", "p")
	if err == nil {
		t.Fatal("expected an error for a 400 response")
	}
	var apiErr *APIError
	if !asAPIError(err, &apiErr) || apiErr.Status != 400 {
		t.Fatalf("want *APIError status 400, got %v", err)
	}
}
