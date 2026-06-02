package rest

import (
	"context"
	"encoding/json"
)

// Channels is the set of release channels the running box can be flipped to.
// latest = last release · dev = latest non-release main commit · test = test branch.
var Channels = []string{"latest", "dev", "test"}

// GetChannel reports the release channel the running ServiceBay container is
// pinned to (GET /api/system/channel).
func (c *Client) GetChannel(ctx context.Context) (string, error) {
	raw, err := c.do(ctx, "GET", "/api/system/channel", nil)
	if err != nil {
		return "", err
	}
	var doc struct {
		Channel string `json:"channel"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", &APIError{Message: "malformed channel response: " + err.Error()}
	}
	return doc.Channel, nil
}

// SetChannel re-points the running ServiceBay container at `:<channel>` and
// restarts it (POST /api/system/channel). The box pulls + restarts in the
// background, so this returns before it actually flips — poll GetChannel to
// confirm.
func (c *Client) SetChannel(ctx context.Context, channel string) error {
	_, err := c.do(ctx, "POST", "/api/system/channel", map[string]string{"channel": channel})
	return err
}
