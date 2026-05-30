package fritz

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Creds are the FritzBox FTP login the operator enters once in the TUI. Stored
// locally (0600) so backup uploads don't re-prompt — the operator's own machine,
// per the "enter creds in the TUI" decision (#1367).
type Creds struct {
	Host     string `json:"host"`
	User     string `json:"user"`
	Password string `json:"password"`
}

// credsPath is ~/.config/servicebay/fritzbox-ftp.json (honours XDG_CONFIG_HOME).
func credsPath() string {
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".config")
	}
	return filepath.Join(dir, "servicebay", "fritzbox-ftp.json")
}

// LoadCreds returns the saved FritzBox FTP creds, or a zero Creds if none.
func LoadCreds() Creds {
	var c Creds
	if b, err := os.ReadFile(credsPath()); err == nil {
		_ = json.Unmarshal(b, &c)
	}
	return c
}

// SaveCreds persists the FritzBox FTP creds 0600 so the next upload pre-fills.
func SaveCreds(c Creds) error {
	p := credsPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, b, 0o600)
}
