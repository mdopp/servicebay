package rest

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestLoginFlow covers the two-step login: POST /api/auth/login sets a session
// cookie, which the mint call to /api/system/api-tokens must carry back to get
// the sb_ secret.
func TestLoginFlow(t *testing.T) {
	var mintGotCookie bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The proxy CSRF gate needs a same-origin header on these mutating
		// POSTs; Login must set it or the box 403s "cross-site request".
		if o := r.Header.Get("Origin"); o != "http://"+r.Host {
			t.Errorf("Origin = %q, want http://%s", o, r.Host)
		}
		switch r.URL.Path {
		case "/api/auth/login":
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["username"] != "admin" || body["password"] != "secret" {
				w.WriteHeader(http.StatusUnauthorized)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": "Invalid credentials"})
				return
			}
			http.SetCookie(w, &http.Cookie{Name: "sb_session", Value: "cookie-123", Path: "/"})
			_ = json.NewEncoder(w).Encode(map[string]bool{"success": true})
		case "/api/system/api-tokens":
			if c, err := r.Cookie("sb_session"); err == nil && c.Value == "cookie-123" {
				mintGotCookie = true
			}
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["name"] != tuiTokenName {
				t.Errorf("mint name = %v", body["name"])
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"secret": "sb_minted_abc"})
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	host, port := hostPort(t, srv)
	tok, err := Login(context.Background(), host, port, "admin", "secret")
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if tok != "sb_minted_abc" {
		t.Errorf("token = %q", tok)
	}
	if !mintGotCookie {
		t.Error("mint call did not carry the session cookie")
	}
}

func TestLoginRejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "Invalid credentials"})
	}))
	defer srv.Close()

	host, port := hostPort(t, srv)
	_, err := Login(context.Background(), host, port, "admin", "wrong")
	if err != ErrLoginRejected {
		t.Fatalf("got %v, want ErrLoginRejected", err)
	}
}

// TestDelegateSubset covers the happy path: a parent token is presented as a
// Bearer credential to POST /api/system/api-tokens/delegate, requesting a scope
// subset + a TTL (expiresAt), and the box returns the minted child secret.
func TestDelegateSubset(t *testing.T) {
	var gotBearer, gotExpiresAt string
	var gotScopes []any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/system/api-tokens/delegate" {
			t.Errorf("unexpected path %s", r.URL.Path)
			return
		}
		if o := r.Header.Get("Origin"); o != "http://"+r.Host {
			t.Errorf("Origin = %q, want http://%s", o, r.Host)
		}
		gotBearer = r.Header.Get("Authorization")
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if s, ok := body["scopes"].([]any); ok {
			gotScopes = s
		}
		if e, ok := body["expiresAt"].(string); ok {
			gotExpiresAt = e
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"secret": "sb_child_xyz"})
	}))
	defer srv.Close()

	host, port := hostPort(t, srv)
	secret, err := Delegate(context.Background(), host, port, "sb_parent_123",
		"sb-delegate", []string{"read", "lifecycle"}, "2026-06-22T12:00:00Z")
	if err != nil {
		t.Fatalf("Delegate: %v", err)
	}
	if secret != "sb_child_xyz" {
		t.Errorf("secret = %q, want sb_child_xyz", secret)
	}
	if gotBearer != "Bearer sb_parent_123" {
		t.Errorf("Authorization = %q, want Bearer sb_parent_123", gotBearer)
	}
	if len(gotScopes) != 2 || gotScopes[0] != "read" || gotScopes[1] != "lifecycle" {
		t.Errorf("scopes = %v, want [read lifecycle]", gotScopes)
	}
	if gotExpiresAt != "2026-06-22T12:00:00Z" {
		t.Errorf("expiresAt = %q, want it forwarded verbatim", gotExpiresAt)
	}
}

// TestDelegateRejected covers the box rejecting a request that exceeds the
// parent's grant — a super-scope or longer-TTL ask comes back 403 with the
// box's explanation, which Delegate must surface as a typed *APIError (not a
// silent success).
func TestDelegateRejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error": "requested scopes exceed parent grant",
		})
	}))
	defer srv.Close()

	host, port := hostPort(t, srv)
	_, err := Delegate(context.Background(), host, port, "sb_parent_123",
		"sb-delegate", []string{"read", "exec", "destroy"}, "2027-01-01T00:00:00Z")
	if err == nil {
		t.Fatal("Delegate with super-scope request should error")
	}
	ae, ok := err.(*APIError)
	if !ok {
		t.Fatalf("error type = %T, want *APIError", err)
	}
	if ae.Status != http.StatusForbidden {
		t.Errorf("status = %d, want 403", ae.Status)
	}
	if !strings.Contains(ae.Message, "exceed parent grant") {
		t.Errorf("message = %q, want the box's explanation", ae.Message)
	}
}

// TestDelegateRequiresParent: an empty parent token fails fast before any
// network call (no box needed).
func TestDelegateRequiresParent(t *testing.T) {
	_, err := Delegate(context.Background(), "127.0.0.1", "1", "  ",
		"sb-delegate", []string{"read"}, "")
	if err == nil {
		t.Fatal("Delegate with empty parent should error")
	}
}

// hostPort splits an httptest server URL (http://127.0.0.1:PORT) into host+port
// so Login can rebuild it through its own base-URL formatting.
func hostPort(t *testing.T, srv *httptest.Server) (string, string) {
	t.Helper()
	hp := strings.TrimPrefix(srv.URL, "http://")
	i := strings.LastIndex(hp, ":")
	if i < 0 {
		t.Fatalf("bad test url %q", srv.URL)
	}
	return hp[:i], hp[i+1:]
}
