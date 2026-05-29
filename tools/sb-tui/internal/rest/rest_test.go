package rest

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNewRequiresToken(t *testing.T) {
	if _, err := New("h", "1", "   "); err != ErrNoToken {
		t.Fatalf("blank token: got %v, want ErrNoToken", err)
	}
	if _, err := New("h", "1", "sb_abc"); err != nil {
		t.Fatalf("valid token: unexpected error %v", err)
	}
}

// newTestClient points a client at a test server, bypassing New's host:port
// formatting so handlers can assert on the request directly.
func newTestClient(srv *httptest.Server) *Client {
	return &Client{BaseURL: srv.URL, Token: "sb_test", HTTP: srv.Client()}
}

func TestGetConfigProjectsAllowList(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer sb_test" {
			t.Errorf("missing bearer: %q", got)
		}
		// The settings GET returns the config object directly, with extra
		// keys (templateSettingsSchema, redacted secrets) the client ignores.
		_ = json.NewEncoder(w).Encode(map[string]any{
			"serverName":             "homelab",
			"logLevel":               "debug",
			"adminPassword":          "__REDACTED__",
			"templateSettingsSchema": map[string]any{"x": 1},
			// domain intentionally absent → should read as "".
		})
	}))
	defer srv.Close()

	cfg, err := newTestClient(srv).GetConfig(context.Background())
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	if cfg.Values["serverName"] != "homelab" {
		t.Errorf("serverName = %q", cfg.Values["serverName"])
	}
	if cfg.Values["logLevel"] != "debug" {
		t.Errorf("logLevel = %q", cfg.Values["logLevel"])
	}
	if cfg.Values["domain"] != "" {
		t.Errorf("absent domain should be empty, got %q", cfg.Values["domain"])
	}
	if _, ok := cfg.Values["adminPassword"]; ok {
		t.Error("non-allow-listed key leaked into Values")
	}
}

func TestUpdateConfigSendsMinimalPatch(t *testing.T) {
	var gotBody map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s", r.Method)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(map[string]any{"serverName": "newname"})
	}))
	defer srv.Close()

	if err := newTestClient(srv).UpdateConfig(context.Background(), "serverName", "newname"); err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}
	if len(gotBody) != 1 || gotBody["serverName"] != "newname" {
		t.Errorf("expected minimal {serverName:newname} patch, got %v", gotBody)
	}
}

func TestUnauthorizedMapsToSentinel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "Authentication required"})
	}))
	defer srv.Close()

	_, err := newTestClient(srv).GetConfig(context.Background())
	if err != ErrUnauthorized {
		t.Fatalf("got %v, want ErrUnauthorized", err)
	}
}

func TestServerErrorEnvelopeSurfaced(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": "Invalid settings payload"})
	}))
	defer srv.Close()

	err := newTestClient(srv).UpdateConfig(context.Background(), "serverName", "x")
	var apiErr *APIError
	if !asAPIError(err, &apiErr) {
		t.Fatalf("got %T (%v), want *APIError", err, err)
	}
	if apiErr.Status != 400 || !strings.Contains(apiErr.Message, "Invalid settings payload") {
		t.Errorf("APIError = %+v", apiErr)
	}
}

// asAPIError is a tiny errors.As shim kept local so the test reads top-down.
func asAPIError(err error, target **APIError) bool {
	e, ok := err.(*APIError)
	if ok {
		*target = e
	}
	return ok
}
