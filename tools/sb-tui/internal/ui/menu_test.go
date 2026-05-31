package ui

import (
	"context"
	"strings"
	"testing"
	"time"

	"servicebay-tui/internal/phase"
	"servicebay-tui/internal/watch"
)

func readyDetect(context.Context) (bool, phase.BoxStatus) {
	return true, phase.BoxStatus{Reachable: true, WizardDone: true}
}

func installingDetect(context.Context) (bool, phase.BoxStatus) {
	return true, phase.BoxStatus{Reachable: true}
}

// feed delivers a fresh phase probe to the menu (as the detect cmd would).
func feed(m Model) Model {
	built, status := m.detect(context.Background())
	mi, _ := m.Update(phaseMsg{state: phase.Detect(built, status)})
	return mi.(Model)
}

// TestMenuAutoRefreshPreservesCursor: a silent re-probe with an unchanged action
// set must not yank the cursor back to the top.
func TestMenuAutoRefreshPreservesCursor(t *testing.T) {
	m := feed(New(readyDetect, "box", "5888", ""))
	m.cursor = 1 // a selectable row (step 2 / reinstall)
	m = feed(m)  // simulate an auto-refresh tick with identical rows
	if m.cursor != 1 {
		t.Fatalf("cursor reset to %d on unchanged refresh, want 1", m.cursor)
	}
}

// TestMenuShowsURLWhenReachable: the dashboard URL is rendered persistently
// once the box is reachable, replacing the old Open-in-browser action.
func TestMenuShowsURLWhenReachable(t *testing.T) {
	m := feed(New(readyDetect, "192.168.1.5", "5888", ""))
	v := m.View()
	if !strings.Contains(v, "http://192.168.1.5:5888/") {
		t.Error("reachable menu should show the dashboard URL")
	}
	for _, r := range m.rows {
		if r.Action.Label == "Refresh status" || strings.Contains(r.Action.Label, "Open ServiceBay") {
			t.Errorf("stale action still present: %q", r.Action.Label)
		}
	}
}

// TestMenuFooterShowsVersion: the launcher footer self-reports the build version.
func TestMenuFooterShowsVersion(t *testing.T) {
	old := Version
	Version = "9.9.9"
	defer func() { Version = old }()
	m := feed(New(readyDetect, "box", "5888", ""))
	if v := m.View(); !strings.Contains(v, "sb-tui 9.9.9") {
		t.Errorf("footer should show the version, got:\n%s", v)
	}
}

// TestMenuInstallStatusLine: while installing, a compact live line shows the
// stage + connectivity dots so the operator sees progress without opening the
// full monitor.
func TestMenuInstallStatusLine(t *testing.T) {
	m := feed(New(installingDetect, "192.168.178.100", "5888", ""))
	// Before any probe answers, no stale line; after one, it renders the stage.
	if strings.Contains(m.View(), "Installing ·") {
		t.Error("status line should be absent until a probe answers")
	}
	mi, _ := m.Update(installStatusMsg{probe: watch.Probe{
		ICMP: true, TCP: true,
		Status: &watch.Status{Stage: "pulling images", TimestampISO: time.Now().UTC().Format(time.RFC3339)},
	}})
	m = mi.(Model)
	v := m.View()
	if !strings.Contains(v, "Installing ·") || !strings.Contains(v, "pulling images") || !strings.Contains(v, "ping") {
		t.Errorf("install status line missing stage/ping:\n%s", v)
	}
}
