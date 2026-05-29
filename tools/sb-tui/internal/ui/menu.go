// Package ui is the Bubble Tea presentation layer for the launcher (#1273,
// porting packages/tui/src/App.tsx). Thin over the phase package: detect the
// phase, render the relevant actions, and report a terminal choice back to the
// App for routing. The menu auto-refreshes its phase on a timer and shows the
// box URL persistently when reachable. Runs full-screen (alt-screen) so it owns
// the terminal like a real installer.
package ui

import (
	"context"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"servicebay-tui/internal/phase"
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

// Model is the Bubble Tea model for the launcher menu. It is hosted by App
// (app.go): selecting an action emits a menuSelectedMsg the App routes, rather
// than quitting the program itself, so the launcher stays one continuous app.
// It auto-refreshes its phase on a timer (no manual "Refresh" action) and shows
// the box URL persistently when reachable (no separate "Open in browser" item).
type Model struct {
	detect        DetectFunc
	host, port    string
	state         *phase.State
	actions       []phase.Action
	cursor        int
	width, height int
}

// New builds a launcher model with the phase-detection function and the box
// target (host/port, shown as the dashboard URL when reachable).
func New(detect DetectFunc, host, port string) Model {
	return Model{detect: detect, host: host, port: port}
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

// Init kicks off the first phase detection.
func (m Model) Init() tea.Cmd { return m.detectCmd() }

// Update handles phase results and key input.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case phaseMsg:
		s := msg.state
		next := phase.ActionsFor(s)
		// Preserve the cursor across silent auto-refreshes when the action set
		// is unchanged, so a periodic re-probe doesn't yank the selection back
		// to the top while the operator is navigating.
		if !sameActionIDs(m.actions, next) {
			m.cursor = 0
		} else if m.cursor >= len(next) {
			m.cursor = 0
		}
		m.state = &s
		m.actions = next
		return m, tickCmd()
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
		if m.state == nil || len(m.actions) == 0 {
			return m, nil
		}
		switch msg.String() {
		case "up", "k":
			m.cursor = (m.cursor - 1 + len(m.actions)) % len(m.actions)
		case "down", "j":
			m.cursor = (m.cursor + 1) % len(m.actions)
		case "r":
			// Optional manual nudge; the menu auto-refreshes anyway.
			return m, m.detectCmd()
		case "enter":
			a := m.actions[m.cursor]
			if a.ID == phase.Quit {
				return m, tea.Quit
			}
			// Hand the choice to the App, which routes it (open a panel, or
			// quit the App so the entrypoint runs a bootstrap leg).
			id := a.ID
			return m, func() tea.Msg { return menuSelectedMsg{id: id} }
		}
	}
	return m, nil
}

// sameActionIDs reports whether two action lists have identical IDs in order.
func sameActionIDs(a, b []phase.Action) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].ID != b[i].ID {
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
	b.WriteString("\n")

	for i, a := range m.actions {
		if i == m.cursor {
			b.WriteString(selectedStyle.Render("❯ "+a.Label) + "\n")
		} else {
			b.WriteString(normalStyle.Render("  "+a.Label) + "\n")
		}
	}

	if m.cursor < len(m.actions) {
		b.WriteString(detailStyle.Render(m.actions[m.cursor].Detail) + "\n")
	}
	b.WriteString(footerStyle.Render("↑/↓ move · enter select · auto-refreshing · ctrl+c quit"))
	return frame(b.String(), m.width, m.height)
}

// frame pins the content to the top-left of the alt-screen so the launcher
// fills the terminal rather than floating mid-scroll.
func frame(content string, width, height int) string {
	if width <= 0 || height <= 0 {
		return content
	}
	return lipgloss.NewStyle().Width(width).Height(height).Render(content)
}
