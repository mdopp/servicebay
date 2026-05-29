package ui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// Update drives the wizard: per-step field editing + step navigation.
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
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil
	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

func (m BuildFormModel) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if msg.String() == "ctrl+c" {
		return m, tea.Quit // cancel
	}
	// Editing a text field captures most keys.
	if m.editing {
		return m.handleEditKey(msg)
	}
	switch msg.String() {
	case "esc":
		return m, tea.Quit // cancel the whole wizard
	case "tab":
		return m.nextStep()
	case "shift+tab":
		return m.prevStep()
	}
	switch m.step {
	case stepSettings:
		return m.handleSettingsKey(msg)
	case stepImage:
		return m.handleListKey(msg, len(m.images), &m.iCursor)
	case stepSecrets:
		return m.handleSecretsKey(msg)
	case stepFlash:
		return m.handleListKey(msg, len(m.devices)+1, &m.fCursor) // +1 for "skip"
	case stepReview:
		if msg.String() == "enter" {
			m.Confirmed = true
			return m, tea.Quit
		}
	}
	return m, nil
}

// handleEditKey edits the focused text field (settings or secret).
func (m BuildFormModel) handleEditKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.editing, m.buf, m.sErr = false, "", ""
		return m, nil
	case "enter":
		return m.commitEdit()
	case "backspace":
		if m.buf != "" {
			m.buf = m.buf[:len(m.buf)-1]
		}
		return m, nil
	default:
		if msg.Type == tea.KeyRunes {
			m.buf += string(msg.Runes)
		}
		return m, nil
	}
}

// commitEdit validates + stores the edit buffer back into settings/secrets.
func (m BuildFormModel) commitEdit() (tea.Model, tea.Cmd) {
	if m.step == stepSecrets {
		m.secrets[m.secCursor].value = m.buf
		m.editing, m.buf = false, ""
		return m, nil
	}
	f := m.visible[m.sCursor]
	v := strings.TrimSpace(m.buf)
	if f.valid != nil {
		if e := f.valid(v); e != "" {
			m.sErr = e
			return m, nil
		}
	}
	f.set(&m.settings, v)
	m.editing, m.buf, m.sErr = false, "", ""
	// An edit (e.g. FRITZ!Box host) can change which fields/secrets apply.
	m.recomputeVisible()
	m.rebuildSecrets()
	return m, nil
}

func (m BuildFormModel) handleSettingsKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if len(m.visible) == 0 {
		return m, nil
	}
	f := m.visible[m.sCursor]
	switch msg.String() {
	case "up", "k":
		m.sCursor = (m.sCursor - 1 + len(m.visible)) % len(m.visible)
		m.sErr = ""
	case "down", "j":
		m.sCursor = (m.sCursor + 1) % len(m.visible)
		m.sErr = ""
	case "left", "right":
		if f.kind == fChoice {
			f.set(&m.settings, cycle(f.options, f.get(&m.settings), msg.String() == "right"))
			m.recomputeVisible()
			m.rebuildSecrets()
		}
	case "enter":
		if f.kind == fText {
			m.editing, m.buf, m.sErr = true, f.get(&m.settings), ""
		}
	}
	return m, nil
}

func (m BuildFormModel) handleSecretsKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if len(m.secrets) == 0 {
		return m, nil
	}
	switch msg.String() {
	case "up", "k":
		m.secCursor = (m.secCursor - 1 + len(m.secrets)) % len(m.secrets)
	case "down", "j":
		m.secCursor = (m.secCursor + 1) % len(m.secrets)
	case "enter":
		m.editing, m.buf = true, m.secrets[m.secCursor].value
	}
	return m, nil
}

// handleListKey moves a cursor over n items (used for image + flash lists).
func (m BuildFormModel) handleListKey(msg tea.KeyMsg, n int, cursor *int) (tea.Model, tea.Cmd) {
	if n == 0 {
		return m, nil
	}
	switch msg.String() {
	case "up", "k":
		*cursor = (*cursor - 1 + n) % n
	case "down", "j":
		*cursor = (*cursor + 1) % n
	}
	return m, nil
}

// nextStep advances the wizard, running per-step side effects + validation.
func (m BuildFormModel) nextStep() (tea.Model, tea.Cmd) {
	switch m.step {
	case stepSettings:
		// Block leaving settings with an invalid value on the focused field.
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
		return m, tea.Quit
	}
	return m, nil
}

func (m BuildFormModel) prevStep() (tea.Model, tea.Cmd) {
	if m.step > stepSettings {
		m.step--
	}
	return m, nil
}

func (m BuildFormModel) loadDevicesCmd() tea.Cmd {
	deps := m.deps
	return func() tea.Msg {
		devs, err := deps.USB()
		return devicesLoadedMsg{devices: devs, err: err}
	}
}

// View renders the current step.
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

	b.WriteString("\n" + footerStyle.Render(m.footer()))
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

func (m BuildFormModel) footer() string {
	if m.editing {
		return "type to edit · enter save · esc cancel"
	}
	switch m.step {
	case stepReview:
		return "enter build · shift+tab back · esc cancel"
	case stepSettings:
		return "↑/↓ move · ←/→ choose · enter edit · tab next · esc cancel"
	default:
		return "↑/↓ move · tab next · shift+tab back · esc cancel"
	}
}

func (m BuildFormModel) viewSettings(b *strings.Builder) {
	for i, f := range m.visible {
		val := f.get(&m.settings)
		if m.editing && i == m.sCursor {
			b.WriteString(cfgEditingStyle.Render(f.label+": "+m.buf+"▌") + "\n")
			continue
		}
		rendered := f.label + ": " + valueText(val)
		if i == m.sCursor {
			b.WriteString(selectedStyle.Render("❯ "+f.label+": ") + valueText(val) + "\n")
		} else {
			b.WriteString(normalStyle.Render("  "+rendered) + "\n")
		}
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
	b.WriteString(phaseStyle.Render("Pick the Fedora CoreOS image to build from:") + "\n\n")
	for i, c := range m.images {
		line := "  " + c.Label
		if i == m.iCursor {
			line = selectedStyle.Render("❯ " + c.Label)
		}
		b.WriteString(line + "\n")
	}
}

func (m BuildFormModel) viewSecrets(b *strings.Builder) {
	if len(m.secrets) == 0 {
		b.WriteString(detailStyle.Render("No external passwords needed — press tab to continue.") + "\n")
		return
	}
	b.WriteString(phaseStyle.Render("External account passwords ServiceBay can't generate:") + "\n\n")
	for i, sr := range m.secrets {
		masked := strings.Repeat("•", len(sr.value))
		if m.editing && i == m.secCursor {
			b.WriteString(cfgEditingStyle.Render(sr.envLabel+": "+masked+"▌") + "\n")
			continue
		}
		row := sr.envLabel + ": " + valueText(masked)
		if i == m.secCursor {
			b.WriteString(selectedStyle.Render("❯ "+sr.envLabel+": ") + valueText(masked) + "\n")
		} else {
			b.WriteString(normalStyle.Render("  "+row) + "\n")
		}
	}
}

func (m BuildFormModel) viewFlash(b *strings.Builder) {
	b.WriteString(phaseStyle.Render("Write the baked ISO to a USB stick? (chosen at Review)") + "\n\n")
	skip := "  Skip — don't write to USB"
	if m.fCursor == 0 {
		skip = selectedStyle.Render("❯ Skip — don't write to USB")
	}
	b.WriteString(skip + "\n")
	if m.devErr != "" {
		b.WriteString(detailStyle.Render(cfgEmptyStyle.Render("(USB enumeration unavailable: "+m.devErr+")")) + "\n")
	}
	for i, d := range m.devices {
		line := "  " + d.Label()
		if m.fCursor == i+1 {
			line = selectedStyle.Render("❯ " + d.Label())
		}
		b.WriteString(line + "\n")
	}
}

func (m BuildFormModel) viewReview(b *strings.Builder) {
	s := m.settings
	b.WriteString(phaseStyle.Render("Review — press enter to build.") + "\n\n")
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
