// The Bubble Tea login sub-view (#1272 UX): the in-TUI replacement for "go to
// the web UI and paste an API token". The operator types the box username +
// password once; the TUI logs in, mints a scoped token for itself, persists it,
// and proceeds into the requested panel. No browser, no SB_TOKEN env var.
package ui

import (
	"context"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"servicebay-tui/internal/rest"
)

// authSucceededMsg is emitted to the parent App when login mints a token.
type authSucceededMsg struct{ token string }

// loginResultMsg carries the outcome of a login attempt.
type loginResultMsg struct {
	token string
	err   error
}

// LoginModel collects credentials and runs the login+mint flow.
type LoginModel struct {
	host, port    string
	width, height int

	username, password textInput
	focus              int // 0 = username, 1 = password
	submitting         bool
	errMsg             string
}

// NewLogin builds the login view for a target box.
func NewLogin(host, port string) LoginModel {
	return LoginModel{
		host:     host,
		port:     port,
		username: newTextInput("", false),
		password: newTextInput("", true),
	}
}

func (m LoginModel) loginCmd() tea.Cmd {
	host, port, user, pass := m.host, m.port, m.username.Value(), m.password.Value()
	return func() tea.Msg {
		tok, err := rest.Login(context.Background(), host, port, user, pass)
		return loginResultMsg{token: tok, err: err}
	}
}

// Init is a no-op; the form is idle until the operator types.
func (m LoginModel) Init() tea.Cmd { return nil }

// Update handles field editing, focus, submit, and the login result. On success
// it bubbles authSucceededMsg up to the App.
func (m LoginModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case loginResultMsg:
		m.submitting = false
		if msg.err != nil {
			m.errMsg = friendlyErr(msg.err)
			m.password.SetValue("") // wrong creds: clear the password, keep username
			m.focus = 1
			return m, nil
		}
		return m, func() tea.Msg { return authSucceededMsg{token: msg.token} }
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil
	case tea.KeyMsg:
		if m.submitting {
			return m, nil // ignore input while the request is in flight
		}
		return m.handleKey(msg)
	}
	return m, nil
}

func (m LoginModel) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		return m, func() tea.Msg { return backMsg{} }
	case "tab", "down", "shift+tab", "up":
		m.focus = (m.focus + 1) % 2
		return m, nil
	case "enter":
		// Submit when both fields are filled; otherwise advance to the next.
		if m.username.Value() != "" && m.password.Value() != "" {
			m.submitting, m.errMsg = true, ""
			return m, m.loginCmd()
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

// View renders the login form.
func (m LoginModel) View() string {
	width := m.width
	if width <= 0 {
		width = 72
	}
	var b strings.Builder
	b.WriteString(titleStyle.Width(width).Render("ServiceBay  ·  sign in") + "\n")
	b.WriteString(phaseStyle.Render("Managing the box needs a one-time sign-in.") + "\n")
	b.WriteString(detailStyle.Render("Use your ServiceBay admin login — the same username + password as the web") + "\n")
	b.WriteString(detailStyle.Render("dashboard at http://"+m.host+":"+m.port+". The TUI then creates + saves its own") + "\n")
	b.WriteString(detailStyle.Render("access token for this box, so you won't be asked again.") + "\n\n")

	b.WriteString(m.username.render("Username", m.focus == 0) + "\n")
	b.WriteString(m.password.render("Password", m.focus == 1) + "\n")

	if m.submitting {
		b.WriteString("\n" + detailStyle.Render("Signing in…") + "\n")
	} else if m.errMsg != "" {
		b.WriteString("\n" + detailStyle.Render(cfgErrStyle.Render("✗ "+m.errMsg)) + "\n")
	}
	b.WriteString("\n" + footerStyle.Render("tab switch · enter submit · esc back"))
	return frame(b.String(), m.width, m.height)
}
