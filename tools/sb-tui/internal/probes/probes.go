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
// authenticate with (#1275), read from SB_TOKEN. Empty when unset — the panel
// then shows mint instructions rather than making a doomed 401 call. Mint one
// in ServiceBay → Settings → API tokens with the `mutate` scope.
func ResolveToken() string {
	return strings.TrimSpace(os.Getenv("SB_TOKEN"))
}

// BoxStatus probes /api/install/status (unauthed). Unreachable host or any
// transport error reads as not-reachable; a non-2xx reads as reachable but
// not-done. wizardDone mirrors the Ink probe: no active job and no pending
// stack setup.
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
		JobIsActive       *bool `json:"jobIsActive"`
		StackSetupPending *bool `json:"stackSetupPending"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return phase.BoxStatus{Reachable: true}
	}
	done := body.JobIsActive != nil && !*body.JobIsActive &&
		body.StackSetupPending != nil && !*body.StackSetupPending
	return phase.BoxStatus{Reachable: true, WizardDone: done}
}
