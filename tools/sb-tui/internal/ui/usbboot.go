// The Bubble Tea "boot from USB + reinstall" flow (#1272 UX). When the operator
// has plugged the freshly-built USB into a still-running box, this signs in with
// the box admin credentials and sets a one-shot UEFI BootNext to the USB, then
// reboots the box — so the next boot installs from the USB instead of the
// existing disk. It uses cookie auth (rest.EnsureUSBBoot), so it works against
// the current/old ServiceBay too. On success it hands off to a reinstall watch.
package ui

import (
	"context"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"servicebay-tui/internal/rest"
)

// openReinstallWatchMsg asks the App to open a reinstall-aware watch dashboard.
type openReinstallWatchMsg struct{ host, port string }

type usbBootResultMsg struct {
	msg string
	err error
}

// USBBootModel collects admin credentials and triggers the one-shot USB boot.
type USBBootModel struct {
	host, port    string
	width, height int

	username, password textInput
	focus              int
	submitting         bool
	errMsg             string
}

// NewUSBBoot builds the flow for a target box.
func NewUSBBoot(host, port string) USBBootModel {
	return USBBootModel{
		host:     host,
		port:     port,
		username: newTextInput("", false),
		password: newTextInput("", true),
	}
}

func (m USBBootModel) submitCmd() tea.Cmd {
	host, port, user, pass := m.host, m.port, m.username.Value(), m.password.Value()
	return func() tea.Msg {
		msg, err := rest.EnsureUSBBoot(context.Background(), host, port, user, pass)
		return usbBootResultMsg{msg: msg, err: err}
	}
}

// Init is a no-op; idle until the operator types.
func (m USBBootModel) Init() tea.Cmd { return nil }

// Update handles editing, submit, and the result. On success it bubbles
// openReinstallWatchMsg up to the App to start watching the reinstall.
func (m USBBootModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case usbBootResultMsg:
		m.submitting = false
		if msg.err != nil {
			m.errMsg = friendlyErr(msg.err)
			m.password.SetValue("")
			m.focus = 1
			return m, nil
		}
		host, port := m.host, m.port
		return m, func() tea.Msg { return openReinstallWatchMsg{host: host, port: port} }
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil
	case tea.KeyMsg:
		if m.submitting {
			return m, nil
		}
		return m.handleKey(msg)
	}
	return m, nil
}

func (m USBBootModel) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		return m, func() tea.Msg { return backMsg{} }
	case "tab", "down", "up", "shift+tab":
		m.focus = (m.focus + 1) % 2
		return m, nil
	case "enter":
		if m.username.Value() != "" && m.password.Value() != "" {
			m.submitting, m.errMsg = true, ""
			return m, m.submitCmd()
		}
		m.focus = (m.focus + 1) % 2
		return m, nil
	}
	// Everything else (caret movement, backspace/delete, runes) edits the
	// focused field.
	if m.focus == 0 {
		m.username.handleKey(msg)
	} else {
		m.password.handleKey(msg)
	}
	return m, nil
}

// View renders the form.
func (m USBBootModel) View() string {
	width := m.width
	if width <= 0 {
		width = 72
	}
	var b strings.Builder
	b.WriteString(titleStyle.Width(width).Render("ServiceBay  ·  boot box from USB") + "\n")
	b.WriteString(phaseStyle.Render("Reinstall "+m.host+" from the USB you just built.") + "\n")
	b.WriteString(detailStyle.Render("Make sure the USB stick is plugged into the server first. Sign in with the") + "\n")
	b.WriteString(detailStyle.Render("box admin login; this sets a one-shot UEFI boot to the USB and reboots it.") + "\n\n")

	b.WriteString(m.username.render("Username", m.focus == 0) + "\n")
	b.WriteString(m.password.render("Password", m.focus == 1) + "\n")

	if m.submitting {
		b.WriteString("\n" + detailStyle.Render("Signing in and setting USB boot…") + "\n")
	} else if m.errMsg != "" {
		b.WriteString("\n" + detailStyle.Render(cfgErrStyle.Render("✗ "+m.errMsg)) + "\n")
	}
	b.WriteString("\n" + footerStyle.Render("tab switch · enter set USB boot + reboot · esc back"))
	return frame(b.String(), m.width, m.height)
}
