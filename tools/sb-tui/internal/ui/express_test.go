package ui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestExpressConfirm(t *testing.T) {
	m := NewExpress("192.168.1.10", "5888")
	// Enter confirms the plan and quits.
	mi, cmd := m.Update(namedKey(tea.KeyEnter))
	m = mi.(ExpressModel)
	if !m.Confirmed || cmd == nil {
		t.Fatalf("enter should confirm + quit, confirmed=%v", m.Confirmed)
	}
}

func TestExpressCancel(t *testing.T) {
	m := NewExpress("", "")
	mi, cmd := m.Update(runeKey('q'))
	m = mi.(ExpressModel)
	if m.Confirmed || cmd == nil {
		t.Fatalf("q should cancel (not confirm) + quit, confirmed=%v", m.Confirmed)
	}
}

func TestExpressBackupToggle(t *testing.T) {
	m := NewExpress("box.local", "5888")
	if m.StageBackup {
		t.Fatal("backup staging should be off by default")
	}
	// Space toggles it on, and the plan then lists the staging step.
	mi, _ := m.Update(runeKey(' '))
	m = mi.(ExpressModel)
	if !m.StageBackup {
		t.Fatal("space should toggle backup staging on")
	}
	if !strings.Contains(m.View(), "Stage your existing backup on the NAS") {
		t.Error("toggled-on view should list the staging step")
	}
	// Enter still confirms — and carries the toggle for the entrypoint to read.
	mi, cmd := m.Update(namedKey(tea.KeyEnter))
	m = mi.(ExpressModel)
	if !m.Confirmed || !m.StageBackup || cmd == nil {
		t.Fatalf("enter should confirm with staging on: confirmed=%v stage=%v", m.Confirmed, m.StageBackup)
	}
}

func TestExpressViewShowsPlanAndTarget(t *testing.T) {
	v := NewExpress("box.local", "5888").View()
	for _, want := range []string{"express setup", "Build", "Watch", "box.local:5888"} {
		if !strings.Contains(v, want) {
			t.Errorf("view missing %q", want)
		}
	}
	// With no host yet, the target falls back to a discovery hint.
	if !strings.Contains(NewExpress("", "").View(), "discovered") {
		t.Error("empty-target view should show the discovery hint")
	}
}
