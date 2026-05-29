// The root Bubble Tea model that makes the launcher one continuous app instead
// of a set of programs that exit between steps (#1272 UX). It hosts the phase
// menu as home and pushes sub-views — login, edit-config, install, backups —
// that return to the menu on `esc`/`q` rather than quitting the process. The
// box-control sub-views require auth; the App routes through the login view
// (which mints + persists a token) the first time, then reuses it.
//
// The build / express / watch / open-box legs are NOT hosted here: build is an
// interactive stdin wizard (and its USB flash needs a real TTY), and the others
// are natural one-shot handoffs. Selecting one sets Chosen and quits the App so
// the entrypoint runs it.
package ui

import (
	tea "github.com/charmbracelet/bubbletea"

	"servicebay-tui/internal/phase"
	"servicebay-tui/internal/rest"
)

// Navigation messages routed by the App.
type (
	// menuSelectedMsg is emitted by the menu when the operator picks an action.
	menuSelectedMsg struct{ id phase.ActionID }
	// backMsg is emitted by a sub-view to pop back to the menu.
	backMsg struct{}
)

// backCmd emits backMsg. A sub-view uses it on esc/q: when hosted by the App it
// pops to the menu; when run standalone (the `sb-tui config` subcommands) the
// view's own Update catches backMsg and quits, so the same key works in both.
func backCmd() tea.Cmd { return func() tea.Msg { return backMsg{} } }

// TokenSaver persists a freshly-minted token so future launches skip login.
// Injected so the App is testable without touching the filesystem.
type TokenSaver func(host, token string) error

type appScreen int

const (
	appMenu appScreen = iota
	appLogin
	appPanel
)

// App is the root model.
type App struct {
	host, port    string
	token         string // current credential, "" until logged in
	save          TokenSaver
	width, height int

	screen  appScreen
	menu    Model
	active  tea.Model      // login or a panel, when screen != appMenu
	pending phase.ActionID // panel to open once authenticated

	// Chosen is set to a handoff leg (build/express/watch/open-box) when the
	// operator picks one; the entrypoint reads it after the App exits.
	Chosen phase.ActionID
}

// NewApp builds the root model. token may be a pre-resolved credential (env or
// the saved per-host file); empty means the box-control views will log in first.
func NewApp(detect DetectFunc, host, port, token string, save TokenSaver) App {
	return App{host: host, port: port, token: token, save: save, screen: appMenu, menu: New(detect)}
}

// Init starts the menu's phase detection.
func (m App) Init() tea.Cmd { return m.menu.Init() }

// Update routes navigation and delegates everything else to the active view.
func (m App) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		// Size every view so a resize before first render is respected.
		m.width, m.height = msg.Width, msg.Height
		mm, _ := m.menu.Update(msg)
		m.menu = mm.(Model)
		if m.active != nil {
			m.active, _ = m.active.Update(msg)
		}
		return m, nil

	case menuSelectedMsg:
		return m.route(msg.id)

	case authSucceededMsg:
		m.token = msg.token
		if m.save != nil {
			_ = m.save(m.host, msg.token)
		}
		return m.openPanel(m.pending)

	case backMsg:
		// Pop back to the menu and re-detect so its phase/actions refresh.
		m.screen, m.active = appMenu, nil
		fresh := New(m.menu.detect)
		m.menu = fresh
		return m, m.menu.Init()
	}

	// Delegate to the active view, or the menu when home.
	if m.screen == appMenu {
		mm, cmd := m.menu.Update(msg)
		m.menu = mm.(Model)
		return m, cmd
	}
	var cmd tea.Cmd
	m.active, cmd = m.active.Update(msg)
	return m, cmd
}

// route handles a menu selection: box-control views open in-app (after login if
// needed); bootstrap/watch legs quit the App for the entrypoint to run.
func (m App) route(id phase.ActionID) (tea.Model, tea.Cmd) {
	switch id {
	case phase.EditConfig, phase.InstallStacks, phase.Backups:
		if m.token == "" {
			m.pending = id
			m.screen = appLogin
			login := NewLogin(m.host, m.port)
			m.active = login
			return m, sizeCmd(m.width, m.height)
		}
		return m.openPanel(id)
	default:
		// build / express / watch / open-box — hand back to the entrypoint.
		m.Chosen = id
		return m, tea.Quit
	}
}

// openPanel switches to a box-control panel with an authenticated client.
func (m App) openPanel(id phase.ActionID) (tea.Model, tea.Cmd) {
	client, err := rest.New(m.host, m.port, m.token)
	if err != nil {
		// Shouldn't happen (token is set here), but fail safe to the menu.
		m.screen, m.active = appMenu, nil
		return m, nil
	}
	switch id {
	case phase.EditConfig:
		m.active = NewConfig(client)
	case phase.InstallStacks:
		m.active = NewInstall(client)
	case phase.Backups:
		m.active = NewBackup(client)
	default:
		m.screen, m.active = appMenu, nil
		return m, nil
	}
	m.screen = appPanel
	return m, tea.Batch(m.active.Init(), sizeCmd(m.width, m.height))
}

// View renders the active view.
func (m App) View() string {
	if m.screen == appMenu || m.active == nil {
		return m.menu.View()
	}
	return m.active.View()
}

// sizeCmd re-emits the known terminal size so a freshly-opened sub-view lays
// out immediately instead of waiting for the next resize.
func sizeCmd(w, h int) tea.Cmd {
	if w == 0 && h == 0 {
		return nil
	}
	return func() tea.Msg { return tea.WindowSizeMsg{Width: w, Height: h} }
}
