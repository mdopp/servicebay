package ui

import (
	"context"
	"strings"
	"testing"

	"servicebay-tui/internal/phase"
)

func readyDetect(context.Context) (bool, phase.BoxStatus) {
	return true, phase.BoxStatus{Reachable: true, WizardDone: true}
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
	m := feed(New(readyDetect, "box", "5888"))
	m.cursor = 2
	m = feed(m) // simulate an auto-refresh tick with identical actions
	if m.cursor != 2 {
		t.Fatalf("cursor reset to %d on unchanged refresh, want 2", m.cursor)
	}
}

// TestMenuShowsURLWhenReachable: the dashboard URL is rendered persistently
// once the box is reachable, replacing the old Open-in-browser action.
func TestMenuShowsURLWhenReachable(t *testing.T) {
	m := feed(New(readyDetect, "192.168.1.5", "5888"))
	v := m.View()
	if !strings.Contains(v, "http://192.168.1.5:5888/") {
		t.Error("reachable menu should show the dashboard URL")
	}
	for _, a := range m.actions {
		if a.Label == "Refresh status" || strings.Contains(a.Label, "Open ServiceBay") {
			t.Errorf("stale action still present: %q", a.Label)
		}
	}
}
