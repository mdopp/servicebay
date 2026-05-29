// The Bubble Tea model for the backup panel (#1277): list the box's system
// backups, trigger a new one, and restore — over the #1275 token client.
// Restore overwrites the box's config/state, so it is gated behind an explicit
// y/n confirmation (the operator has a real data-loss footgun otherwise).
package ui

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"servicebay-tui/internal/rest"
)

var (
	warnStyle  = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("231")).Background(lipgloss.Color("160")).Padding(0, 1)
	backupMeta = lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
)

type backupStage int

const (
	bkLoading backupStage = iota
	bkBrowse
	bkCreating
	bkConfirm
	bkRestoring
)

// BackupModel is the Bubble Tea model for the backup panel.
type BackupModel struct {
	client        *rest.Client
	width, height int

	stage   backupStage
	backups []rest.Backup
	cursor  int

	status string // transient result / error line
	loadEr error  // blocking load error
}

type backupsLoadedMsg struct {
	backups []rest.Backup
	err     error
}
type backupCreatedMsg struct {
	backup *rest.Backup
	err    error
}
type backupRestoredMsg struct {
	fileName string
	err      error
}

// NewBackup builds the backup model against an authenticated client.
func NewBackup(client *rest.Client) BackupModel {
	return BackupModel{client: client, stage: bkLoading}
}

func (m BackupModel) loadCmd() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		b, err := client.ListBackups(context.Background())
		return backupsLoadedMsg{backups: b, err: err}
	}
}

func (m BackupModel) createCmd() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		b, err := client.CreateBackup(context.Background())
		return backupCreatedMsg{backup: b, err: err}
	}
}

func (m BackupModel) restoreCmd(fileName string) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		// Restore can take a while; give it room beyond the default client
		// timeout via a dedicated context.
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		err := client.RestoreBackup(ctx, fileName)
		return backupRestoredMsg{fileName: fileName, err: err}
	}
}

// Init kicks off the backup list load.
func (m BackupModel) Init() tea.Cmd { return m.loadCmd() }

// Update folds in load/create/restore results and handles input.
func (m BackupModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case backupsLoadedMsg:
		if msg.err != nil {
			m.loadEr = msg.err
			return m, nil
		}
		m.loadEr, m.backups, m.stage = nil, msg.backups, bkBrowse
		if m.cursor >= len(m.backups) {
			m.cursor = 0
		}
		return m, nil
	case backupCreatedMsg:
		m.stage = bkBrowse
		if msg.err != nil {
			m.status = "✗ " + friendlyErr(msg.err)
			return m, nil
		}
		m.status = "✓ created " + msg.backup.FileName
		return m, m.loadCmd() // refresh the list to include the new backup
	case backupRestoredMsg:
		m.stage = bkBrowse
		if msg.err != nil {
			m.status = "✗ restore failed: " + friendlyErr(msg.err)
			return m, nil
		}
		m.status = "✓ restored " + msg.fileName
		return m, nil
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil
	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

func (m BackupModel) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if msg.String() == "ctrl+c" {
		return m, tea.Quit
	}
	switch m.stage {
	case bkConfirm:
		return m.handleConfirmKey(msg)
	case bkBrowse:
		return m.handleBrowseKey(msg)
	case bkLoading:
		if m.loadEr != nil {
			switch msg.String() {
			case "q", "esc":
				return m, tea.Quit
			case "r":
				m.loadEr = nil
				return m, m.loadCmd()
			}
		}
	}
	return m, nil
}

func (m BackupModel) handleBrowseKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "esc":
		return m, tea.Quit
	case "up", "k":
		if len(m.backups) > 0 {
			m.cursor = (m.cursor - 1 + len(m.backups)) % len(m.backups)
		}
		m.status = ""
	case "down", "j":
		if len(m.backups) > 0 {
			m.cursor = (m.cursor + 1) % len(m.backups)
		}
		m.status = ""
	case "n":
		m.stage, m.status = bkCreating, ""
		return m, m.createCmd()
	case "r", "enter":
		if len(m.backups) > 0 {
			m.stage, m.status = bkConfirm, ""
		}
	}
	return m, nil
}

func (m BackupModel) handleConfirmKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "y", "Y":
		m.stage = bkRestoring
		return m, m.restoreCmd(m.backups[m.cursor].FileName)
	case "n", "N", "esc":
		m.stage = bkBrowse
	}
	return m, nil
}

// View renders the panel per stage.
func (m BackupModel) View() string {
	width := m.width
	if width <= 0 {
		width = 72
	}
	var b strings.Builder
	b.WriteString(titleStyle.Width(width).Render("ServiceBay  ·  backups") + "\n")

	if m.stage == bkLoading {
		if m.loadEr != nil {
			b.WriteString(phaseStyle.Render(cfgErrStyle.Render("Couldn't load backups:")) + "\n")
			b.WriteString(detailStyle.Render(friendlyErr(m.loadEr)) + "\n")
			b.WriteString(footerStyle.Render("r retry · q quit"))
			return frame(b.String(), m.width, m.height)
		}
		b.WriteString(phaseStyle.Render("Loading backups…"))
		return frame(b.String(), m.width, m.height)
	}
	if m.stage == bkCreating {
		b.WriteString(phaseStyle.Render("Creating backup…"))
		return frame(b.String(), m.width, m.height)
	}
	if m.stage == bkRestoring {
		b.WriteString(phaseStyle.Render("Restoring " + m.backups[m.cursor].FileName + " …"))
		return frame(b.String(), m.width, m.height)
	}

	b.WriteString(phaseStyle.Render("System backups on the box.") + "\n\n")
	if len(m.backups) == 0 {
		b.WriteString(detailStyle.Render(cfgEmptyStyle.Render("(no backups yet)")) + "\n")
	}
	for i, bk := range m.backups {
		meta := backupMeta.Render(fmt.Sprintf("  %s · %s", bk.CreatedAt, humanSize(bk.Size)))
		if i == m.cursor {
			b.WriteString(selectedStyle.Render("❯ "+bk.FileName) + meta + "\n")
		} else {
			b.WriteString(normalStyle.Render("  "+bk.FileName) + meta + "\n")
		}
	}

	if m.stage == bkConfirm {
		bk := m.backups[m.cursor]
		b.WriteString("\n" + warnStyle.Render("⚠  Restore OVERWRITES the box's current config and state.") + "\n")
		b.WriteString(detailStyle.Render("Restore "+bk.FileName+"?  Press y to confirm, n to cancel.") + "\n")
		return frame(b.String(), m.width, m.height)
	}

	if m.status != "" {
		style := cfgOKStyle
		if strings.HasPrefix(m.status, "✗") {
			style = cfgErrStyle
		}
		b.WriteString("\n" + detailStyle.Render(style.Render(m.status)) + "\n")
	}
	b.WriteString("\n" + footerStyle.Render("↑/↓ move · n new backup · r restore · q quit"))
	return frame(b.String(), m.width, m.height)
}

// humanSize renders a byte count as a compact human-readable string.
func humanSize(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}
