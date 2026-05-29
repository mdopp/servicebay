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
const tuiTokenName = "sb-tui"

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
