// Package ui is the Bubble Tea presentation layer for the launcher (#1273,
// porting packages/tui/src/App.tsx). Thin over the phase package: detect the
// phase, render the relevant actions, and report a terminal choice (build /
// watch) back to the entrypoint, which hands off. Quit + Refresh are handled
// here.
package ui

import (
	"context"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"servicebay-tui/internal/phase"
)

// DetectFunc resolves the current phase facts (injected so the model is
// testable without real IO).
type DetectFunc func(context.Context) (isoBuilt bool, status phase.BoxStatus)

type phaseMsg struct{ state phase.State }

// Model is the Bubble Tea model for the launcher menu.
type Model struct {
	detect  DetectFunc
	state   *phase.State
	actions []phase.Action
	cursor  int
	// Chosen is set to a handoff action (build/watch) when the operator picks
	// one; the entrypoint reads it after the program exits.
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

// View renders the menu.
func (m Model) View() string {
	var b strings.Builder
	b.WriteString("ServiceBay — lifecycle launcher\n\n")
	if m.state == nil {
		b.WriteString("Detecting phase…\n")
		return b.String()
	}
	b.WriteString(phase.Describe(*m.state) + "\n\n")
	for i, a := range m.actions {
		marker := "  "
		if i == m.cursor {
			marker = "❯ "
		}
		b.WriteString(marker + a.Label + "\n")
	}
	b.WriteString("\n↑/↓ to move · Enter to select · Ctrl+C to quit\n")
	return b.String()
}
