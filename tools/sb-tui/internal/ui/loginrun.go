// Standalone sign-in runner for the Express post-boot continuation (#1233).
// The LoginModel is normally an App sub-view: it bubbles authSucceededMsg up to
// the App, which saves the token and opens the requested panel. Express runs
// outside the App (a sequence of standalone programs), so it needs its own tiny
// host that captures the minted token and quits.
package ui

import (
	tea "github.com/charmbracelet/bubbletea"
)

// loginRunner hosts a LoginModel as a root Bubble Tea program, capturing the
// minted token (authSucceededMsg) or a cancel (backMsg) and quitting.
type loginRunner struct {
	login LoginModel
	token string
	ok    bool
}

func (r loginRunner) Init() tea.Cmd { return r.login.Init() }

func (r loginRunner) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case authSucceededMsg:
		r.token, r.ok = msg.token, true
		return r, tea.Quit
	case backMsg:
		return r, tea.Quit // operator hit esc — cancelled, no token
	}
	lm, cmd := r.login.Update(msg)
	r.login = lm.(LoginModel)
	return r, cmd
}

func (r loginRunner) View() string { return r.login.View() }

// RunLogin opens a standalone sign-in for host:port and, on success, persists
// the freshly-minted scoped token via save. Returns true when a token was
// minted, false when the operator cancelled. Used by the Express post-boot
// chain so it can reach the token-gated restore + install panels.
func RunLogin(host, port string, save TokenSaver) (bool, error) {
	final, err := tea.NewProgram(loginRunner{login: NewLogin(host, port)}, tea.WithAltScreen()).Run()
	if err != nil {
		return false, err
	}
	r, ok := final.(loginRunner)
	if !ok || !r.ok || r.token == "" {
		return false, nil
	}
	if save != nil {
		_ = save(host, r.token)
	}
	return true, nil
}
