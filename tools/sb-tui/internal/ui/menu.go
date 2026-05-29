// Package ui is the Bubble Tea presentation layer for the launcher (#1273,
// porting packages/tui/src/App.tsx). Thin over the phase package: detect the
// phase, render the relevant actions, and report a terminal choice (build /
// watch / open-box) back to the entrypoint, which hands off. Quit + Refresh
// are handled here. Runs full-screen (alt-screen) so it owns the terminal like
// a real installer.
package ui

import (
	"strings"

	"context"

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

// Model is the Bubble Tea model for the launcher menu.
type Model struct {
	detect        DetectFunc
	state         *phase.State
	actions       []phase.Action
	cursor        int
	width, height int
	// Chosen is set to a handoff action (build/watch/open-box) when the operator
	// picks one; the entrypoint reads it after the program exits.
	Chosen phase.ActionID
}

// New builds a launcher model with the given phase-detection function.
func New(detect DetectFunc) Model { return Model{detect: detect} }

func (m Model) detectCmd() tea.Cmd {
	return func() tea.Msg {
		built, status := m.detect(context.Background())
		return phaseMsg{state: phase.Detect(built, status)}
	}
}

// Init kicks off the first phase detection.
func (m Model) Init() tea.Cmd { return m.detectCmd() }

// Update handles phase results and key input.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case phaseMsg:
		s := msg.state
		m.state = &s
		m.actions = phase.ActionsFor(s)
		m.cursor = 0
		return m, nil
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
		case "enter":
			switch a := m.actions[m.cursor]; a.ID {
			case phase.Quit:
				return m, tea.Quit
			case phase.Refresh:
				m.state = nil
				m.actions = nil
				return m, m.detectCmd()
			default:
				m.Chosen = a.ID
				return m, tea.Quit
			}
		}
	}
	return m, nil
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
	b.WriteString(phaseStyle.Render(phase.Describe(*m.state)) + "\n\n")

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
	b.WriteString(footerStyle.Render("↑/↓ move · enter select · ctrl+c quit"))
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
