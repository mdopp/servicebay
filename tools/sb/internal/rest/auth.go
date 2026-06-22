package rest

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"time"
)

// tuiTokenName is the name the self-minted token is created under, so it's
// recognizable in the box's Settings → API tokens list.
const tuiTokenName = "sb"

// tuiScopes is the scope set the TUI mints for itself — everything its panels
// need: read (config/catalog/backups), lifecycle (install), mutate (config
// write), destroy (backup restore). Not exec.
var tuiScopes = []string{"read", "lifecycle", "mutate", "destroy"}

// ErrLoginRejected is returned when the box rejects the username/password.
var ErrLoginRejected = fmt.Errorf("login rejected: wrong username or password")

// Login authenticates against the box with an operator username/password and
// mints a scoped `sb_…` API token for the TUI, returning the token secret. It
// is the in-TUI replacement for "go to the web UI and paste a token": log in
// once, the TUI mints + persists its own credential. The session cookie is held
// only for the mint call and never stored.
func Login(ctx context.Context, host, port, username, password string) (string, error) {
	jar, _ := cookiejar.New(nil)
	httpc := &http.Client{Timeout: defaultTimeout, Jar: jar}
	base := fmt.Sprintf("http://%s:%s", host, port)

	// 1) Log in — the Set-Cookie session lands in the jar.
	if err := postJSON(ctx, httpc, base+"/api/auth/login",
		map[string]string{"username": username, "password": password}, nil); err != nil {
		if ae, ok := err.(*APIError); ok && ae.Status == http.StatusUnauthorized {
			return "", ErrLoginRejected
		}
		return "", err
	}

	// 2) Mint a scoped token using the session cookie the jar now carries.
	var minted struct {
		Secret string `json:"secret"`
	}
	body := map[string]any{
		"name":   tuiTokenName,
		"scopes": tuiScopes,
		// Long-lived: the TUI is a trusted local operator tool. A year out.
		"expiresAt": time.Now().AddDate(1, 0, 0).UTC().Format(time.RFC3339),
	}
	if err := postJSON(ctx, httpc, base+"/api/system/api-tokens", body, &minted); err != nil {
		return "", err
	}
	if !strings.HasPrefix(minted.Secret, "sb_") {
		return "", &APIError{Message: "login succeeded but the box returned no usable token"}
	}
	return minted.Secret, nil
}

// Delegate mints a delegated CHILD token from an existing parent token (#2051).
// The parent `sb_…` token is the credential, presented as `Authorization:
// Bearer …` against POST /api/system/api-tokens/delegate (#2048). The box mints
// a child whose scopes ⊆ parent and whose TTL ≤ parent, deriving the parent
// lineage server-side from the verified token. The minted child secret is
// returned; the caller owns revoking it when the work is done.
//
// scopes is the requested subset; expiresAt is an RFC3339 timestamp (caller
// converts a --ttl duration). A super-scope or longer-TTL request is rejected
// by the box (403/400) and surfaced as a typed *APIError.
func Delegate(ctx context.Context, host, port, parentToken, name string, scopes []string, expiresAt string) (string, error) {
	if strings.TrimSpace(parentToken) == "" {
		return "", &APIError{Message: "delegate: a parent token is required (--parent or SB_TOKEN)"}
	}
	httpc := &http.Client{Timeout: defaultTimeout}
	base := fmt.Sprintf("http://%s:%s", host, port)

	body := map[string]any{
		"name":   name,
		"scopes": scopes,
	}
	if expiresAt != "" {
		body["expiresAt"] = expiresAt
	}

	var minted struct {
		Secret string `json:"secret"`
	}
	if err := postBearerJSON(ctx, httpc, base+"/api/system/api-tokens/delegate", parentToken, body, &minted); err != nil {
		return "", err
	}
	if !strings.HasPrefix(minted.Secret, "sb_") {
		return "", &APIError{Message: "delegate succeeded but the box returned no usable token"}
	}
	return minted.Secret, nil
}

// EnsureUSBBoot logs in with the box admin credentials and sets a one-shot UEFI
// BootNext to the USB stick (then reboots the box), so the next boot installs
// from the USB instead of the existing disk. It uses cookie auth — so it works
// against the CURRENT (possibly old) ServiceBay, which doesn't speak scoped REST
// tokens. The USB must already be plugged into the server (the box's efibootmgr
// must see a USB boot entry). Returns the box's confirmation message.
func EnsureUSBBoot(ctx context.Context, host, port, username, password string) (string, error) {
	jar, _ := cookiejar.New(nil)
	httpc := &http.Client{Timeout: defaultTimeout, Jar: jar}
	base := fmt.Sprintf("http://%s:%s", host, port)

	if err := postJSON(ctx, httpc, base+"/api/auth/login",
		map[string]string{"username": username, "password": password}, nil); err != nil {
		if ae, ok := err.(*APIError); ok && ae.Status == http.StatusUnauthorized {
			return "", ErrLoginRejected
		}
		return "", err
	}

	// reboot:true → set BootNext (auto-detecting the USB entry) and reboot now.
	var resp struct {
		Message string `json:"message"`
	}
	if err := postJSON(ctx, httpc, base+"/api/system/boot/usb-next",
		map[string]any{"reboot": true}, &resp); err != nil {
		return "", err
	}
	if resp.Message == "" {
		resp.Message = "One-shot USB boot set; the box is rebooting."
	}
	return resp.Message, nil
}

// postBearerJSON POSTs body as JSON authenticated with `Authorization: Bearer
// <token>` (the delegate flow's parent credential) and decodes a 2xx response
// into out (when non-nil), or returns a typed error. A 401/403 surfaces as an
// *APIError carrying the box's explanation (bad/expired/super-scope parent).
func postBearerJSON(ctx context.Context, httpc *http.Client, url, token string, body, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return &APIError{Message: err.Error()}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(raw)))
	if err != nil {
		return &APIError{Message: err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	// Same-origin header for the proxy CSRF gate (see postJSON); the Bearer
	// alone also satisfies it, but matching keeps the two mint paths uniform.
	req.Header.Set("Origin", req.URL.Scheme+"://"+req.URL.Host)
	resp, err := httpc.Do(req)
	if err != nil {
		return &APIError{Message: fmt.Sprintf("cannot reach box: %v", err)}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		buf := make([]byte, 4096)
		n, _ := resp.Body.Read(buf)
		return &APIError{Status: resp.StatusCode, Message: serverError(buf[:n], resp.StatusCode)}
	}
	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			return &APIError{Message: "malformed response: " + err.Error()}
		}
	}
	return nil
}

// postJSON POSTs body as JSON on httpc (carrying its cookie jar) and decodes a
// 2xx response into out (when non-nil), or returns a typed error.
func postJSON(ctx context.Context, httpc *http.Client, url string, body, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return &APIError{Message: err.Error()}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(raw)))
	if err != nil {
		return &APIError{Message: err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	// The box's proxy CSRF-gates mutating POSTs: it 403s ("cross-site request")
	// unless the Origin host matches the Host header, OR a valid Bearer is
	// present. Login + token-mint happen BEFORE we have a token, so set a
	// same-origin header. Go sets Host from the URL, so scheme://URL.Host
	// matches by construction.
	req.Header.Set("Origin", req.URL.Scheme+"://"+req.URL.Host)
	resp, err := httpc.Do(req)
	if err != nil {
		return &APIError{Message: fmt.Sprintf("cannot reach box: %v", err)}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		buf := make([]byte, 4096)
		n, _ := resp.Body.Read(buf)
		return &APIError{Status: resp.StatusCode, Message: serverError(buf[:n], resp.StatusCode)}
	}
	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			return &APIError{Message: "malformed response: " + err.Error()}
		}
	}
	return nil
}
