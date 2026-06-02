package ui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"sb/internal/rest"
)

func typeStr(m LoginModel, s string) LoginModel {
	for _, r := range s {
		mi, _ := m.Update(runeKey(r))
		m = mi.(LoginModel)
	}
	return m
}

func TestLoginTypeAndSubmit(t *testing.T) {
	m := NewLogin("box", "5888")
	m = typeStr(m, "admin") // focus starts on username
	mi, _ := m.Update(namedKey(tea.KeyTab))
	m = mi.(LoginModel)
	m = typeStr(m, "pw")
	if m.username.Value() != "admin" || m.password.Value() != "pw" {
		t.Fatalf("fields: user=%q pass=%q", m.username.Value(), m.password.Value())
	}
	// Enter with both filled submits.
	mi, cmd := m.Update(namedKey(tea.KeyEnter))
	m = mi.(LoginModel)
	if !m.submitting || cmd == nil {
		t.Fatalf("enter should submit, submitting=%v", m.submitting)
	}
	// Password must be masked in the view.
	if strings.Contains(m.View(), "pw") {
		t.Error("password should be masked in the view")
	}
}

func TestLoginSuccessEmitsAuth(t *testing.T) {
	m := NewLogin("box", "5888")
	mi, cmd := m.Update(loginResultMsg{token: "sb_ok"})
	m = mi.(LoginModel)
	if cmd == nil {
		t.Fatal("success should emit a command")
	}
	if _, ok := cmd().(authSucceededMsg); !ok {
		t.Errorf("expected authSucceededMsg, got %T", cmd())
	}
}

func TestLoginErrorClearsPassword(t *testing.T) {
	m := NewLogin("box", "5888")
	m.username.SetValue("admin")
	m.password.SetValue("wrong")
	m.submitting = true
	mi, _ := m.Update(loginResultMsg{err: rest.ErrLoginRejected})
	m = mi.(LoginModel)
	if m.submitting {
		t.Error("should clear submitting on error")
	}
	if m.password.Value() != "" {
		t.Errorf("password should be cleared, got %q", m.password.Value())
	}
	if m.username.Value() != "admin" {
		t.Errorf("username should be kept, got %q", m.username.Value())
	}
	if !strings.Contains(m.View(), "✗") {
		t.Error("view should show the error")
	}
}

func TestLoginEscGoesBack(t *testing.T) {
	m := NewLogin("box", "5888")
	mi, cmd := m.Update(namedKey(tea.KeyEsc))
	_ = mi
	if cmd == nil {
		t.Fatal("esc should emit a command")
	}
	if _, ok := cmd().(backMsg); !ok {
		t.Errorf("esc should emit backMsg, got %T", cmd())
	}
}
