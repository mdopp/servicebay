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

// TestChannelCycleAndValidation: ←/→ cycles the channel enum; Enter (advance) is
// blocked while a field is invalid.
func TestChannelCycleAndValidation(t *testing.T) {
	m := NewBuildForm(build.Settings{ServicebayChannel: "stable"}, noDeps())
	// Move focus to the channel field and cycle it with →.
	for m.visible[m.sCursor].label != "ServiceBay channel" {
		mi, _ := m.Update(namedKey(tea.KeyDown))
		m = mi.(BuildFormModel)
	}
	mi, _ := m.Update(namedKey(tea.KeyRight))
	m = mi.(BuildFormModel)
	if m.settings.ServicebayChannel != "test" {
		t.Errorf("channel after right = %q, want test", m.settings.ServicebayChannel)
	}

	// Type an invalid hostname into Server name (live), then Enter must NOT
	// advance — it surfaces the validation error and stays on Settings.
	m.sCursor = 0
	for _, r := range "Bad_Name" {
		mi, _ := m.Update(runeKey(r))
		m = mi.(BuildFormModel)
	}
	if m.settings.ServerName != "Bad_Name" {
		t.Fatalf("live edit should update the value, got %q", m.settings.ServerName)
	}
	mi, _ = m.Update(namedKey(tea.KeyEnter))
	m = mi.(BuildFormModel)
	if m.sErr == "" || m.step != stepSettings {
		t.Errorf("invalid hostname should block advance: err=%q step=%v", m.sErr, m.step)
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

// TestHostnameAllowsMixedCase: RFC-1123 mixed-case hostnames are valid.
func TestHostnameAllowsMixedCase(t *testing.T) {
	m := NewBuildForm(build.Settings{ServerName: "atHome-Server"}, noDeps())
	if e := m.validateSettings(); e != "" {
		t.Errorf("mixed-case hostname rejected: %q", e)
	}
	bad := NewBuildForm(build.Settings{ServerName: "-bad"}, noDeps())
	if bad.validateSettings() == "" {
		t.Error("leading-hyphen hostname should still be rejected")
	}
}

// TestInFieldCursorEdit: ←/→ move the caret and edits happen at it.
func TestInFieldCursorEdit(t *testing.T) {
	m := NewBuildForm(build.Settings{ServerName: "abc"}, noDeps())
	// Focus is Server name, caret parked at end (3).
	if m.tCursor != 3 {
		t.Fatalf("initial caret = %d, want 3", m.tCursor)
	}
	// Move left twice → between 'a' and 'b', insert 'X' → "aXbc".
	mi, _ := m.Update(namedKey(tea.KeyLeft))
	m = mi.(BuildFormModel)
	mi, _ = m.Update(namedKey(tea.KeyLeft))
	m = mi.(BuildFormModel)
	if m.tCursor != 1 {
		t.Fatalf("caret after 2×left = %d, want 1", m.tCursor)
	}
	mi, _ = m.Update(runeKey('X'))
	m = mi.(BuildFormModel)
	if m.settings.ServerName != "aXbc" {
		t.Errorf("mid-field insert = %q, want aXbc", m.settings.ServerName)
	}
	// Backspace deletes before the caret (now at index 2) → "abc".
	mi, _ = m.Update(namedKey(tea.KeyBackspace))
	m = mi.(BuildFormModel)
	if m.settings.ServerName != "abc" {
		t.Errorf("backspace at caret = %q, want abc", m.settings.ServerName)
	}
}

// TestSSHKeyGenerate: Ctrl+G on the SSH field runs GenerateSSHKey and fills the
// field with the returned public key.
func TestSSHKeyGenerate(t *testing.T) {
	deps := noDeps()
	deps.GenerateSSHKey = func() (string, error) { return "ssh-ed25519 AAAAGEN test@host", nil }
	m := NewBuildForm(build.Settings{}, deps)
	for m.visible[m.sCursor].label != "SSH public key" {
		mi, _ := m.Update(namedKey(tea.KeyDown))
		m = mi.(BuildFormModel)
	}
	mi, cmd := m.Update(tea.KeyMsg{Type: tea.KeyCtrlG})
	m = mi.(BuildFormModel)
	if cmd == nil {
		t.Fatal("ctrl+g on the SSH field should issue a generate command")
	}
	mi, _ = m.Update(cmd()) // deliver sshKeyGeneratedMsg
	m = mi.(BuildFormModel)
	if m.settings.SSHAuthorizedKey != "ssh-ed25519 AAAAGEN test@host" {
		t.Errorf("generated key not stored: %q", m.settings.SSHAuthorizedKey)
	}
}

// TestSettingsViewShowsHelp: the focused field's help text renders.
func TestSettingsViewShowsHelp(t *testing.T) {
	m := NewBuildForm(build.Settings{ServerName: "box"}, noDeps())
	if !strings.Contains(m.View(), "Hostname for the box") {
		t.Error("settings view should show the focused field's help")
	}
}
