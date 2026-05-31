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
	Key   string // stable identifier: values-map key + status label
	Label string // human label shown in the panel
	// Path is the field's location in the config object, for both the GET
	// projection and the POST patch. Empty means top-level []string{Key}.
	// The domain lives nested at reverseProxy.publicDomain (what the web UI
	// and /api/system/mode use), NOT at the dead top-level `domain` display
	// field — reading the latter showed "(unset)" on a box that had a
	// domain set.
	Path []string
	// Allowed, when non-empty, constrains the value to a fixed set (an enum
	// like logLevel); an empty slice means free-text.
	Allowed []string
}

// path is the field's config location, defaulting to a top-level key.
func (f EditableField) path() []string {
	if len(f.Path) > 0 {
		return f.Path
	}
	return []string{f.Key}
}

// EditableFields is the curated allow-list, in display order.
var EditableFields = []EditableField{
	{Key: "serverName", Label: "Server name"},
	{Key: "domain", Label: "Domain", Path: []string{"reverseProxy", "publicDomain"}},
	{Key: "logLevel", Label: "Log level", Allowed: []string{"debug", "info", "warn", "error"}},
}

// Config holds the current values of the allow-listed fields, read from the
// box. Values are plain strings (the allow-listed keys are all scalar and
// non-sensitive, so they're never redacted).
type Config struct {
	Values map[string]string
}

// GetConfig fetches the box config and projects out the allow-listed fields.
// A field absent from the box config (or at a non-string leaf) reads as the
// empty string. Nested fields (e.g. domain → reverseProxy.publicDomain) are
// resolved by walking their Path.
func (c *Client) GetConfig(ctx context.Context) (*Config, error) {
	raw, err := c.do(ctx, "GET", "/api/settings", nil)
	if err != nil {
		return nil, err
	}
	// The settings GET returns the config object directly (plus a
	// templateSettingsSchema sibling we ignore), not the {ok,data} envelope.
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, &APIError{Message: "malformed config response: " + err.Error()}
	}
	values := make(map[string]string, len(EditableFields))
	for _, f := range EditableFields {
		values[f.Key] = stringAtPath(obj, f.path())
	}
	return &Config{Values: values}, nil
}

// stringAtPath walks a nested map by key, returning the string leaf or "" if
// any segment is missing or the leaf isn't a string.
func stringAtPath(obj map[string]any, path []string) string {
	var cur any = obj
	for _, key := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return ""
		}
		cur = m[key]
	}
	if s, ok := cur.(string); ok {
		return s
	}
	return ""
}

// UpdateConfig writes a single allow-listed field. It POSTs a minimal partial
// nested at the field's Path (e.g. {reverseProxy:{publicDomain:value}}) so the
// box's one-level merge touches only that field and never round-trips redacted
// secrets back into the store (#1275). The backend deep-merges `reverseProxy`
// (like `notifications`), so a nested write preserves the rest of the block.
func (c *Client) UpdateConfig(ctx context.Context, key, value string) error {
	path := []string{key}
	for _, f := range EditableFields {
		if f.Key == key {
			path = f.path()
			break
		}
	}
	_, err := c.do(ctx, "POST", "/api/settings", nestPartial(path, value))
	return err
}

// nestPartial builds a nested object placing value at path
// (["reverseProxy","publicDomain"], "x" → {"reverseProxy":{"publicDomain":"x"}}).
func nestPartial(path []string, value string) map[string]any {
	root := map[string]any{}
	cur := root
	for i, key := range path {
		if i == len(path)-1 {
			cur[key] = value
			break
		}
		next := map[string]any{}
		cur[key] = next
		cur = next
	}
	return root
}
