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

	"sb/internal/buildflow"
	"sb/internal/phase"
	"sb/internal/rest"
)

// Navigation messages routed by the App.
type (
	// menuSelectedMsg is emitted by the menu when the operator picks an action.
	// jobID is set only for AttachInstall (the active install's id to reattach to).
	menuSelectedMsg struct {
		id    phase.ActionID
		jobID string
	}
	// backMsg is emitted by a sub-view to pop back to the menu.
	backMsg struct{}
	// reauthRequiredMsg is emitted by a box-control panel when the box rejects
	// its token (rest.ErrUnauthorized). The App drops the stale credential and
	// re-opens sign-in for the panel that failed, instead of letting the panel
	// dead-end on a terminal "token rejected" message. This is the same
	// destination as the no-token path; the difference is the persisted token is
	// stale (e.g. after a reinstall) rather than absent.
	reauthRequiredMsg struct{}
)

// backCmd emits backMsg. A sub-view uses it on esc/q: when hosted by the App it
// pops to the menu; when run standalone (the `sb config` subcommands) the
// view's own Update catches backMsg and quits, so the same key works in both.
func backCmd() tea.Cmd { return func() tea.Msg { return backMsg{} } }

// reauthCmd emits reauthRequiredMsg. A box-control panel returns it (instead of
// surfacing a terminal error) when the box answers rest.ErrUnauthorized.
func reauthCmd() tea.Cmd { return func() tea.Msg { return reauthRequiredMsg{} } }

// TokenSaver persists a freshly-minted token so future launches skip login.
// Injected so the App is testable without touching the filesystem.
type TokenSaver func(host, token string) error

// TokenDeleter removes the persisted per-host token when the box rejects it, so
// a re-auth replaces the stale file. Injected for the same testability reason.
type TokenDeleter func(host string) error

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
	del           TokenDeleter
	build         BuildConfig
	width, height int

	screen  appScreen
	menu    Model
	active  tea.Model      // login, a panel, or the build form, when screen != appMenu
	pending phase.ActionID // panel to open once authenticated

	// Chosen is set to a handoff leg (express) when the operator picks one;
	// BuildPlan is set when the in-app build form is confirmed. The entrypoint
	// reads both after the App exits.
	Chosen    phase.ActionID
	BuildPlan *buildflow.Plan
}

// NewApp builds the root model. token may be a pre-resolved credential (env or
// the saved per-host file); empty means the box-control views will log in first.
func NewApp(detect DetectFunc, host, port, token string, save TokenSaver, del TokenDeleter, build BuildConfig) App {
	return App{host: host, port: port, token: token, save: save, del: del, build: build, screen: appMenu, menu: New(detect, host, port, token)}
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
		return m.route(msg.id, msg.jobID)

	case authSucceededMsg:
		m.token = msg.token
		if m.save != nil {
			_ = m.save(m.host, msg.token)
		}
		return m.openPanel(m.pending)

	case buildConfirmedMsg:
		// The in-app build form confirmed: stash the plan and quit so the
		// entrypoint runs the bake + flash in the normal terminal (sudo dd
		// needs a real TTY, so it can't run inside the alt-screen app).
		plan := msg.plan
		m.BuildPlan = &plan
		m.Chosen = phase.BuildISO
		return m, tea.Quit

	case openReinstallWatchMsg:
		// USB-boot flow succeeded; the box is rebooting → watch the reinstall.
		m.active = NewWatchReinstall(msg.host, msg.port, m.token)
		m.screen = appPanel
		return m, tea.Batch(m.active.Init(), sizeCmd(m.width, m.height))

	case reauthRequiredMsg:
		// The open panel's call came back 401: the saved token is stale (typically
		// after a reinstall). Drop it (in-memory + the persisted per-host file) and
		// re-open sign-in for the same panel — the no-token path, just reached from
		// a rejected token instead of an absent one. m.pending already names the
		// panel (openPanel set it), so authSucceededMsg resumes into it.
		m.token = ""
		if m.del != nil {
			_ = m.del(m.host)
		}
		m.screen = appLogin
		m.active = NewLogin(m.host, m.port)
		return m, sizeCmd(m.width, m.height)

	case backMsg:
		// Pop back to the menu and re-detect so its phase/actions refresh.
		m.screen, m.active = appMenu, nil
		m.menu = New(m.menu.detect, m.host, m.port, m.token)
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

// route handles a menu selection. Box-control panels open in-app (after login
// if needed); watch + open-box open in-app too (no auth) and return to the
// menu; only the build/express bootstrap legs quit the App for the entrypoint,
// since build is an interactive stdin wizard whose USB flash needs a real TTY.
func (m App) route(id phase.ActionID, jobID string) (tea.Model, tea.Cmd) {
	switch id {
	case phase.AttachInstall:
		// Reattach to the install already running on the box — straight to live
		// progress (the menu only offers this when a token-polled job is active,
		// so a token is present).
		client, err := rest.New(m.host, m.port, m.token)
		if err != nil {
			m.screen, m.active = appMenu, nil
			return m, nil
		}
		m.active = NewInstallAttach(client, jobID)
		m.screen = appPanel
		return m, tea.Batch(m.active.Init(), sizeCmd(m.width, m.height))
	case phase.UploadToNAS:
		// FTP-only: the upload talks straight to the FritzBox NAS, never the
		// ServiceBay box — so it needs no token and no login, and works even
		// before any box exists (the pre-install backup-staging step). When a
		// token IS present, attach a registrar so the upload also tells the box
		// where its backup lives (#1440), making it discoverable by install/
		// restore; without a token that registration happens later from Settings.
		upload := NewNasUpload()
		if client, err := rest.New(m.host, m.port, m.token); err == nil {
			upload = upload.WithRegistrar(client)
		}
		m.active = upload
		m.screen = appPanel
		return m, tea.Batch(m.active.Init(), sizeCmd(m.width, m.height))
	case phase.EditConfig, phase.InstallStacks, phase.Backups, phase.SwitchChannel:
		if m.token == "" {
			m.pending = id
			m.screen = appLogin
			m.active = NewLogin(m.host, m.port)
			return m, sizeCmd(m.width, m.height)
		}
		return m.openPanel(id)
	case phase.WatchInstall:
		m.active = NewWatch(m.host, m.port, m.token)
		m.screen = appPanel
		return m, tea.Batch(m.active.Init(), sizeCmd(m.width, m.height))
	case phase.BuildISO:
		// In-app so esc returns to the menu; on confirm it quits via
		// buildConfirmedMsg and the entrypoint runs the build.
		m.active = NewBuildForm(m.build.Saved, m.build.Deps)
		m.screen = appPanel
		return m, tea.Batch(m.active.Init(), sizeCmd(m.width, m.height))
	case phase.BootFromUSB:
		// Cookie-auth flow (works on the old box); on success it chains into a
		// reinstall watch via openReinstallWatchMsg.
		m.active = NewUSBBoot(m.host, m.port)
		m.screen = appPanel
		return m, sizeCmd(m.width, m.height)
	default:
		// express — hand back to the entrypoint (it runs its own sequence).
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
	// Remember the panel so a mid-panel re-auth (reauthRequiredMsg) re-opens the
	// right one after sign-in.
	m.pending = id
	switch id {
	case phase.EditConfig:
		m.active = NewConfig(client)
	case phase.InstallStacks:
		m.active = NewInstall(client)
	case phase.Backups:
		m.active = NewBackup(client)
	case phase.SwitchChannel:
		m.active = NewChannel(client)
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
