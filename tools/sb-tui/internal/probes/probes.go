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
	"regexp"
	"strings"
	"time"

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

var (
	reStaticIP = regexp.MustCompile(`(?m)^STATIC_IP=(.*)$`)
	rePort     = regexp.MustCompile(`(?m)^SERVICEBAY_PORT=(.*)$`)
)

// Target is the resolved box address.
type Target struct {
	Host string
	Port string
}

// ResolveTarget picks the box address: explicit SB_HOST/SB_PORT env wins, else
// the values parsed from install-settings.env, else the default port. Host is
// "" when unknown.
func ResolveTarget() Target {
	host, port := os.Getenv("SB_HOST"), os.Getenv("SB_PORT")
	if host == "" || port == "" {
		if raw, err := os.ReadFile(settingsFile()); err == nil {
			if host == "" {
				if m := reStaticIP.FindSubmatch(raw); m != nil {
					host = strings.TrimSpace(string(m[1]))
				}
			}
			if port == "" {
				if m := rePort.FindSubmatch(raw); m != nil {
					port = strings.TrimSpace(string(m[1]))
				}
			}
		}
	}
	if port == "" {
		port = "5888"
	}
	return Target{Host: host, Port: port}
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
