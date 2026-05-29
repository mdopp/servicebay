package ui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"servicebay-tui/internal/build"
	"servicebay-tui/internal/iso"
	"servicebay-tui/internal/usb"
)

func noDeps() BuildDeps {
	return BuildDeps{
		Images: func() ([]iso.Choice, int) { return nil, 0 },
		USB:    func() ([]usb.Device, error) { return nil, nil },
	}
}

// TestConditionalFieldsHiddenAndRevealed: GW user + email fields are hidden
// until their gating field is set.
func TestConditionalFieldsHiddenAndRevealed(t *testing.T) {
	m := NewBuildForm(build.Settings{}, noDeps())
	base := len(m.visible)
	for _, f := range m.visible {
		if f.label == "FRITZ!Box username" || f.label == "SMTP host" {
			t.Fatalf("conditional field %q visible with gate off", f.label)
		}
	}
	// Turn email on → SMTP fields appear.
	m.settings.EnableEmail = "Y"
	m.recomputeVisible()
	if len(m.visible) <= base {
		t.Fatal("enabling email should reveal SMTP fields")
	}
	// Set a FRITZ!Box host → username appears.
	m.settings.GWHost = "192.168.178.1"
	m.recomputeVisible()
	found := false
	for _, f := range m.visible {
		if f.label == "FRITZ!Box username" {
			found = true
		}
	}
	if !found {
		t.Fatal("setting FRITZ!Box host should reveal the username field")
	}
}

// TestChannelCycleAndValidation: ←/→ cycles the channel enum; a bad hostname is
// rejected on commit.
func TestChannelCycleAndValidation(t *testing.T) {
	m := NewBuildForm(build.Settings{ServicebayChannel: "stable"}, noDeps())
	// Cursor 0 is Server name (text). Move to the channel field.
	for m.visible[m.sCursor].label != "ServiceBay channel" {
		mi, _ := m.Update(namedKey(tea.KeyDown))
		m = mi.(BuildFormModel)
	}
	mi, _ := m.Update(namedKey(tea.KeyRight))
	m = mi.(BuildFormModel)
	if m.settings.ServicebayChannel != "test" {
		t.Errorf("channel after right = %q, want test", m.settings.ServicebayChannel)
	}

	// Back to Server name, edit to an invalid hostname → rejected.
	m.sCursor = 0
	mi, _ = m.Update(namedKey(tea.KeyEnter)) // start editing
	m = mi.(BuildFormModel)
	m.buf = "Bad_Name"
	mi, _ = m.Update(namedKey(tea.KeyEnter)) // commit
	m = mi.(BuildFormModel)
	if m.sErr == "" {
		t.Error("invalid hostname should be rejected with an error")
	}
	if m.settings.ServerName == "Bad_Name" {
		t.Error("invalid value must not be stored")
	}
}

// TestPlanAssembly: the gathered image, flash target, and secrets land in the Plan.
func TestPlanAssembly(t *testing.T) {
	m := NewBuildForm(build.Settings{ServerName: "box", GWHost: "192.168.178.1"}, noDeps())
	m.recomputeVisible()
	m.rebuildSecrets()
	m.images = []iso.Choice{
		{Kind: "local", Path: "/a.iso", Label: "A"},
		{Kind: "remote", Stream: "stable", Arch: "x86_64", Label: "B"},
	}
	m.iCursor = 1
	m.devices = []usb.Device{{Path: "/dev/sdz", SizeBytes: 8 << 30, Model: "Stick"}}
	m.fCursor = 1 // first real device
	if len(m.secrets) != 1 || m.secrets[0].envLabel != "FRITZ!Box password" {
		t.Fatalf("secrets = %+v", m.secrets)
	}
	m.secrets[0].value = "gwpw"

	p := m.Plan()
	if p.Image.Kind != "remote" || p.Image.Stream != "stable" {
		t.Errorf("plan image = %+v", p.Image)
	}
	if p.FlashTo != "/dev/sdz" {
		t.Errorf("plan FlashTo = %q", p.FlashTo)
	}
	if p.GWPass != "gwpw" {
		t.Errorf("plan GWPass = %q", p.GWPass)
	}
	if p.Settings.ServerName != "box" {
		t.Errorf("plan settings not carried")
	}
}

// TestSkipFlash: cursor 0 means skip → no FlashTo.
func TestSkipFlash(t *testing.T) {
	m := NewBuildForm(build.Settings{ServerName: "box"}, noDeps())
	m.devices = []usb.Device{{Path: "/dev/sdz", SizeBytes: 8 << 30}}
	m.fCursor = 0
	if p := m.Plan(); p.FlashTo != "" {
		t.Errorf("skip should leave FlashTo empty, got %q", p.FlashTo)
	}
}

// TestReviewConfirms: enter on the review step sets Confirmed + quits.
func TestReviewConfirms(t *testing.T) {
	m := NewBuildForm(build.Settings{ServerName: "box"}, noDeps())
	m.step = stepReview
	mi, cmd := m.Update(namedKey(tea.KeyEnter))
	m = mi.(BuildFormModel)
	if !m.Confirmed || cmd == nil {
		t.Fatalf("review enter should confirm+quit, confirmed=%v", m.Confirmed)
	}
}

// TestEscCancels: esc anywhere quits without confirming.
func TestEscCancels(t *testing.T) {
	m := NewBuildForm(build.Settings{ServerName: "box"}, noDeps())
	mi, cmd := m.Update(namedKey(tea.KeyEsc))
	m = mi.(BuildFormModel)
	if m.Confirmed || cmd == nil {
		t.Fatal("esc should cancel (not confirm) and quit")
	}
}

// TestSettingsViewShowsHelp: the focused field's help text renders.
func TestSettingsViewShowsHelp(t *testing.T) {
	m := NewBuildForm(build.Settings{ServerName: "box"}, noDeps())
	if !strings.Contains(m.View(), "Hostname for the box") {
		t.Error("settings view should show the focused field's help")
	}
}
