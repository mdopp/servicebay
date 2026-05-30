package ui

import (
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"servicebay-tui/internal/watch"
)

// TestWatchReinstallWaitsForReboot: a reinstall watch ignores takeover until the
// box has rebooted (so the still-running old install isn't mistaken for done).
func TestWatchReinstallWaitsForReboot(t *testing.T) {
	m := NewWatchReinstall("h", "5888", "")
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
	m := NewWatch("h", "5888", "")
	mi, _ := m.Update(watchTickMsg{probe: watch.Probe{ICMP: true, TCP: true}, takeover: true, at: time.Now()})
	m = mi.(WatchModel)
	if !m.Takeover {
		t.Fatal("fresh watch should take over immediately on takeover")
	}
}

// TestWatchUSBStatusUpdatesGlyph: a usbStatusMsg updates both the stored state
// and the last probe (so the next render shows the new glyph).
func TestWatchUSBStatusUpdatesGlyph(t *testing.T) {
	m := NewWatch("h", "5888", "sb_token")
	mi, _ := m.Update(usbStatusMsg{state: watch.USBReady})
	m = mi.(WatchModel)
	if m.usb != watch.USBReady {
		t.Fatalf("usb = %v, want USBReady", m.usb)
	}
	if m.last.USB != watch.USBReady {
		t.Error("last probe USB should reflect the new state for rendering")
	}
}

// TestWatchUEnableGated: pressing u enables USB boot only with a token + an open
// port; otherwise it's a no-op (no command fired).
func TestWatchUEnableGated(t *testing.T) {
	withTok := NewWatch("h", "5888", "sb_token")
	withTok.last = watch.Probe{TCP: true}
	if _, cmd := withTok.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("u")}); cmd == nil {
		t.Error("u with token + open port should fire the enable cmd")
	}
	noTok := NewWatch("h", "5888", "")
	noTok.last = watch.Probe{TCP: true}
	if _, cmd := noTok.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("u")}); cmd != nil {
		t.Error("u without a token should be a no-op")
	}
}
