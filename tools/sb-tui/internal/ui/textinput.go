package ui

import (
	"fmt"

	tea "github.com/charmbracelet/bubbletea"
)

// textInput is a single-line text field with a cursor — shared by every panel
// so editing behaves identically everywhere: ←/→ move the caret, home/end jump
// to the ends, backspace/delete edit at the caret, and runes insert at it.
// secret masks the value with bullets. This replaces the per-panel char-append
// editing (which had no caret movement) with the same model the build form uses.
type textInput struct {
	value  string
	cursor int // caret position as a rune index, 0..len(runes)
	secret bool
}

// newTextInput seeds a field with an initial value and parks the caret at its end.
func newTextInput(value string, secret bool) textInput {
	return textInput{value: value, cursor: len([]rune(value)), secret: secret}
}

// Value returns the current text.
func (t textInput) Value() string { return t.value }

// SetValue replaces the text and moves the caret to the end.
func (t *textInput) SetValue(v string) {
	t.value = v
	t.cursor = len([]rune(v))
}

// handleKey applies one key event at the caret. Returns true if it consumed the
// key (an editing/caret key), false otherwise (so the panel can treat it as
// navigation/submit). Callers route field-navigation keys (tab/↑/↓, enter) to
// themselves and everything else here.
func (t *textInput) handleKey(msg tea.KeyMsg) bool {
	r := []rune(t.value)
	if t.cursor > len(r) {
		t.cursor = len(r)
	}
	switch msg.String() {
	case "left":
		if t.cursor > 0 {
			t.cursor--
		}
	case "right":
		if t.cursor < len(r) {
			t.cursor++
		}
	case "home", "ctrl+a":
		t.cursor = 0
	case "end", "ctrl+e":
		t.cursor = len(r)
	case "backspace":
		if t.cursor > 0 {
			r = append(r[:t.cursor-1], r[t.cursor:]...)
			t.cursor--
			t.value = string(r)
		}
	case "delete":
		if t.cursor < len(r) {
			r = append(r[:t.cursor], r[t.cursor+1:]...)
			t.value = string(r)
		}
	default:
		if msg.Type != tea.KeyRunes {
			return false
		}
		ins := msg.Runes
		r = append(r[:t.cursor], append(append([]rune{}, ins...), r[t.cursor:]...)...)
		t.cursor += len(ins)
		t.value = string(r)
	}
	return true
}

// display returns the (masked) value with the caret inserted at the cursor when
// focused. Panels that draw their own framing (e.g. config's edit highlight)
// use this; render wraps it in the standard fieldRow framing.
func (t textInput) display(focused bool) string {
	r := []rune(t.value)
	disp := make([]rune, len(r))
	for i := range r {
		if t.secret {
			disp[i] = '•'
		} else {
			disp[i] = r[i]
		}
	}
	if !focused {
		return string(disp)
	}
	c := t.cursor
	if c > len(disp) {
		c = len(disp)
	}
	return string(disp[:c]) + "▌" + string(disp[c:])
}

// render draws the field as the build form's standard input row — a static,
// padded label followed by the editable value in an input box (`❯ Label  [ value ]`),
// with a block caret when focused and bullets when secret. Shared by every
// simple panel (login, usb-boot, NAS upload) so they match the build wizard.
func (t textInput) render(label string, focused bool) string {
	ls, is := labelStyle, inputStyle
	if focused {
		ls, is = labelFocused, inputFocused
	}
	cursor := "  "
	if focused {
		cursor = "❯ "
	}
	return cursor + ls.Render(fmt.Sprintf("%-22s", label)) + is.Render(" "+t.display(focused)+" ")
}
