// Package probes is the concrete IO behind phase detection (#1273, porting
// packages/tui/src/probes.ts): a filesystem check for a built ISO and an HTTP
// check of the box's install status. Kept separate from the phase package so
// the decision logic stays pure.
package probes

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"servicebay-tui/internal/build"
	"servicebay-tui/internal/phase"
)

const statusTimeout = 3 * time.Second

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

// BoxStatus probes /api/install/status (unauthed). Unreachable host or any
// transport error reads as not-reachable; a non-2xx reads as reachable but
// not-done. WizardDone means "the box is up and manageable" — the app is
// serving and no install job is ACTIVELY running. A box that booted fine but
// hasn't had its stacks set up yet (stackSetupPending) is still up/manageable:
// installing stacks is a management action (the in-TUI Install panel), not a
// reason to push the operator at the watch dashboard. Only an active install
// job keeps the launcher in the "watch" phase.
func BoxStatus(ctx context.Context) phase.BoxStatus {
	t := ResolveTarget()
	if t.Host == "" {
		return phase.BoxStatus{}
	}
	ctx, cancel := context.WithTimeout(ctx, statusTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+t.Host+":"+t.Port+"/api/install/status", nil)
	if err != nil {
		return phase.BoxStatus{}
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return phase.BoxStatus{}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return phase.BoxStatus{Reachable: true}
	}
	var body struct {
		JobIsActive *bool `json:"jobIsActive"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return phase.BoxStatus{Reachable: true}
	}
	// Up/manageable unless an install job is actively running. Absent field
	// (app serving, nothing installing) counts as up.
	done := body.JobIsActive == nil || !*body.JobIsActive
	return phase.BoxStatus{Reachable: true, WizardDone: done}
}
