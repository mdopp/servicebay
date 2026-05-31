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
//
// One optional pre-boot step IS offered up front: staging an existing backup on
// the NAS (step ① of the journey). It's toggled here and, when on, the
// entrypoint runs the FTP-only upload panel before the build — so the fresh
// install restores it. It's FTP-only (no box/token), so it fits the pre-boot
// sequence; off by default since most operators have nothing to migrate.
package ui

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// ExpressModel renders the Express plan and captures confirm/cancel + whether to
// stage a backup first.
type ExpressModel struct {
	host, port    string
	width, height int
	// StageBackup is the optional "stage a backup on the NAS first" toggle; the
	// entrypoint reads it to decide whether to run the upload panel before build.
	StageBackup bool
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

// Update handles the backup toggle and confirm/cancel.
func (m ExpressModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil
	case tea.KeyMsg:
		switch msg.String() {
		case " ", "tab", "up", "down", "left", "right":
			m.StageBackup = !m.StageBackup
			return m, nil
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

	// Optional first step: stage an existing backup on the NAS (toggle).
	box := "[ ]"
	if m.StageBackup {
		box = "[✓]"
	}
	b.WriteString(normalStyle.Render("  "+box+" Stage an existing backup on the NAS first") + "\n")
	b.WriteString(detailStyle.Render("optional — for migrating Home Assistant data; sent to the FritzBox over FTP") + "\n\n")

	var steps []string
	if m.StageBackup {
		steps = append(steps, "Stage your existing backup on the NAS (FritzBox over FTP)")
	}
	steps = append(steps,
		"Build + flash a ServiceBay install ISO to a USB stick",
		"Pause so you can boot the box from that USB",
		"Watch the install live until the setup wizard takes over",
	)
	for i, s := range steps {
		b.WriteString(normalStyle.Render("  "+stepNum(i+1)+" "+s) + "\n")
	}

	target := "discovered from the ISO build"
	if m.host != "" {
		target = m.host + ":" + m.port
	}
	b.WriteString(detailStyle.Render("Target: "+target) + "\n")
	b.WriteString(detailStyle.Render(cfgEmptyStyle.Render("After first boot, use Edit config / Install stacks / Backups to finish setup.")) + "\n\n")
	b.WriteString(footerStyle.Render("space toggle backup · enter start · q cancel"))
	return frame(b.String(), m.width, m.height)
}

func stepNum(n int) string {
	return string(rune('0'+n)) + "."
}
