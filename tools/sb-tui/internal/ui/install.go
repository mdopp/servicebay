// The Bubble Tea model for the stack-install panel (#1276): list the box's
// installable stack catalog, let the operator select one or more, and drive a
// server-side install — assemble the manifest, start the job, then poll the
// public progress endpoint and render a live progress bar + log tail. It reuses
// the #1275 token client and follows the edit-config panel's shape.
package ui

import (
	"context"
	"strconv"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"servicebay-tui/internal/rest"
)

const installPollInterval = time.Second

var (
	coreTierStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("220"))
	checkedStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("114"))
	barFillStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("63"))
	barEmptyStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("238"))
	logStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
)

type installStage int

const (
	stageLoading installStage = iota
	stageSelect
	stageStarting
	stageInstalling
	stageDone
	stageError
)

// InstallModel is the Bubble Tea model for the stack-install panel.
type InstallModel struct {
	client        *rest.Client
	width, height int

	stage   installStage
	stacks  []rest.Stack
	checked map[int]bool
	cursor  int

	jobID   string
	offset  int
	phase   string
	percent int
	logTail []string
	failed  bool
	errMsg  string // populated in stageError / failed
}

type stacksLoadedMsg struct {
	stacks []rest.Stack
	err    error
}
type installStartedMsg struct {
	jobID string
	err   error
}
type progressMsg struct {
	p   *rest.Progress
	err error
}
type pollTickMsg struct{}

// NewInstall builds the stack-install model against an authenticated client.
func NewInstall(client *rest.Client) InstallModel {
	return InstallModel{client: client, stage: stageLoading, checked: map[int]bool{}}
}

func (m InstallModel) loadCmd() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		s, err := client.ListStacks(context.Background())
		return stacksLoadedMsg{stacks: s, err: err}
	}
}

// startCmd assembles the manifest for the checked stacks and starts the job —
// two REST calls chained so the panel sees a single started/failed result.
func (m InstallModel) startCmd(names []string) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		manifest, err := client.AssembleManifest(context.Background(), names, nil)
		if err != nil {
			return installStartedMsg{err: err}
		}
		jobID, err := client.StartInstall(context.Background(), manifest)
		return installStartedMsg{jobID: jobID, err: err}
	}
}

func (m InstallModel) pollCmd() tea.Cmd {
	client, jobID, offset := m.client, m.jobID, m.offset
	return func() tea.Msg {
		p, err := client.InstallProgress(context.Background(), jobID, offset)
		return progressMsg{p: p, err: err}
	}
}

// Init kicks off the catalog load.
func (m InstallModel) Init() tea.Cmd { return m.loadCmd() }

// Update folds in load/start/progress results and handles input.
func (m InstallModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case stacksLoadedMsg:
		if msg.err != nil {
			m.stage, m.errMsg = stageError, friendlyErr(msg.err)
			return m, nil
		}
		m.stacks, m.stage = msg.stacks, stageSelect
		return m, nil
	case installStartedMsg:
		if msg.err != nil {
			m.stage, m.errMsg = stageError, friendlyErr(msg.err)
			return m, nil
		}
		m.jobID, m.stage = msg.jobID, stageInstalling
		return m, m.pollCmd()
	case progressMsg:
		return m.applyProgress(msg)
	case pollTickMsg:
		return m, m.pollCmd()
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil
	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

func (m InstallModel) applyProgress(msg progressMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		// A transient poll error shouldn't kill the panel mid-install; surface
		// it and keep polling.
		m.errMsg = friendlyErr(msg.err)
		return m, tea.Tick(installPollInterval, func(time.Time) tea.Msg { return pollTickMsg{} })
	}
	p := msg.p
	m.phase, m.percent, m.offset = p.Phase, p.Percent, p.NextOffset
	if p.NewLogs != "" {
		for _, line := range strings.Split(strings.TrimRight(p.NewLogs, "\n"), "\n") {
			if line != "" {
				m.logTail = append(m.logTail, line)
			}
		}
		if len(m.logTail) > 200 { // bound memory; the view tails the last few
			m.logTail = m.logTail[len(m.logTail)-200:]
		}
	}
	if !p.Active {
		m.stage = stageDone
		if p.Error != "" {
			m.failed, m.errMsg = true, p.Error
		}
		return m, nil
	}
	return m, tea.Tick(installPollInterval, func(time.Time) tea.Msg { return pollTickMsg{} })
}

func (m InstallModel) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+c":
		return m, tea.Quit
	case "q", "esc":
		// Quitting mid-install only detaches the watcher; the server job keeps
		// running. Safe because progress is resumable by jobId.
		if m.stage != stageStarting {
			return m, tea.Quit
		}
	}
	if m.stage != stageSelect {
		return m, nil
	}
	switch msg.String() {
	case "up", "k":
		if len(m.stacks) > 0 {
			m.cursor = (m.cursor - 1 + len(m.stacks)) % len(m.stacks)
		}
	case "down", "j":
		if len(m.stacks) > 0 {
			m.cursor = (m.cursor + 1) % len(m.stacks)
		}
	case " ":
		m.checked[m.cursor] = !m.checked[m.cursor]
	case "enter":
		if names := m.selectedNames(); len(names) > 0 {
			m.stage = stageStarting
			return m, m.startCmd(names)
		}
	}
	return m, nil
}

func (m InstallModel) selectedNames() []string {
	var names []string
	for i, s := range m.stacks {
		if m.checked[i] {
			names = append(names, s.Name)
		}
	}
	return names
}

// View renders the panel per stage.
func (m InstallModel) View() string {
	width := m.width
	if width <= 0 {
		width = 72
	}
	var b strings.Builder
	b.WriteString(titleStyle.Width(width).Render("ServiceBay  ·  install stacks") + "\n")

	switch m.stage {
	case stageLoading:
		b.WriteString(phaseStyle.Render("Loading stack catalog…"))
	case stageError:
		b.WriteString(phaseStyle.Render(cfgErrStyle.Render("Couldn't load stacks:")) + "\n")
		b.WriteString(detailStyle.Render(m.errMsg) + "\n")
		b.WriteString(footerStyle.Render("q quit"))
	case stageSelect:
		m.viewSelect(&b)
	case stageStarting:
		b.WriteString(phaseStyle.Render("Assembling manifest and starting install…"))
	case stageInstalling:
		m.viewInstalling(&b, width)
	case stageDone:
		m.viewDone(&b, width)
	}
	return frame(b.String(), m.width, m.height)
}

func (m InstallModel) viewSelect(b *strings.Builder) {
	b.WriteString(phaseStyle.Render("Select stacks to install, then press Enter.") + "\n\n")
	for i, s := range m.stacks {
		box := "[ ]"
		if m.checked[i] {
			box = checkedStyle.Render("[x]")
		}
		label := s.Name
		if s.Tier == "core" {
			label = coreTierStyle.Render(s.Name + " (core)")
		}
		if s.Installed {
			label += cfgEmptyStyle.Render(" — installed")
		}
		line := "  " + box + " " + label
		if i == m.cursor {
			line = selectedStyle.Render("❯ "+box+" "+s.Name) + tierSuffix(s)
		}
		b.WriteString(line + "\n")
	}
	if m.cursor < len(m.stacks) && m.stacks[m.cursor].Description != "" {
		b.WriteString(detailStyle.Render(m.stacks[m.cursor].Description) + "\n")
	}
	b.WriteString(footerStyle.Render("↑/↓ move · space toggle · enter install · q quit"))
}

// tierSuffix appends the core/installed annotations to the highlighted row
// without double-styling the selected background.
func tierSuffix(s rest.Stack) string {
	var suffix string
	if s.Tier == "core" {
		suffix += " (core)"
	}
	if s.Installed {
		suffix += " — installed"
	}
	return suffix
}

func (m InstallModel) viewInstalling(b *strings.Builder, width int) {
	phase := m.phase
	if phase == "" {
		phase = "starting"
	}
	b.WriteString(phaseStyle.Render("Installing — "+phase) + "\n")
	b.WriteString(detailStyle.Render(progressBar(m.percent, min(width-8, 40))) + "\n\n")
	b.WriteString(logTailView(m.logTail, 10))
	b.WriteString("\n" + footerStyle.Render("q detach (install keeps running on the box)"))
}

func (m InstallModel) viewDone(b *strings.Builder, width int) {
	if m.failed {
		b.WriteString(phaseStyle.Render(cfgErrStyle.Render("Install failed.")) + "\n")
		b.WriteString(detailStyle.Render(m.errMsg) + "\n\n")
	} else {
		b.WriteString(phaseStyle.Render(cfgOKStyle.Render("✓ Install complete.")) + "\n\n")
	}
	b.WriteString(logTailView(m.logTail, 12))
	b.WriteString("\n" + footerStyle.Render("q quit"))
}

// progressBar renders an n-wide [####----] bar for a 0–100 percent.
func progressBar(percent, n int) string {
	if n < 4 {
		n = 4
	}
	if percent < 0 {
		percent = 0
	}
	if percent > 100 {
		percent = 100
	}
	fill := percent * n / 100
	return barFillStyle.Render(strings.Repeat("█", fill)) +
		barEmptyStyle.Render(strings.Repeat("░", n-fill)) +
		"  " + strconv.Itoa(percent) + "%"
}

// logTailView renders the last n log lines.
func logTailView(lines []string, n int) string {
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	var sb strings.Builder
	for _, l := range lines {
		sb.WriteString(logStyle.Render("  "+l) + "\n")
	}
	return sb.String()
}
