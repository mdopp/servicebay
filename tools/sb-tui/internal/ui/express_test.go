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
