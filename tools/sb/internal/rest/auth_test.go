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
