package ui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// typeInto feeds each rune of s into the field at the caret.
func typeInto(t *textInput, s string) {
	for _, r := range s {
		t.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
}

func TestTextInputInsertAtCaret(t *testing.T) {
	ti := newTextInput("", false)
	typeInto(&ti, "helo")
	// Move the caret back one (between 'l' and 'o') and insert the missing 'l'.
	ti.handleKey(namedKey(tea.KeyLeft))
	typeInto(&ti, "l")
	if ti.Value() != "hello" {
		t.Fatalf("insert-at-caret = %q, want hello", ti.Value())
	}
}

func TestTextInputBackspaceAndDeleteAtCaret(t *testing.T) {
	ti := newTextInput("abc", false)
	// Caret seeds at the end; backspace removes 'c'.
	ti.handleKey(namedKey(tea.KeyBackspace))
	if ti.Value() != "ab" {
		t.Fatalf("backspace = %q, want ab", ti.Value())
	}
	// Home, then delete-forward removes 'a'.
	ti.handleKey(namedKey(tea.KeyHome))
	ti.handleKey(namedKey(tea.KeyDelete))
	if ti.Value() != "b" {
		t.Fatalf("delete-forward = %q, want b", ti.Value())
	}
}

func TestTextInputCaretClampsAtEnds(t *testing.T) {
	ti := newTextInput("ab", false)
	// Walking past the left edge must not move the caret negative.
	for range 5 {
		ti.handleKey(namedKey(tea.KeyLeft))
	}
	typeInto(&ti, "X") // inserts at the very start
	if ti.Value() != "Xab" {
		t.Fatalf("left-clamp insert = %q, want Xab", ti.Value())
	}
}

func TestTextInputHandleKeyReportsConsumption(t *testing.T) {
	ti := newTextInput("", false)
	if !ti.handleKey(runeKey('x')) {
		t.Error("a rune should be consumed")
	}
	// A navigation/submit key the field doesn't own must bubble up (return false).
	if ti.handleKey(namedKey(tea.KeyEnter)) {
		t.Error("enter should not be consumed by the field")
	}
}

func TestTextInputSecretMasksButKeepsValue(t *testing.T) {
	ti := newTextInput("", true)
	typeInto(&ti, "pw")
	if ti.Value() != "pw" {
		t.Fatalf("secret value = %q, want pw", ti.Value())
	}
	shown := ti.display(false)
	if strings.Contains(shown, "pw") {
		t.Errorf("secret display leaks value: %q", shown)
	}
	if shown != "••" {
		t.Errorf("secret display = %q, want two bullets", shown)
	}
}

func TestTextInputCaretShownWhenFocused(t *testing.T) {
	ti := newTextInput("ab", false)
	ti.handleKey(namedKey(tea.KeyLeft)) // caret between 'a' and 'b'
	if got := ti.display(true); got != "a▌b" {
		t.Errorf("focused display = %q, want a▌b", got)
	}
	if got := ti.display(false); got != "ab" {
		t.Errorf("unfocused display = %q, want ab", got)
	}
}
