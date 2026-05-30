// Package fritz uploads files to the FritzBox NAS over plain FTP — the same
// transport ServiceBay's server-side nasClient uses (secure:false on the LAN).
// The TUI uploads service-config backups here directly so the box's ~10 MB
// /api request-body cap (the Next middleware) never applies (#1367).
package fritz

import (
	"bytes"
	"fmt"
	"path"
	"strings"
	"time"

	"github.com/jlaffaye/ftp"
)

// Upload writes data to remotePath on the FritzBox NAS, creating the parent dir
// if needed (e.g. "sb-backup/home-assistant.tar"). host may include a port;
// :21 is assumed otherwise.
func Upload(host, user, pass, remotePath string, data []byte) error {
	addr := host
	if !strings.Contains(addr, ":") {
		addr += ":21"
	}
	conn, err := ftp.Dial(addr, ftp.DialWithTimeout(15*time.Second))
	if err != nil {
		return fmt.Errorf("connect %s: %w", addr, err)
	}
	defer func() { _ = conn.Quit() }()

	if err := conn.Login(user, pass); err != nil {
		return fmt.Errorf("login as %q failed (check FritzBox FTP user/password): %w", user, err)
	}

	dir := path.Dir(remotePath)
	if dir != "." && dir != "/" {
		_ = conn.MakeDir(dir) // ignore "already exists"
		if err := conn.ChangeDir(dir); err != nil {
			return fmt.Errorf("cd %q on the NAS: %w", dir, err)
		}
	}
	if err := conn.Stor(path.Base(remotePath), bytes.NewReader(data)); err != nil {
		return fmt.Errorf("upload %q: %w", remotePath, err)
	}
	return nil
}
