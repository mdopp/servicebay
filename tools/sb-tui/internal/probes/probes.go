// Package probes is the concrete IO behind phase detection (#1273, porting
// packages/tui/src/probes.ts): a filesystem check for a built ISO and an HTTP
// check of the box's install status. Kept separate from the phase package so
// the decision logic stays pure.
package probes

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"servicebay-tui/internal/build"
	"servicebay-tui/internal/phase"
	"servicebay-tui/internal/watch"
)

// BuildDir is where an ISO build leaves its artifacts. Defaults to
// ./build/fcos (repo-relative, matching the current dev workflow); override
// with SB_BUILD_DIR. Distribution-time path resolution is refined in #1279.
func BuildDir() string {
	if d := os.Getenv("SB_BUILD_DIR"); d != "" {
		return d
	}
	return filepath.Join("build", "fcos")
}

func settingsFile() string { return filepath.Join(BuildDir(), "install-settings.env") }

// ISOBuilt reports whether an install ISO has been baked: an
// install-settings.env or any *.iso under the build dir counts.
func ISOBuilt() bool {
	if _, err := os.Stat(settingsFile()); err == nil {
		return true
	}
	entries, err := os.ReadDir(BuildDir())
	if err != nil {
		return false
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".iso") {
			return true
		}
	}
	return false
}

// Target is the resolved box address.
type Target struct {
	Host string
	Port string
}

// ResolveTarget picks the box address: explicit SB_HOST/SB_PORT env wins, else
// the values from install-settings.env (parsed via the build-leg settings
// model, #1289), else the default port. Host is "" when unknown.
func ResolveTarget() Target {
	host, port := os.Getenv("SB_HOST"), os.Getenv("SB_PORT")
	if host == "" || port == "" {
		if s, err := build.Load(settingsFile()); err == nil {
			fileHost, filePort := s.Target()
			if host == "" {
				host = strings.TrimSpace(fileHost)
			}
			if port == "" {
				port = strings.TrimSpace(filePort)
			}
		}
	}
	if port == "" {
		port = build.DefaultPort
	}
	return Target{Host: host, Port: port}
}

// ResolveToken returns the scoped `sb_…` API token the box-control panels
// authenticate with (#1275): SB_TOKEN env wins (CI / power users), otherwise the
// token the TUI minted for this host on a previous in-TUI login. Empty when
// neither exists — the launcher then runs the login flow rather than dead-ending.
func ResolveToken(host string) string {
	if t := strings.TrimSpace(os.Getenv("SB_TOKEN")); t != "" {
		return t
	}
	if b, err := os.ReadFile(tokenPath(host)); err == nil {
		return strings.TrimSpace(string(b))
	}
	return ""
}

// SaveToken persists a minted token for host so future launches skip the login
// step. Stored 0600 under the user config dir, one file per host.
func SaveToken(host, token string) error {
	p := tokenPath(host)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	return os.WriteFile(p, []byte(strings.TrimSpace(token)+"\n"), 0o600)
}

// tokenPath is ~/.config/servicebay/<host>.token (honoring XDG_CONFIG_HOME).
func tokenPath(host string) string {
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".config")
	}
	safe := strings.NewReplacer("/", "_", ":", "_").Replace(host)
	return filepath.Join(dir, "servicebay", safe+".token")
}

// BoxStatus classifies the box by what it's actually serving, not by a job
// record. WizardDone ("up and manageable") keys off whether the REAL app is
// serving — the same takeover signal the watch dashboard uses — rather than
// /api/install/status's jobIsActive, which stays true on a job left stuck in
// running/needs_credentials from a past install and wrongly pins the launcher
// in the "watch" phase. So:
//   - port closed            → not reachable (pre-boot / rebooting)
//   - install splash serving → reachable, not done → Installing (watch leads)
//   - real app serving       → reachable + done   → Ready (manage)
func BoxStatus(_ context.Context) phase.BoxStatus {
	t := ResolveTarget()
	if t.Host == "" {
		return phase.BoxStatus{}
	}
	if !watch.TCPOpen(t.Host, t.Port) {
		return phase.BoxStatus{}
	}
	return phase.BoxStatus{Reachable: true, WizardDone: watch.AppServing(t.Host, t.Port)}
}
