package ui

import (
	"testing"
	"time"

	"servicebay-tui/internal/watch"
)

// TestWatchReinstallWaitsForReboot: a reinstall watch ignores takeover until the
// box has rebooted (so the still-running old install isn't mistaken for done).
func TestWatchReinstallWaitsForReboot(t *testing.T) {
	m := NewWatchReinstall("h", "5888")
	now := time.Now()

	// Box currently up + "takeover" — must be ignored (no reboot yet).
	mi, _ := m.Update(watchTickMsg{probe: watch.Probe{ICMP: true, TCP: true}, takeover: true, at: now})
	m = mi.(WatchModel)
	if m.Takeover {
		t.Fatal("reinstall watch must not take over before a reboot")
	}
	// Box goes offline (reboot into installer) → one reboot observed.
	mi, _ = m.Update(watchTickMsg{probe: watch.Probe{ICMP: false}, at: now})
	m = mi.(WatchModel)
	// New box up + takeover → now it counts.
	mi, _ = m.Update(watchTickMsg{probe: watch.Probe{ICMP: true, TCP: true}, takeover: true, at: now})
	m = mi.(WatchModel)
	if !m.Takeover {
		t.Fatal("reinstall watch should take over after a reboot")
	}
}

// TestWatchFreshTakesOverImmediately: a normal (non-reinstall) watch takes over
// as soon as the app serves.
func TestWatchFreshTakesOverImmediately(t *testing.T) {
	m := NewWatch("h", "5888")
	mi, _ := m.Update(watchTickMsg{probe: watch.Probe{ICMP: true, TCP: true}, takeover: true, at: time.Now()})
	m = mi.(WatchModel)
	if !m.Takeover {
		t.Fatal("fresh watch should take over immediately on takeover")
	}
}
