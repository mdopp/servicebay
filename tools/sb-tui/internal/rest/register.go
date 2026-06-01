package rest

import "context"

// RegisterNasSource tells the box that the FritzBox NAS is its external-backup
// source (#1440), by POSTing the FritzBox host + credentials to
// `/api/system/external-backup/register`. The box records them in
// `config.gateway`, so an upload staged straight on the NAS over FTP (the
// NasUpload panel, #1367) becomes discoverable by install/restore instead of
// being invisible.
//
// Best-effort by design: the upload itself goes FTP-direct and may happen
// before any box exists, so callers ignore an error here (no box / no token)
// and fall back to registering from Settings. Idempotent on the box side.
func (c *Client) RegisterNasSource(ctx context.Context, host, username, password string) error {
	_, err := c.do(ctx, "POST", "/api/system/external-backup/register", map[string]string{
		"host":     host,
		"username": username,
		"password": password,
	})
	return err
}
