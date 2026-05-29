package rest

import (
	"context"
	"encoding/json"
)

// EditableField is one allow-listed config key the edit-config panel exposes.
// The set is deliberately narrow (#1275): non-sensitive top-level scalars that
// are safe to read+write through a scoped token. Secrets (password/secret/
// token/key) are redacted by the box on GET and intentionally not editable
// here — they round-trip through the web UI, not the TUI.
type EditableField struct {
	Key   string // config.json key sent in the POST patch
	Label string // human label shown in the panel
	// Allowed, when non-empty, constrains the value to a fixed set (an enum
	// like logLevel); an empty slice means free-text.
	Allowed []string
}

// EditableFields is the curated allow-list, in display order.
var EditableFields = []EditableField{
	{Key: "serverName", Label: "Server name"},
	{Key: "domain", Label: "Domain"},
	{Key: "logLevel", Label: "Log level", Allowed: []string{"debug", "info", "warn", "error"}},
}

// Config holds the current values of the allow-listed fields, read from the
// box. Values are plain strings (the allow-listed keys are all scalar and
// non-sensitive, so they're never redacted).
type Config struct {
	Values map[string]string
}

// GetConfig fetches the box config and projects out the allow-listed fields.
// A field absent from the box config reads as the empty string.
func (c *Client) GetConfig(ctx context.Context) (*Config, error) {
	raw, err := c.do(ctx, "GET", "/api/settings", nil)
	if err != nil {
		return nil, err
	}
	// The settings GET returns the config object directly (plus a
	// templateSettingsSchema sibling we ignore), not the {ok,data} envelope.
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, &APIError{Message: "malformed config response: " + err.Error()}
	}
	values := make(map[string]string, len(EditableFields))
	for _, f := range EditableFields {
		var s string
		if v, ok := doc[f.Key]; ok {
			_ = json.Unmarshal(v, &s) // non-string/absent → "" via zero value
		}
		values[f.Key] = s
	}
	return &Config{Values: values}, nil
}

// UpdateConfig writes a single allow-listed field. It POSTs a minimal partial
// ({key: value}) so the box's merge touches only that field and never
// round-trips redacted secrets back into the store (#1275).
func (c *Client) UpdateConfig(ctx context.Context, key, value string) error {
	_, err := c.do(ctx, "POST", "/api/settings", map[string]string{key: value})
	return err
}
