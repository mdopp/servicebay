// The Bubble Tea NAS-upload panel (#1352): pick a local, already-container-shaped
// service archive + the target service and upload it to the box's NAS via the
// #1351 staging route, so a fresh install pulls it. Reuses the scoped-token rest
// client + the panel patterns.
package ui

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"servicebay-tui/internal/rest"
)

type nasUploadResultMsg struct {
	tarName string
	err     error
}

// NasUploadModel collects a service name + local archive path and uploads it.
type NasUploadModel struct {
	client        *rest.Client
	width, height int

	service, path string
	focus         int // 0 = service, 1 = path
	submitting    bool
	status        string // transient result / error line
}

// NewNasUpload builds the upload panel against an authenticated client.
func NewNasUpload(client *rest.Client) NasUploadModel { return NasUploadModel{client: client} }

func (m NasUploadModel) uploadCmd() tea.Cmd {
	client, service, path := m.client, m.service, m.path
	return func() tea.Msg {
		data, err := os.ReadFile(path)
		if err != nil {
			return nasUploadResultMsg{err: err}
		}
		tar, err := client.UploadServiceBackup(context.Background(), service, filepath.Base(path), data)
		return nasUploadResultMsg{tarName: tar, err: err}
	}
}

// Init is a no-op; idle until the operator types.
func (m NasUploadModel) Init() tea.Cmd { return nil }

// Update handles editing, submit, and the result.
func (m NasUploadModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case nasUploadResultMsg:
		m.submitting = false
		if msg.err != nil {
			m.status = "✗ " + friendlyErr(msg.err)
			return m, nil
		}
		m.status = "✓ staged " + msg.tarName + " on the NAS"
		return m, nil
	case backMsg:
		return m, tea.Quit // standalone-only; App intercepts when hosted
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil
	case tea.KeyMsg:
		if m.submitting {
			return m, nil
		}
		return m.handleKey(msg)
	}
	return m, nil
}

func (m NasUploadModel) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+c":
		return m, tea.Quit
	case "esc":
		return m, backCmd()
	case "tab", "down", "up", "shift+tab":
		m.focus = (m.focus + 1) % 2
	case "enter":
		if m.service != "" && m.path != "" {
			m.submitting, m.status = true, ""
			return m, m.uploadCmd()
		}
		m.focus = (m.focus + 1) % 2
	case "backspace":
		if m.focus == 0 && m.service != "" {
			m.service = m.service[:len(m.service)-1]
		} else if m.focus == 1 && m.path != "" {
			m.path = m.path[:len(m.path)-1]
		}
	default:
		if msg.Type == tea.KeyRunes {
			if m.focus == 0 {
				m.service += string(msg.Runes)
			} else {
				m.path += string(msg.Runes)
			}
		}
	}
	return m, nil
}

// View renders the form.
func (m NasUploadModel) View() string {
	width := m.width
	if width <= 0 {
		width = 72
	}
	var b strings.Builder
	b.WriteString(titleStyle.Width(width).Render("ServiceBay  ·  upload backup to NAS") + "\n")
	b.WriteString(phaseStyle.Render("Stage a service config archive on the NAS for a fresh install to restore.") + "\n")
	b.WriteString(detailStyle.Render("Service must have a backup manifest (e.g. home-assistant, adguard, hermes).") + "\n")
	b.WriteString(detailStyle.Render("Archive: a local .tar of that service's config dir.") + "\n\n")

	b.WriteString(fieldRow("Service", m.service, m.focus == 0, false) + "\n")
	b.WriteString(fieldRow("Archive path", m.path, m.focus == 1, false) + "\n")

	if m.submitting {
		b.WriteString("\n" + detailStyle.Render("Uploading…") + "\n")
	} else if m.status != "" {
		style := cfgOKStyle
		if strings.HasPrefix(m.status, "✗") {
			style = cfgErrStyle
		}
		b.WriteString("\n" + detailStyle.Render(style.Render(m.status)) + "\n")
	}
	b.WriteString("\n" + footerStyle.Render("tab switch · type to edit · enter upload · esc back"))
	return frame(b.String(), m.width, m.height)
}
