// The Bubble Tea model for the Express-setup confirm screen (#1233). Express
// chains the auto-sequenceable pre-boot legs — build + flash the ISO, boot the
// box, then watch the install — behind one preview/confirm screen. The actual
// sequencing happens in the entrypoint (runExpress) because the build leg is an
// interactive stdin wizard, not a Bubble Tea program; this model only renders
// the plan and reports the operator's confirm/cancel choice.
//
// The post-boot restore + stack-install steps are deliberately NOT chained
// here: they need a reachable box and a minted SB_TOKEN that only exist after
// first boot, so they stay as the dedicated panels (#1276/#1277).
package ui

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// ExpressModel renders the Express plan and captures confirm/cancel.
type ExpressModel struct {
	host, port    string
	width, height int
	// Confirmed is set when the operator accepts the plan; the entrypoint reads
	// it after the program exits to decide whether to run the sequence.
	Confirmed bool
}

// NewExpress builds the confirm model. host/port are the resolved target (may
// be empty before any ISO is built — the build leg establishes them).
func NewExpress(host, port string) ExpressModel {
	return ExpressModel{host: host, port: port}
}

// Init is a no-op; the screen is static until a key is pressed.
func (m ExpressModel) Init() tea.Cmd { return nil }

// Update handles confirm/cancel.
func (m ExpressModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil
	case tea.KeyMsg:
		switch msg.String() {
		case "enter":
			m.Confirmed = true
			return m, tea.Quit
		case "q", "esc", "ctrl+c":
			return m, tea.Quit
		}
	}
	return m, nil
}

// View renders the plan + confirm prompt.
func (m ExpressModel) View() string {
	width := m.width
	if width <= 0 {
		width = 72
	}
	var b strings.Builder
	b.WriteString(titleStyle.Width(width).Render("ServiceBay  ·  express setup") + "\n")
	b.WriteString(phaseStyle.Render("Guided happy path. Express will, in order:") + "\n\n")

	steps := []string{
		"Build + flash a ServiceBay install ISO to a USB stick",
		"Pause so you can boot the box from that USB",
		"Watch the install live until the setup wizard takes over",
	}
	for i, s := range steps {
		b.WriteString(normalStyle.Render("  "+stepNum(i+1)+" "+s) + "\n")
	}

	target := "discovered from the ISO build"
	if m.host != "" {
		target = m.host + ":" + m.port
	}
	b.WriteString(detailStyle.Render("Target: "+target) + "\n")
	b.WriteString(detailStyle.Render(cfgEmptyStyle.Render("After first boot, use Edit config / Install stacks / Backups to finish setup.")) + "\n\n")
	b.WriteString(footerStyle.Render("enter start · q cancel"))
	return frame(b.String(), m.width, m.height)
}

func stepNum(n int) string {
	return string(rune('0'+n)) + "."
}
