// The Bubble Tea model for the stack-install panel (#1276): list the box's
// installable stack catalog, let the operator select one or more, and drive a
// server-side install — assemble the manifest, start the job, then poll the
// public progress endpoint and render a live progress bar + log tail. It reuses
// the #1275 token client and follows the edit-config panel's shape.
package ui

import (
	"context"
	"fmt"
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
	stageConfirm // confirm pending uninstalls before applying
	stageWiping  // running stack uninstalls
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
	checked map[int]bool // desired state: should this stack be installed?
	// installed is the immutable baseline (what's on the box at load time),
	// so the panel can diff desired-vs-current into install/reinstall/uninstall.
	installed map[int]bool
	// reinstall marks installed+checked rows the operator explicitly wants
	// redeployed (otherwise an installed+checked row is left untouched).
	reinstall map[int]bool
	cursor    int

	// Pending plan, computed at apply time and carried through confirm→wipe→install.
	pendingInstall   []string // template names to deploy (install + reinstall)
	pendingUninstall []string // stack names to wipe

	jobID    string
	offset   int
	phase    string
	current  string // item being deployed right now
	deployed int
	total    int
	percent  int
	logTail  []string
	failed   bool
	attached bool   // reattached to a pre-existing job (skip the catalog/select step)
	errMsg   string // populated in stageError / failed
	note     string // transient action note (abort/skip in flight or rejected)
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

// actionResultMsg carries the outcome of an abort / skip-credentials action.
type actionResultMsg struct {
	verb string
	err  error
}

// wipesDoneMsg carries the per-stack uninstall results (one line each).
type wipesDoneMsg struct{ results []string }

// NewInstall builds the stack-install model against an authenticated client.
func NewInstall(client *rest.Client) InstallModel {
	return InstallModel{client: client, stage: stageLoading, checked: map[int]bool{}, installed: map[int]bool{}, reinstall: map[int]bool{}}
}

// NewInstallAttach builds the panel reattached to an already-running job: it
// skips the catalog/select step and goes straight to live progress for jobID.
func NewInstallAttach(client *rest.Client, jobID string) InstallModel {
	return InstallModel{client: client, stage: stageInstalling, jobID: jobID, attached: true, checked: map[int]bool{}, installed: map[int]bool{}, reinstall: map[int]bool{}}
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

// plan diffs desired (checked) against the installed baseline into the
// templates to deploy (new installs + explicit reinstalls, de-duplicated) and
// the stacks to uninstall (installed but now unchecked, excluding atomic-wipe
// which can't be unchecked). Pure — unit-tested.
func (m InstallModel) plan() (install []string, uninstall []string) {
	seen := map[string]bool{}
	for i, s := range m.stacks {
		inst, want := m.installed[i], m.checked[i]
		switch {
		case want && (!inst || m.reinstall[i]):
			tmpls := s.Templates
			if len(tmpls) == 0 {
				tmpls = []string{s.Name} // best-effort if the catalog carries no templates
			}
			for _, t := range tmpls {
				if !seen[t] {
					seen[t] = true
					install = append(install, t)
				}
			}
		case inst && !want && !s.AtomicWipe():
			uninstall = append(uninstall, s.Name)
		}
	}
	return install, uninstall
}

// wipeCmd uninstalls each pending stack sequentially, one result line each.
func (m InstallModel) wipeCmd(names []string) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		res := make([]string, 0, len(names))
		for _, n := range names {
			if err := client.WipeStack(context.Background(), n); err != nil {
				res = append(res, "✗ "+n+": "+friendlyErr(err))
			} else {
				res = append(res, "✓ uninstalled "+n)
			}
		}
		return wipesDoneMsg{results: res}
	}
}

// apply runs the pending plan: uninstalls first (so a teardown can't race a
// redeploy of a shared template), then the install job. Returns the next stage
// + command.
func (m InstallModel) apply() (InstallModel, tea.Cmd) {
	if len(m.pendingUninstall) > 0 {
		m.stage = stageWiping
		return m, m.wipeCmd(m.pendingUninstall)
	}
	if len(m.pendingInstall) > 0 {
		m.stage = stageStarting
		return m, m.startCmd(m.pendingInstall)
	}
	m.note = "No changes to apply."
	m.stage = stageSelect
	return m, nil
}

func (m InstallModel) pollCmd() tea.Cmd {
	client, jobID, offset := m.client, m.jobID, m.offset
	return func() tea.Msg {
		p, err := client.InstallProgress(context.Background(), jobID, offset)
		return progressMsg{p: p, err: err}
	}
}

// Init kicks off the catalog load, or jumps straight to polling when reattached
// to an existing job.
func (m InstallModel) Init() tea.Cmd {
	if m.attached {
		return m.pollCmd()
	}
	return m.loadCmd()
}

// abortCmd stops the running job; skipCredsCmd resolves a needs_credentials
// pause with the generated fallback. Both report via actionResultMsg.
func (m InstallModel) abortCmd() tea.Cmd {
	client, jobID := m.client, m.jobID
	return func() tea.Msg {
		return actionResultMsg{verb: "abort", err: client.AbortInstall(context.Background(), jobID)}
	}
}

func (m InstallModel) skipCredsCmd() tea.Cmd {
	client, jobID := m.client, m.jobID
	return func() tea.Msg {
		return actionResultMsg{verb: "skip", err: client.SkipCredentials(context.Background(), jobID)}
	}
}

// Update folds in load/start/progress results and handles input.
func (m InstallModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case stacksLoadedMsg:
		if msg.err != nil {
			m.stage, m.errMsg = stageError, friendlyErr(msg.err)
			if msg.err == rest.ErrUnauthorized {
				return m, reauthCmd()
			}
			return m, nil
		}
		m.stacks, m.stage = msg.stacks, stageSelect
		// Desired-state baseline: pre-check whatever's already installed so
		// the panel reflects current reality and acts on the delta.
		for i, s := range msg.stacks {
			m.installed[i] = s.Installed
			m.checked[i] = s.Installed
		}
		return m, nil
	case wipesDoneMsg:
		m.logTail = append(m.logTail, msg.results...)
		if len(m.pendingInstall) > 0 {
			m.stage = stageStarting
			return m, m.startCmd(m.pendingInstall)
		}
		m.stage = stageDone // uninstall-only apply
		return m, nil
	case installStartedMsg:
		if msg.err != nil {
			// An install is already running — reattach to it instead of erroring.
			if inProgress, ok := msg.err.(*rest.InstallInProgressError); ok {
				m.jobID, m.stage = inProgress.JobID, stageInstalling
				m.note = "Reattached to an install already running on the box."
				return m, m.pollCmd()
			}
			m.stage, m.errMsg = stageError, friendlyErr(msg.err)
			if msg.err == rest.ErrUnauthorized {
				return m, reauthCmd()
			}
			return m, nil
		}
		m.jobID, m.stage = msg.jobID, stageInstalling
		return m, m.pollCmd()
	case progressMsg:
		return m.applyProgress(msg)
	case actionResultMsg:
		if msg.err != nil {
			m.note = "✗ " + msg.verb + " failed: " + friendlyErr(msg.err)
		} else if msg.verb == "abort" {
			m.note = "Aborting…"
		} else {
			m.note = "Skipped — continuing with generated credentials."
		}
		return m, m.pollCmd() // reflect the new phase on the next poll
	case pollTickMsg:
		return m, m.pollCmd()
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil
	case backMsg:
		return m, tea.Quit // standalone-only; App intercepts when hosted
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
	m.errMsg = "" // a successful poll clears any earlier transient poll error
	p := msg.p
	m.phase, m.percent, m.offset = p.Phase, p.Percent, p.NextOffset
	m.current, m.deployed, m.total = p.CurrentItem, p.Deployed, p.Total
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
	if msg.String() == "ctrl+c" {
		return m, tea.Quit
	}
	// Uninstall-confirmation gate — intercept before the generic q/esc so
	// they cancel back to the list rather than leaving the panel.
	if m.stage == stageConfirm {
		switch msg.String() {
		case "y", "enter":
			return m.apply()
		case "n", "esc", "q":
			m.stage, m.note = stageSelect, "Cancelled — nothing changed."
		}
		return m, nil
	}
	switch msg.String() {
	case "q", "esc":
		// Leaving mid-apply only detaches; the server job keeps running
		// (resumable by jobId). Don't bail mid-wipe/mid-start though.
		if m.stage != stageStarting && m.stage != stageWiping {
			return m, backCmd()
		}
	case "a":
		if m.stage == stageInstalling && m.jobID != "" {
			m.note = "Aborting…"
			return m, m.abortCmd()
		}
	case "s":
		if m.stage == stageInstalling && m.phase == "needs_credentials" && m.jobID != "" {
			m.note = "Skipping credentials…"
			return m, m.skipCredsCmd()
		}
	}
	if m.stage != stageSelect {
		return m, nil
	}
	return m.handleSelectKey(msg)
}

// handleSelectKey drives the desired-state catalog: ↑/↓ move, space toggles
// the desired install state, r marks an installed row for reinstall, enter
// applies the diff.
func (m InstallModel) handleSelectKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
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
		// Toggle desired state. A core (atomic-wipe) stack that's installed
		// can't be unchecked here — teardown is FACTORY-RESET-only.
		s := m.stacks[m.cursor]
		if m.checked[m.cursor] && m.installed[m.cursor] && s.AtomicWipe() {
			m.note = s.Name + " is a core stack — uninstall via Factory Reset, not here."
		} else {
			m.checked[m.cursor] = !m.checked[m.cursor]
			m.note = ""
		}
	case "r":
		// Explicit reinstall, only meaningful for an installed+selected row.
		if m.installed[m.cursor] && m.checked[m.cursor] {
			m.reinstall[m.cursor] = !m.reinstall[m.cursor]
			m.note = ""
		} else {
			m.note = "Reinstall (r) applies to already-installed, selected stacks."
		}
	case "enter":
		install, uninstall := m.plan()
		if len(install) == 0 && len(uninstall) == 0 {
			m.note = "No changes — select to install, deselect to uninstall, or r to reinstall."
			return m, nil
		}
		m.pendingInstall, m.pendingUninstall = install, uninstall
		if len(uninstall) > 0 {
			m.stage = stageConfirm // destructive — confirm first
			return m, nil
		}
		return m.apply()
	}
	return m, nil
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
		b.WriteString(phaseStyle.Render(cfgErrStyle.Render("Install panel error:")) + "\n")
		b.WriteString(detailStyle.Render(m.errMsg) + "\n")
		b.WriteString(footerStyle.Render("q quit"))
	case stageSelect:
		m.viewSelect(&b)
	case stageConfirm:
		m.viewConfirm(&b)
	case stageWiping:
		b.WriteString(phaseStyle.Render("Uninstalling selected stacks…"))
	case stageStarting:
		b.WriteString(phaseStyle.Render("Assembling manifest and starting install…"))
	case stageInstalling:
		m.viewInstalling(&b, width)
	case stageDone:
		m.viewDone(&b, width)
	}
	return frame(b.String(), m.width, m.height)
}

// rowAction maps a row's desired-vs-installed state to a verb + style.
func (m InstallModel) rowAction(i int) (string, lipgloss.Style) {
	inst, want := m.installed[i], m.checked[i]
	switch {
	case want && !inst:
		return "install", checkedStyle
	case want && inst && m.reinstall[i]:
		return "reinstall", coreTierStyle
	case want && inst:
		return "✓ installed", cfgEmptyStyle
	case inst && !want:
		return "UNINSTALL", cfgErrStyle
	default:
		return "", cfgEmptyStyle
	}
}

func (m InstallModel) viewSelect(b *strings.Builder) {
	b.WriteString(phaseStyle.Render("Desired state — what should be installed?") + "\n\n")
	for i, s := range m.stacks {
		box := "[ ]"
		if m.checked[i] {
			box = checkedStyle.Render("[x]")
		}
		name := s.Name
		if s.Tier == "core" {
			name += " (core)"
		}
		action, st := m.rowAction(i)
		suffix := ""
		if action != "" {
			suffix = "  → " + st.Render(action)
		}
		row := box + " " + name
		if i == m.cursor {
			b.WriteString(selectedStyle.Render("❯ "+row) + suffix + "\n")
		} else {
			b.WriteString("  " + row + suffix + "\n")
		}
	}
	if m.cursor < len(m.stacks) && m.stacks[m.cursor].Description != "" {
		b.WriteString("\n" + detailStyle.Render(m.stacks[m.cursor].Description) + "\n")
	}
	if m.note != "" {
		b.WriteString("\n" + detailStyle.Render(m.note) + "\n")
	}
	b.WriteString("\n" + footerStyle.Render("↑/↓ move · space install/uninstall · r reinstall · enter apply · q quit"))
}

// viewConfirm gates destructive uninstalls behind an explicit y/n.
func (m InstallModel) viewConfirm(b *strings.Builder) {
	b.WriteString(phaseStyle.Render(cfgErrStyle.Render("Confirm uninstall — this stops the services and removes the data for:")) + "\n\n")
	for _, n := range m.pendingUninstall {
		b.WriteString(detailStyle.Render("  • "+n) + "\n")
	}
	if len(m.pendingInstall) > 0 {
		b.WriteString("\n" + detailStyle.Render(fmt.Sprintf("Then %d template(s) get (re)installed.", len(m.pendingInstall))) + "\n")
	}
	b.WriteString("\n" + footerStyle.Render("y/enter confirm · n/esc cancel"))
}

func (m InstallModel) viewInstalling(b *strings.Builder, width int) {
	head := "Installing — " + phaseLabel(m.phase)
	if m.current != "" {
		head += ": " + m.current
	}
	if m.total > 0 {
		head += fmt.Sprintf("  (%d/%d)", m.deployed, m.total)
	}
	b.WriteString(phaseStyle.Render(head) + "\n")
	b.WriteString(detailStyle.Render(progressBar(m.percent, min(width-8, 40))) + "\n\n")

	// The box paused on the NPM credentials prompt. Skipping continues with the
	// auto-generated fallback (proxy routes can be set later in the web UI).
	if m.phase == "needs_credentials" {
		b.WriteString(detailStyle.Render(cfgErrStyle.Render("⚠ Waiting for NPM credentials. Press s to skip and continue with generated ones.")) + "\n")
		b.WriteString(detailStyle.Render("(Or set them in the web UI: "+cfgValueStyle.Render(m.client.BaseURL+"/")+")") + "\n\n")
	}

	b.WriteString(logTailView(m.logTail, 10))

	// Error management: a failing progress poll must be visible, not look frozen
	// at 0%. The job keeps running on the box; this just reports the poll state.
	if m.errMsg != "" {
		b.WriteString("\n" + detailStyle.Render(cfgErrStyle.Render("⚠ progress unavailable: "+m.errMsg)) + "\n")
	}
	if m.note != "" {
		b.WriteString("\n" + detailStyle.Render(m.note) + "\n")
	}
	foot := "a abort · q detach (install keeps running)"
	if m.phase == "needs_credentials" {
		foot = "s skip credentials · a abort · q detach"
	}
	b.WriteString("\n" + footerStyle.Render(foot))
}

// phaseLabel maps a raw job phase to a human label for the monitor.
func phaseLabel(phase string) string {
	switch phase {
	case "":
		return "starting…"
	case "running":
		return "running"
	case "needs_credentials":
		return "waiting for configuration"
	case "done", "complete":
		return "done"
	case "failed", "error":
		return "failed"
	default:
		return phase
	}
}

func (m InstallModel) viewDone(b *strings.Builder, width int) {
	switch {
	case m.failed:
		b.WriteString(phaseStyle.Render(cfgErrStyle.Render("Install failed.")) + "\n")
		b.WriteString(detailStyle.Render(m.errMsg) + "\n\n")
	case m.jobID == "":
		// Uninstall-only apply — no install job ran.
		b.WriteString(phaseStyle.Render(cfgOKStyle.Render("✓ Changes applied.")) + "\n\n")
	default:
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
