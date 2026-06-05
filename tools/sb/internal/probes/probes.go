// Package probes is the concrete IO behind phase detection (#1273, porting
// packages/tui/src/probes.ts): a filesystem check for a built ISO and an HTTP
// check of the box's install status. Kept separate from the phase package so
// the decision logic stays pure.
package probes

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"sb/internal/build"
	"sb/internal/phase"
	"sb/internal/watch"
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

// DeleteToken removes the persisted per-host token. Called when the box rejects
// the saved token (401) — after a reinstall the file holds a stale credential,
// so dropping it lets the next launch fall through to the in-TUI sign-in instead
// of dead-ending. A missing file is not an error (already clear).
func DeleteToken(host string) error {
	if err := os.Remove(tokenPath(host)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
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

// authStatus is the outcome of an authenticated probe with the saved token.
type authStatus int

const (
	authUnknown      authStatus = iota // couldn't tell (no token, transport error)
	authOK                             // the box accepted our token (2xx)
	authUnauthorized                   // the box answered 401 — token stale/expired (#1669)
)

// classifyBoxStatus folds the raw probe facts into a phase.BoxStatus. Pure, so
// the reachable-but-unauthorized distinction (#1669) is unit-testable without a
// live box: tcpOpen + appServing come from the unauthenticated probes, auth from
// the token probe. A 401 from the box means it IS up (serving the real app
// behind auth) — surfaced as Unauthorized, NOT as "not set up".
func classifyBoxStatus(tcpOpen, appServing bool, auth authStatus) phase.BoxStatus {
	if !tcpOpen {
		return phase.BoxStatus{}
	}
	// The box answered 401 to an authenticated request: it's reachable and the
	// real app is up, just rejecting our (stale) credential. Even if the
	// unauthenticated title sniff didn't recognise takeover, a 401 is proof the
	// app is serving — so the box is manageable, pending sign-in.
	if auth == authUnauthorized {
		return phase.BoxStatus{Reachable: true, WizardDone: appServing, Unauthorized: true}
	}
	return phase.BoxStatus{Reachable: true, WizardDone: appServing}
}

// probeAuth issues a lightweight authenticated GET with the saved token and
// classifies the result. /api/settings is read-scoped and cheap. A 401 → stale
// token (authUnauthorized); a 2xx → authOK; anything else (no token, transport
// error, 5xx) → authUnknown, so a flaky box never spuriously flips the phase.
func probeAuth(host, port string) authStatus {
	token := ResolveToken(host)
	if token == "" {
		return authUnknown
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+host+":"+port+"/api/settings", nil)
	if err != nil {
		return authUnknown
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return authUnknown
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return authUnauthorized
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return authOK
	default:
		return authUnknown
	}
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
//   - box answers 401        → reachable + Unauthorized → Ready, prompt sign-in (#1669)
//
// A stale saved token after a reinstall used to read as "box not set up"
// (every authed call 401s → the launcher fell to fresh-setup and greyed out
// Manage/stack-install, forcing a needless USB rebuild). The auth probe now
// catches the 401 and keeps the box manageable, pending sign-in.
func BoxStatus(_ context.Context) phase.BoxStatus {
	t := ResolveTarget()
	if t.Host == "" {
		return phase.BoxStatus{}
	}
	if !watch.TCPOpen(t.Host, t.Port) {
		return phase.BoxStatus{}
	}
	return classifyBoxStatus(true, watch.AppServing(t.Host, t.Port), probeAuth(t.Host, t.Port))
}
