// Package ui is the Bubble Tea presentation layer for the launcher (#1273,
// porting packages/tui/src/App.tsx). Thin over the phase package: detect the
// phase, render the relevant actions, and report a terminal choice back to the
// App for routing. The menu auto-refreshes its phase on a timer and shows the
// box URL persistently when reachable. Runs full-screen (alt-screen) so it owns
// the terminal like a real installer.
package ui

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"servicebay-tui/internal/phase"
	"servicebay-tui/internal/rest"
	"servicebay-tui/internal/watch"
)

// DetectFunc resolves the current phase facts (injected so the model is
// testable without real IO).
type DetectFunc func(context.Context) (isoBuilt bool, status phase.BoxStatus)

type phaseMsg struct{ state phase.State }

var (
	titleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("231")).
			Background(lipgloss.Color("63")).
			Padding(0, 1)
	phaseStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("250")).MarginTop(1)
	selectedStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("231")).Background(lipgloss.Color("63"))
	normalStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("252"))
	detailStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("245")).MarginLeft(4).MarginTop(1)
	footerStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("240")).MarginTop(1)
)

// menuRefreshInterval is how often the menu silently re-probes the box so the
// phase + actions track reality (booting → installing → up) without the
// operator pressing anything.
const menuRefreshInterval = 5 * time.Second

// autoRefreshMsg fires on the refresh tick to trigger a background re-probe.
type autoRefreshMsg struct{}

// installStatusMsg carries one lightweight install-status probe (stage + ping +
// port) for the compact live line shown during the Installing phase.
type installStatusMsg struct{ probe watch.Probe }

// currentInstallMsg carries the active stack-install job summary (or nil) from
// the token-gated poll on a reachable box.
type currentInstallMsg struct{ job *rest.CurrentJob }

// Model is the Bubble Tea model for the launcher menu. It is hosted by App
// (app.go): selecting an action emits a menuSelectedMsg the App routes, rather
// than quitting the program itself, so the launcher stays one continuous app.
// It auto-refreshes its phase on a timer (no manual "Refresh" action) and shows
// the box URL persistently when reachable (no separate "Open in browser" item).
type Model struct {
	detect        DetectFunc
	host, port    string
	token         string // scoped token, for polling the running-install summary
	state         *phase.State
	rows          []phase.JourneyRow
	cursor        int
	width, height int
	// installStatus is the latest lightweight probe of a running install, shown
	// as a compact live line while in the Installing phase (the full monitor is
	// one Enter away on the Watch row). Nil outside Installing / before the first
	// probe answers.
	installStatus *watch.Probe
	// installJob is the active stack-install job on an up box (token-polled), so
	// the menu can surface "install in progress" + offer to attach to it.
	installJob *rest.CurrentJob
}

// New builds a launcher model with the phase-detection function and the box
// target (host/port, shown as the dashboard URL when reachable). token (may be
// empty) authenticates the running-install poll.
func New(detect DetectFunc, host, port, token string) Model {
	return Model{detect: detect, host: host, port: port, token: token}
}

func (m Model) detectCmd() tea.Cmd {
	return func() tea.Msg {
		built, status := m.detect(context.Background())
		return phaseMsg{state: phase.Detect(built, status)}
	}
}

func tickCmd() tea.Cmd {
	return tea.Tick(menuRefreshInterval, func(time.Time) tea.Msg { return autoRefreshMsg{} })
}

// installProbeCmd runs one lightweight watch probe (ping/port/status) off the UI
// thread, feeding the compact install-status line. It reuses the watch
// dashboard's Observe so the menu glance and the full monitor agree.
func installProbeCmd(host, port string) tea.Cmd {
	return func() tea.Msg {
		p, _ := watch.Observe(host, port)
		return installStatusMsg{probe: p}
	}
}

// currentInstallCmd polls the box for an active stack-install job (token-gated,
// sanitized). Errors resolve to "no job" — the line just doesn't show.
func (m Model) currentInstallCmd() tea.Cmd {
	host, port, token := m.host, m.port, m.token
	return func() tea.Msg {
		client, err := rest.New(host, port, token)
		if err != nil {
			return currentInstallMsg{}
		}
		job, err := client.CurrentInstall(context.Background())
		if err != nil {
			return currentInstallMsg{}
		}
		return currentInstallMsg{job: job}
	}
}

// rebuildRows recomputes the menu rows from the current phase + any active
// install job: when an install is running it prepends a recommended "Watch the
// running install" row. Resets the cursor only when the row set changes.
func (m *Model) rebuildRows() {
	if m.state == nil {
		return
	}
	rows := phase.Journey(*m.state)
	if m.installJob != nil && m.installJob.Active {
		attach := phase.JourneyRow{
			Action: phase.Action{
				ID:     phase.AttachInstall,
				Label:  "Watch the running install",
				Detail: "Connect to the install already running on the box and see live progress (abort or skip from there).",
			},
			Recommended: true,
		}
		rows = append([]phase.JourneyRow{attach}, rows...)
	}
	if !sameRowIDs(m.rows, rows) || m.cursor >= len(rows) {
		m.cursor = defaultCursor(rows)
	}
	m.rows = rows
}

// Init kicks off the first phase detection.
func (m Model) Init() tea.Cmd { return m.detectCmd() }

// Update handles phase results and key input.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case phaseMsg:
		s := msg.state
		m.state = &s
		m.rebuildRows()
		cmds := []tea.Cmd{tickCmd()}
		// While the initial system install runs (splash), fetch a lightweight
		// ping/port/stage probe for the compact line; clear it otherwise.
		if s.Phase == phase.Installing && m.host != "" {
			cmds = append(cmds, installProbeCmd(m.host, m.port))
		} else {
			m.installStatus = nil
		}
		// On a reachable box with a token, poll for an active stack-install job.
		if s.BoxReachable && m.token != "" {
			cmds = append(cmds, m.currentInstallCmd())
		} else {
			m.installJob = nil
		}
		return m, tea.Batch(cmds...)
	case installStatusMsg:
		p := msg.probe
		m.installStatus = &p
		return m, nil
	case currentInstallMsg:
		m.installJob = msg.job
		m.rebuildRows()
		return m, nil
	case autoRefreshMsg:
		return m, m.detectCmd()
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil
	case tea.KeyMsg:
		if msg.String() == "ctrl+c" {
			return m, tea.Quit
		}
		if m.state == nil || len(m.rows) == 0 {
			return m, nil
		}
		switch msg.String() {
		case "up", "k":
			m.cursor = m.move(-1)
		case "down", "j":
			m.cursor = m.move(1)
		case "r":
			// Optional manual nudge; the menu auto-refreshes anyway.
			return m, m.detectCmd()
		case "enter":
			if !m.rows[m.cursor].Selectable() {
				return m, nil
			}
			a := m.rows[m.cursor].Action
			if a.ID == phase.Quit {
				return m, tea.Quit
			}
			// Hand the choice to the App, which routes it (open a panel, or
			// quit the App so the entrypoint runs a bootstrap leg). AttachInstall
			// carries the active jobId so the App can reattach to it.
			sel := menuSelectedMsg{id: a.ID}
			if a.ID == phase.AttachInstall && m.installJob != nil {
				sel.jobID = m.installJob.ID
			}
			return m, func() tea.Msg { return sel }
		}
	}
	return m, nil
}

// move returns the next selectable row index in the given direction, skipping
// signposts and section headers so the cursor only ever lands on real actions.
func (m Model) move(delta int) int {
	n := len(m.rows)
	if n == 0 {
		return 0
	}
	i := m.cursor
	for k := 0; k < n; k++ {
		i = (i + delta + n) % n
		if m.rows[i].Selectable() {
			return i
		}
	}
	return m.cursor
}

// defaultCursor lands on the phase's recommended step, else the first selectable
// row — never on a signpost.
func defaultCursor(rows []phase.JourneyRow) int {
	for i, r := range rows {
		if r.Selectable() && r.Recommended {
			return i
		}
	}
	for i, r := range rows {
		if r.Selectable() {
			return i
		}
	}
	return 0
}

// sameRowIDs reports whether two journey-row lists have identical action IDs in
// order (used to decide whether a silent refresh may keep the cursor).
func sameRowIDs(a, b []phase.JourneyRow) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Action.ID != b[i].Action.ID {
			return false
		}
	}
	return true
}

// View renders the full-screen menu.
func (m Model) View() string {
	width := m.width
	if width <= 0 {
		width = 72
	}
	title := titleStyle.Width(width).Render("ServiceBay  ·  lifecycle launcher")

	var b strings.Builder
	b.WriteString(title + "\n")
	if m.state == nil {
		b.WriteString(phaseStyle.Render("Detecting box + ISO state…"))
		return frame(b.String(), m.width, m.height)
	}
	b.WriteString(phaseStyle.Render(phase.Describe(*m.state)) + "\n")
	// Show the dashboard URL persistently whenever the box is reachable — no
	// separate "Open in browser" action needed; the URL is always in view.
	if m.state.BoxReachable && m.host != "" {
		b.WriteString(detailStyle.Render("Dashboard: "+cfgValueStyle.Render("http://"+m.host+":"+m.port+"/")) + "\n")
	}
	// Compact live install line while installing — the full monitor (stage +
	// log tail) is one Enter away on the recommended Watch row.
	if m.state.Phase == phase.Installing && m.installStatus != nil {
		b.WriteString(detailStyle.Render(installStatusLine(*m.installStatus, m.port, time.Now())) + "\n")
	}
	// A stack install running on the up box — surface it + offer to attach (the
	// "Watch the running install" row, prepended by rebuildRows).
	if m.installJob != nil && m.installJob.Active {
		b.WriteString(detailStyle.Render(installJobLine(m.installJob)) + "\n")
	}
	b.WriteString("\n")

	for i, r := range m.rows {
		b.WriteString(renderRow(r, i == m.cursor) + "\n")
	}

	if m.cursor < len(m.rows) {
		b.WriteString(detailStyle.Render(m.rows[m.cursor].Action.Detail) + "\n")
	}
	b.WriteString(footerStyle.Render("↑/↓ move · enter select · auto-refreshing · ctrl+c quit  ·  sb-tui " + Version))
	return frame(b.String(), m.width, m.height)
}

// installJobLine renders the "install in progress" glance for a stack install
// running on an up box: the current template and deployed/total count, or a
// paused-for-credentials note.
func installJobLine(j *rest.CurrentJob) string {
	if j.Phase == "needs_credentials" {
		return cfgErrStyle.Render("● install paused") + " — waiting for NPM credentials (attach to skip)"
	}
	item := j.CurrentItem
	if item == "" {
		item = "starting…"
	}
	line := cfgOKStyle.Render("● install in progress") + " — " + item
	if j.Total > 0 {
		line += fmt.Sprintf("  (%d/%d)", j.Deployed, j.Total)
	}
	return line
}

// installStatusLine renders the compact one-line install glance for the menu:
// the current stage, ping/port dots, and how fresh the status is. The full
// monitor (with the log tail) lives in the Watch dashboard.
func installStatusLine(p watch.Probe, port string, now time.Time) string {
	stage := "(starting…)"
	if p.Status != nil && p.Status.Stage != "" {
		stage = p.Status.Stage
	}
	line := fmt.Sprintf("Installing · %s   %s ping  %s :%s", stage, statusDot(p.ICMP), statusDot(p.TCP), port)
	if p.Status != nil {
		if ts, err := time.Parse(time.RFC3339, p.Status.TimestampISO); err == nil {
			line += "   (updated " + watch.FmtDur(now.Sub(ts)) + " ago)"
		}
	}
	return line
}

// statusDot is a green ● when up, a red ○ when down — matching the watch
// dashboard's connection glyphs.
func statusDot(up bool) string {
	if up {
		return cfgOKStyle.Render("●")
	}
	return cfgErrStyle.Render("○")
}

// circledNum maps a journey step number to its glyph for the menu prefix.
var circledNum = map[int]string{1: "①", 2: "②", 3: "③", 4: "④"}

// renderRow draws one journey row: a numbered step (①..④) or an indented helper
// / sub-item. Future steps are greyed, section headers stand out, done steps get
// a ✓, and the focused selectable row is highlighted with the ❯ cursor.
func renderRow(r phase.JourneyRow, selected bool) string {
	prefix := "  " // helper / sub-item indent (aligns under the number column)
	if r.Num >= 1 {
		prefix = circledNum[r.Num] + " "
	}
	if selected {
		body := "❯ " + prefix + r.Action.Label
		if r.Done {
			body += " ✓"
		}
		return selectedStyle.Render(body)
	}
	body := "  " + prefix + r.Action.Label
	switch {
	case r.Ahead:
		return footerStyle.Render(body) // greyed: not reachable yet
	case !r.Selectable():
		s := phaseStyle.Render(body) // section header / done signpost
		if r.Done {
			s += cfgOKStyle.Render(" ✓")
		}
		return s
	default:
		s := normalStyle.Render(body)
		if r.Done {
			s += cfgOKStyle.Render(" ✓")
		}
		return s
	}
}

// frame pins the content to the top-left of the alt-screen so the launcher
// fills the terminal rather than floating mid-scroll.
func frame(content string, width, height int) string {
	if width <= 0 || height <= 0 {
		return content
	}
	return lipgloss.NewStyle().Width(width).Height(height).Render(content)
}
