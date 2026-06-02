package rest

import (
	"context"
	"encoding/json"
	"strings"
)

// Backup is one system backup archive on the box.
type Backup struct {
	FileName  string `json:"fileName"`
	CreatedAt string `json:"createdAt"`
	Size      int64  `json:"size"`
}

// ListBackups returns the box's system backups, newest-first as the box
// reports them.
func (c *Client) ListBackups(ctx context.Context) ([]Backup, error) {
	raw, err := c.do(ctx, "GET", "/api/settings/backups", nil)
	if err != nil {
		return nil, err
	}
	var out []Backup
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, &APIError{Message: "malformed backups response: " + err.Error()}
	}
	return out, nil
}

// CreateBackup triggers a new system backup. The endpoint streams NDJSON
// progress and closes when done; we read the whole stream and return the
// terminal `done` backup entry (or the `error` event as an *APIError).
func (c *Client) CreateBackup(ctx context.Context) (*Backup, error) {
	raw, err := c.do(ctx, "POST", "/api/settings/backups", nil)
	if err != nil {
		return nil, err
	}
	var created *Backup
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var ev struct {
			Type    string  `json:"type"`
			Message string  `json:"message"`
			Backup  *Backup `json:"backup"`
		}
		if json.Unmarshal([]byte(line), &ev) != nil {
			continue
		}
		switch ev.Type {
		case "error":
			return nil, &APIError{Message: ev.Message}
		case "done":
			created = ev.Backup
		}
	}
	if created == nil {
		return nil, &APIError{Message: "backup stream ended without a result"}
	}
	return created, nil
}

// RestoreBackup restores a named system backup. This is destructive — it
// overwrites the box's config/state — so callers must confirm first. The token
// needs the `destroy` scope.
func (c *Client) RestoreBackup(ctx context.Context, fileName string) error {
	_, err := c.do(ctx, "POST", "/api/settings/backups/restore", map[string]string{"fileName": fileName})
	return err
}
