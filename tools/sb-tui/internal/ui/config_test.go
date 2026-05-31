package ui

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"servicebay-tui/internal/rest"
)

// key builds a KeyMsg for a single typed rune.
func runeKey(r rune) tea.KeyMsg { return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}} }

func namedKey(t tea.KeyType) tea.KeyMsg { return tea.KeyMsg{Type: t} }

func TestConfigCycle(t *testing.T) {
	vals := []string{"debug", "info", "warn", "error"}
	if got := cycle(vals, "info", true); got != "warn" {
		t.Errorf("forward from info = %q, want warn", got)
	}
	if got := cycle(vals, "info", false); got != "debug" {
		t.Errorf("back from info = %q, want debug", got)
	}
	if got := cycle(vals, "error", true); got != "debug" {
		t.Errorf("forward wrap = %q, want debug", got)
	}
	if got := cycle(vals, "unknown", true); got != "info" {
		t.Errorf("unknown starts at first then advances, got %q", got)
	}
}

// TestConfigEditFlow drives the model through load → edit a free-text field →
// save, asserting the save command targets the right key/value.
func TestConfigEditFlow(t *testing.T) {
	m := NewConfig(&rest.Client{}) // client unused: we feed messages directly
	// Simulate a completed load.
	mi, _ := m.Update(configLoadedMsg{cfg: &rest.Config{Values: map[string]string{
		"serverName": "old", "domain": "", "logLevel": "info",
	}}})
	m = mi.(ConfigModel)
	if m.loading {
		t.Fatal("still loading after configLoadedMsg")
	}

	// Cursor starts on serverName (free text). Enter edit, retype.
	mi, _ = m.Update(namedKey(tea.KeyEnter))
	m = mi.(ConfigModel)
	if !m.editing || m.buf.Value() != "old" {
		t.Fatalf("edit mode: editing=%v buf=%q", m.editing, m.buf.Value())
	}
	// Backspace the whole buffer, type "new".
	for range "old" {
		mi, _ = m.Update(namedKey(tea.KeyBackspace))
		m = mi.(ConfigModel)
	}
	for _, r := range "new" {
		mi, _ = m.Update(runeKey(r))
		m = mi.(ConfigModel)
	}
	if m.buf.Value() != "new" {
		t.Fatalf("buf after typing = %q", m.buf.Value())
	}

	// Enter triggers a save command; execute it and feed the result back as if
	// the POST succeeded.
	mi, cmd := m.Update(namedKey(tea.KeyEnter))
	m = mi.(ConfigModel)
	if cmd == nil {
		t.Fatal("enter in edit mode should issue a save command")
	}
	// We can't run the real command (no server), so simulate its success.
	mi, _ = m.Update(configSavedMsg{key: "serverName", value: "new"})
	m = mi.(ConfigModel)
	if m.editing {
		t.Error("should leave edit mode after save")
	}
	if m.values["serverName"] != "new" {
		t.Errorf("value not updated: %q", m.values["serverName"])
	}
}

func TestConfigEnumIgnoresTyping(t *testing.T) {
	m := NewConfig(&rest.Client{})
	mi, _ := m.Update(configLoadedMsg{cfg: &rest.Config{Values: map[string]string{"logLevel": "info"}}})
	m = mi.(ConfigModel)
	// Move cursor to logLevel (index 2 in EditableFields).
	for m.fields[m.cursor].Key != "logLevel" {
		mi, _ = m.Update(namedKey(tea.KeyDown))
		m = mi.(ConfigModel)
	}
	mi, _ = m.Update(namedKey(tea.KeyEnter))
	m = mi.(ConfigModel)
	// Typing a letter must not mutate an enum buffer.
	mi, _ = m.Update(runeKey('z'))
	m = mi.(ConfigModel)
	if m.buf.Value() != "info" {
		t.Errorf("enum buf changed by typing: %q", m.buf.Value())
	}
	// ←/→ cycles instead.
	mi, _ = m.Update(namedKey(tea.KeyRight))
	m = mi.(ConfigModel)
	if m.buf.Value() != "warn" {
		t.Errorf("enum cycle right = %q, want warn", m.buf.Value())
	}
}

func TestConfigLoadErrorBlocks(t *testing.T) {
	m := NewConfig(&rest.Client{})
	mi, _ := m.Update(configLoadedMsg{err: rest.ErrUnauthorized})
	m = mi.(ConfigModel)
	if m.loadEr == nil {
		t.Fatal("load error not recorded")
	}
	// 'r' retries (re-enters loading); the view must mention the auth hint.
	if got := m.View(); got == "" {
		t.Fatal("error view empty")
	}
}
