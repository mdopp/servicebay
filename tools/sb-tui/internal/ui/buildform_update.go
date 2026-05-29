package ui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"servicebay-tui/internal/usb"
)

// One coherent interaction model across every step:
//
//	↑/↓    move between fields / list rows
//	←/→    change the focused choice field (Y/N, channel)
//	type   edit the focused text field in place (the label is static)
//	enter  Continue ▸ (next step; on Review, build)
//	s-tab  ◂ back a step
//	esc    back to the launcher menu
var (
	inputStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("231")).Background(lipgloss.Color("236"))
	inputFocused = lipgloss.NewStyle().Foreground(lipgloss.Color("231")).Background(lipgloss.Color("63"))
	labelStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("250"))
	labelFocused = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("231"))
	contIdle     = lipgloss.NewStyle().Foreground(lipgloss.Color("240"))
	contStyle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("231")).Background(lipgloss.Color("63")).Padding(0, 1)
)

// Update drives the wizard.
func (m BuildFormModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case imagesLoadedMsg:
		m.images = msg.images
		if msg.defIdx >= 0 && msg.defIdx < len(msg.images) {
			m.iCursor = msg.defIdx
		}
		if len(m.images) == 0 {
			m.imgErr = "no local ISOs found and no remote stream metadata reachable (check network)"
		}
		return m, nil
	case devicesLoadedMsg:
		m.devices = msg.devices
		if msg.err != nil {
			m.devErr = msg.err.Error()
		}
		return m, nil
	case buildConfirmedMsg:
		// Standalone (`sb-tui build`): quit so the entrypoint reads Plan back.
		// When hosted by App, App intercepts this first and never forwards it.
		return m, tea.Quit
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil
	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

func (m BuildFormModel) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+c":
		return m, tea.Quit
	case "esc":
		// Back to the launcher menu (App intercepts backMsg); standalone quits.
		return m, backCmd()
	case "enter":
		return m.advance()
	case "shift+tab":
		if m.step > stepSettings {
			m.step--
			m.tCursor = m.focusedRuneLen()
		}
		return m, nil
	case "up":
		m.moveCursor(-1)
		return m, nil
	case "down":
		m.moveCursor(+1)
		return m, nil
	}
	// Field-specific edits on the focused row.
	switch m.step {
	case stepSettings:
		return m.editSettings(msg)
	case stepSecrets:
		return m.editSecret(msg)
	}
	return m, nil
}

// advance moves to the next step (Enter = Continue), validating settings first;
// on the Review step it confirms the build.
func (m BuildFormModel) advance() (tea.Model, tea.Cmd) {
	switch m.step {
	case stepSettings:
		if e := m.validateSettings(); e != "" {
			m.sErr = e
			return m, nil
		}
		m.rebuildSecrets()
		m.step = stepImage
	case stepImage:
		m.step = stepSecrets
	case stepSecrets:
		m.step = stepFlash
		if m.devices == nil && m.devErr == "" {
			return m, m.loadDevicesCmd()
		}
	case stepFlash:
		m.step = stepReview
	case stepReview:
		m.Confirmed = true
		plan := m.Plan()
		return m, func() tea.Msg { return buildConfirmedMsg{plan: plan} }
	}
	m.tCursor = m.focusedRuneLen() // park caret at end of the new step's field
	return m, nil
}

// moveCursor moves the focus within the current step's list, and parks the
// edit caret at the end of the newly-focused editable value.
func (m *BuildFormModel) moveCursor(d int) {
	switch m.step {
	case stepSettings:
		if n := len(m.visible); n > 0 {
			m.sCursor = (m.sCursor + d + n) % n
			m.sErr = ""
		}
	case stepImage:
		if n := len(m.images); n > 0 {
			m.iCursor = (m.iCursor + d + n) % n
		}
	case stepSecrets:
		if n := len(m.secrets); n > 0 {
			m.secCursor = (m.secCursor + d + n) % n
		}
	case stepFlash:
		n := len(m.devices) + 1 // +1 for "skip"
		m.fCursor = (m.fCursor + d + n) % n
	}
	m.tCursor = m.focusedRuneLen()
}

// editText applies an in-field edit (←/→ move caret, runes insert, backspace
// delete) to a value at the caret, returning the new value. The caret is
// updated in place. Rune-based so it's safe for any input.
func (m *BuildFormModel) editText(msg tea.KeyMsg, value string) (string, bool) {
	r := []rune(value)
	if m.tCursor > len(r) {
		m.tCursor = len(r)
	}
	switch msg.String() {
	case "left":
		if m.tCursor > 0 {
			m.tCursor--
		}
	case "right":
		if m.tCursor < len(r) {
			m.tCursor++
		}
	case "home":
		m.tCursor = 0
	case "end":
		m.tCursor = len(r)
	case "backspace":
		if m.tCursor > 0 {
			r = append(r[:m.tCursor-1], r[m.tCursor:]...)
			m.tCursor--
			return string(r), true
		}
	default:
		if msg.Type == tea.KeyRunes {
			ins := msg.Runes
			r = append(r[:m.tCursor], append(append([]rune{}, ins...), r[m.tCursor:]...)...)
			m.tCursor += len(ins)
			return string(r), true
		}
	}
	return value, false
}

// editSettings edits the focused settings field live: ←/→ cycles a choice; for
// text fields ←/→ moves the caret and runes/backspace edit at it.
func (m BuildFormModel) editSettings(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if len(m.visible) == 0 {
		return m, nil
	}
	f := m.visible[m.sCursor]
	if f.kind == fChoice {
		if msg.String() == "left" || msg.String() == "right" {
			f.set(&m.settings, cycle(f.options, f.get(&m.settings), msg.String() == "right"))
			m.recomputeVisible() // email on/off reveals/hides fields
			m.rebuildSecrets()
		}
		return m, nil
	}
	if v, changed := m.editText(msg, f.get(&m.settings)); changed {
		f.set(&m.settings, v)
		m.recomputeVisible() // clearing FRITZ!Box host hides its username
	}
	return m, nil
}

func (m BuildFormModel) editSecret(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if len(m.secrets) == 0 {
		return m, nil
	}
	if v, changed := m.editText(msg, m.secrets[m.secCursor].value); changed {
		m.secrets[m.secCursor].value = v
	}
	return m, nil
}

// validateSettings returns the first field error (or "").
func (m BuildFormModel) validateSettings() string {
	for _, f := range m.visible {
		if f.valid != nil {
			if e := f.valid(strings.TrimSpace(f.get(&m.settings))); e != "" {
				return f.label + ": " + e
			}
		}
	}
	return ""
}

func (m BuildFormModel) loadDevicesCmd() tea.Cmd {
	deps := m.deps
	return func() tea.Msg {
		devs, err := deps.USB()
		return devicesLoadedMsg{devices: devs, err: err}
	}
}

// View renders the current step with a consistent header, body, Continue
// button, and key legend.
func (m BuildFormModel) View() string {
	width := m.width
	if width <= 0 {
		width = 72
	}
	var b strings.Builder
	b.WriteString(titleStyle.Width(width).Render("ServiceBay  ·  build installer") + "\n")
	b.WriteString(stepStyle.Render(m.stepCrumb()) + "\n\n")

	switch m.step {
	case stepSettings:
		m.viewSettings(&b)
	case stepImage:
		m.viewImage(&b)
	case stepSecrets:
		m.viewSecrets(&b)
	case stepFlash:
		m.viewFlash(&b)
	case stepReview:
		m.viewReview(&b)
	}

	// The Continue button makes "what advances the wizard" visible — Enter
	// activates it (tab is not required / not the only way).
	label := "Continue ▸"
	if m.step == stepReview {
		label = "Build ▸"
	}
	b.WriteString("\n" + contStyle.Render(label) + contIdle.Render("  (Enter)") + "\n")
	b.WriteString(footerStyle.Render(m.legend()))
	return frame(b.String(), m.width, m.height)
}

func (m BuildFormModel) stepCrumb() string {
	names := []string{"Settings", "Image", "Secrets", "Flash", "Review"}
	parts := make([]string, len(names))
	for i, n := range names {
		if buildStep(i) == m.step {
			parts[i] = "[" + n + "]"
		} else {
			parts[i] = n
		}
	}
	return strings.Join(parts, " › ")
}

func (m BuildFormModel) legend() string {
	base := "↑/↓ move · enter continue · shift+tab back · esc menu"
	switch m.step {
	case stepSettings:
		return "↑/↓ move · ←/→ change choice · type to edit · enter continue · esc menu"
	default:
		return base
	}
}

// fieldRowText renders "Label  [value]" with the value in an input box, so it's
// clear the label is static and only the value is editable. Focused rows get a
// caret + highlight.
func renderField(label, value string, focused, choice bool, caret int) string {
	ls, is := labelStyle, inputStyle
	if focused {
		ls, is = labelFocused, inputFocused
	}
	box := value
	switch {
	case choice:
		box = "‹ " + value + " ›"
	case focused:
		// Block caret at the edit position, so ←/→ visibly moves within the text.
		r := []rune(value)
		if caret < 0 {
			caret = 0
		}
		if caret > len(r) {
			caret = len(r)
		}
		box = string(r[:caret]) + "▌" + string(r[caret:])
	}
	cursor := "  "
	if focused {
		cursor = "❯ "
	}
	return cursor + ls.Render(fmt.Sprintf("%-22s", label)) + is.Render(" "+box+" ")
}

func (m BuildFormModel) viewSettings(b *strings.Builder) {
	for i, f := range m.visible {
		b.WriteString(renderField(f.label, f.get(&m.settings), i == m.sCursor, f.kind == fChoice, m.tCursor) + "\n")
	}
	if m.sCursor < len(m.visible) {
		b.WriteString("\n" + helpStyle.Render(m.visible[m.sCursor].help) + "\n")
	}
	if m.sErr != "" {
		b.WriteString(detailStyle.Render(cfgErrStyle.Render("✗ "+m.sErr)) + "\n")
	}
}

func (m BuildFormModel) viewImage(b *strings.Builder) {
	if m.imgErr != "" {
		b.WriteString(detailStyle.Render(cfgErrStyle.Render(m.imgErr)) + "\n")
		return
	}
	if len(m.images) == 0 {
		b.WriteString(detailStyle.Render("Loading available images…") + "\n")
		return
	}
	b.WriteString(phaseStyle.Render("Choose the Fedora CoreOS image (↑/↓), then Enter:") + "\n\n")
	for i, c := range m.images {
		if i == m.iCursor {
			b.WriteString(selectedStyle.Render("❯ "+c.Label) + cfgOKStyle.Render("  ● will be used") + "\n")
		} else {
			b.WriteString(normalStyle.Render("  "+c.Label) + "\n")
		}
	}
}

func (m BuildFormModel) viewSecrets(b *strings.Builder) {
	if len(m.secrets) == 0 {
		b.WriteString(detailStyle.Render("No external passwords needed — press Enter to continue.") + "\n")
		return
	}
	b.WriteString(phaseStyle.Render("External account passwords ServiceBay can't generate:") + "\n\n")
	for i, sr := range m.secrets {
		masked := strings.Repeat("•", len([]rune(sr.value)))
		b.WriteString(renderField(sr.envLabel, masked, i == m.secCursor, false, m.tCursor) + "\n")
	}
}

func (m BuildFormModel) viewFlash(b *strings.Builder) {
	b.WriteString(phaseStyle.Render("Write the baked ISO to a USB stick? (↑/↓ choose, Enter continue)") + "\n\n")
	rows := append([]string{"Skip — don't write to USB"}, deviceLabels(m.devices)...)
	for i, label := range rows {
		if i == m.fCursor {
			b.WriteString(selectedStyle.Render("❯ "+label) + "\n")
		} else {
			b.WriteString(normalStyle.Render("  "+label) + "\n")
		}
	}
	if m.devErr != "" {
		b.WriteString(detailStyle.Render(cfgEmptyStyle.Render("(USB enumeration unavailable: "+m.devErr+")")) + "\n")
	}
}

func deviceLabels(devs []usb.Device) []string {
	out := make([]string, len(devs))
	for i, d := range devs {
		out[i] = d.Label()
	}
	return out
}

func (m BuildFormModel) viewReview(b *strings.Builder) {
	s := m.settings
	b.WriteString(phaseStyle.Render("Review — press Enter to build.") + "\n\n")
	row := func(k, v string) { b.WriteString(normalStyle.Render(fmt.Sprintf("  %-20s %s", k+":", v)) + "\n") }
	row("Server", s.ServerName)
	row("Network", s.StaticIP+"/"+s.StaticPrefix+" via "+s.NetInterface)
	row("Channel", s.ServicebayChannel+"  (→ image tag)")
	img := "(none)"
	if m.iCursor < len(m.images) {
		img = m.images[m.iCursor].Label
	}
	row("Image", img)
	if m.fCursor >= 1 && m.fCursor-1 < len(m.devices) {
		b.WriteString(warnStyle.Render("  Will ERASE + write: "+m.devices[m.fCursor-1].Label()) + "\n")
	} else {
		row("USB", "skip (no write)")
	}
}
