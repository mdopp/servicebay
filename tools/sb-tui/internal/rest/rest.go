// Package rest is the sb-tui client for the box's authenticated REST API
// (#1275). It authenticates with a scoped named API token
// (`Authorization: Bearer sb_…`, the #1265 foundation) and is the shared HTTP
// + auth + error-surface layer every box-control panel reuses (edit-config
// #1275, stack-install #1276, backup #1277). Kept free of any Bubble Tea types
// so it's unit-testable against an httptest server with no UI.
package rest

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// defaultTimeout bounds a single request. Box calls are LAN-local and cheap;
// a stuck connection should surface as an error rather than hang the panel.
const defaultTimeout = 10 * time.Second

// ErrNoToken is returned by New when no API token was supplied. Panels surface
// it with the mint instructions (Settings → API tokens, scope `mutate`).
var ErrNoToken = errors.New("no API token: set SB_TOKEN to a scoped sb_… token")

// ErrUnauthorized is returned for a 401 — a missing, expired, or
// insufficiently-scoped token. Distinguished from other API errors so panels
// can point the operator at re-minting rather than at a transient failure.
var ErrUnauthorized = errors.New("unauthorized: token missing, expired, or lacks the required scope")

// APIError carries a non-2xx response the server explained in its JSON error
// envelope ({"error": …} or {"ok":false,"error":…}). Status 0 with a wrapped
// transport error means the request never completed.
type APIError struct {
	Status  int
	Message string
	Body    json.RawMessage // the raw error body, for callers that parse extra fields (e.g. a 409's jobId)
}

func (e *APIError) Error() string {
	if e.Status == 0 {
		return e.Message
	}
	return fmt.Sprintf("box returned %d: %s", e.Status, e.Message)
}

// Client talks to one box's REST API with a bearer token.
type Client struct {
	BaseURL string // e.g. http://192.168.178.100:5888
	Token   string // the sb_… named API token
	HTTP    *http.Client
}

// New builds a client for host:port. token is the scoped sb_ token; an empty
// token yields ErrNoToken so callers fail fast with mint instructions instead
// of making a doomed 401 round-trip.
func New(host, port, token string) (*Client, error) {
	if strings.TrimSpace(token) == "" {
		return nil, ErrNoToken
	}
	return &Client{
		BaseURL: fmt.Sprintf("http://%s:%s", host, port),
		Token:   token,
		HTTP:    &http.Client{Timeout: defaultTimeout},
	}, nil
}

// do issues an authenticated request with the bearer token, returning the
// decoded JSON body on 2xx or a typed error (ErrUnauthorized / *APIError).
func (c *Client) do(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
	return c.doRaw(ctx, method, path, body, true)
}

// doPublic issues a request WITHOUT the bearer token, for endpoints that are
// intentionally public + self-gated (the jobId-gated /api/install/progress —
// adding a token scope there would break its AUTH_SECRET-rotation self-heal,
// so the TUI must not present a token). Same error surface as do.
func (c *Client) doPublic(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
	return c.doRaw(ctx, method, path, body, false)
}

func (c *Client) doRaw(ctx context.Context, method, path string, body any, authed bool) (json.RawMessage, error) {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("encode request body: %w", err)
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, reader)
	if err != nil {
		return nil, &APIError{Message: err.Error()}
	}
	if authed {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.HTTP.Do(req)
	if err != nil {
		// Transport failure (box unreachable, timeout) — never reached the app.
		return nil, &APIError{Message: fmt.Sprintf("cannot reach box: %v", err)}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == http.StatusUnauthorized {
		return nil, ErrUnauthorized
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &APIError{Status: resp.StatusCode, Message: serverError(raw, resp.StatusCode), Body: json.RawMessage(raw)}
	}
	return json.RawMessage(raw), nil
}

// serverError extracts the human-readable message from the box's error
// envelope, falling back to the raw body or the bare status text.
func serverError(raw []byte, status int) string {
	var env struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(raw, &env) == nil && env.Error != "" {
		return env.Error
	}
	if s := strings.TrimSpace(string(raw)); s != "" {
		return s
	}
	return http.StatusText(status)
}
