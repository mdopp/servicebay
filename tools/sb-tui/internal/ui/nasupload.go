// The Bubble Tea "upload Home Assistant backup to NAS" panel (#1367). The
// operator points it at a Home Assistant OS (Supervisor) backup; it extracts +
// manifest-filters the config locally (habackup) and uploads the small result
// straight to the FritzBox over FTP (fritz) — bypassing the box's ~10 MB /api
// request-body cap. FritzBox FTP creds are entered once and saved locally.
package ui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"servicebay-tui/internal/fritz"
	"servicebay-tui/internal/habackup"
)

// haServiceTar is the on-NAS name the box's restore flow (#1363) reads back.
const haServiceTar = "sb-backup/home-assistant.tar"

type nasUploadResultMsg struct {
	detail string
	err    error
}

// NasUploadModel collects a Home Assistant backup path + FritzBox FTP creds and
// uploads the extracted config to the NAS.
type NasUploadModel struct {
	width, height int

	path, ftpHost, ftpUser, ftpPass textInput
	focus                           int // 0 path, 1 host, 2 user, 3 password
	submitting                      bool
	status                          string
}

const nasUploadFields = 4

// NewNasUpload builds the panel, pre-filling FritzBox FTP creds from a previous
// upload so the operator only enters them once.
func NewNasUpload() NasUploadModel {
	c := fritz.LoadCreds()
	host := c.Host
	if host == "" {
		host = "192.168.178.1" // FritzBox's default LAN IP — a sensible starting guess
	}
	return NasUploadModel{
		path:    newTextInput("", false),
		ftpHost: newTextInput(host, false),
		ftpUser: newTextInput(c.User, false),
		ftpPass: newTextInput(c.Password, true),
	}
}

// fieldHints explains the focused field, so the operator isn't guessing what
// each one wants (a path? which host? which user?).
var fieldHints = [nasUploadFields]string{
	"Path to a Home Assistant backup .tar — export it in HA → Settings → System → Backups, then point here (e.g. ~/Downloads/ha-backup.tar).",
	"Your FritzBox's LAN IP — usually 192.168.178.1.",
	"A FritzBox user allowed to access storage/NAS (fritz.box → System → FritzBox Users → enable 'Access to NAS contents').",
	"That FritzBox user's password.",
}

func (m NasUploadModel) uploadCmd() tea.Cmd {
	path, host, user, pass := m.path.Value(), m.ftpHost.Value(), m.ftpUser.Value(), m.ftpPass.Value()
	return func() tea.Msg {
		tar, err := habackup.ExtractAndFilter(path, habackup.HomeAssistantIncludes)
		if err != nil {
			return nasUploadResultMsg{err: err}
		}
		if err := fritz.Upload(host, user, pass, haServiceTar, tar); err != nil {
			return nasUploadResultMsg{err: err}
		}
		_ = fritz.SaveCreds(fritz.Creds{Host: host, User: user, Password: pass})
		return nasUploadResultMsg{detail: fmt.Sprintf("home-assistant.tar (%d KB)", (len(tar)+1023)/1024)}
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
		m.status = "✓ uploaded " + msg.detail + " to the NAS"
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
	case "tab", "down":
		m.focus = (m.focus + 1) % nasUploadFields
		return m, nil
	case "up", "shift+tab":
		m.focus = (m.focus - 1 + nasUploadFields) % nasUploadFields
		return m, nil
	case "enter":
		if m.path.Value() != "" && m.ftpHost.Value() != "" && m.ftpUser.Value() != "" && m.ftpPass.Value() != "" {
			m.submitting, m.status = true, ""
			return m, m.uploadCmd()
		}
		m.focus = (m.focus + 1) % nasUploadFields
		return m, nil
	}
	// Everything else (caret movement, backspace/delete, runes) edits the
	// focused field.
	m.focusedField().handleKey(msg)
	return m, nil
}

// focusedField returns a pointer to whichever field has focus, so caret edits
// land on it.
func (m *NasUploadModel) focusedField() *textInput {
	switch m.focus {
	case 0:
		return &m.path
	case 1:
		return &m.ftpHost
	case 2:
		return &m.ftpUser
	default:
		return &m.ftpPass
	}
}

// View renders the form.
func (m NasUploadModel) View() string {
	width := m.width
	if width <= 0 {
		width = 72
	}
	var b strings.Builder
	b.WriteString(titleStyle.Width(width).Render("ServiceBay  ·  upload Home Assistant backup to NAS") + "\n")
	b.WriteString(phaseStyle.Render("Stage a Home Assistant backup on the FritzBox so a fresh install restores it.") + "\n")
	b.WriteString(detailStyle.Render("Backup: a Home Assistant OS (Supervisor) backup .tar from Settings → Backups.") + "\n")
	b.WriteString(detailStyle.Render("It's extracted + filtered locally (config only, no DB) and sent straight to the NAS.") + "\n\n")

	b.WriteString(m.path.render("HA backup .tar", m.focus == 0) + "\n")
	b.WriteString(m.ftpHost.render("FritzBox host", m.focus == 1) + "\n")
	b.WriteString(m.ftpUser.render("FritzBox FTP user", m.focus == 2) + "\n")
	b.WriteString(m.ftpPass.render("FritzBox FTP password", m.focus == 3) + "\n")

	// Contextual help for whichever field is focused — so no field is a guess.
	b.WriteString("\n" + detailStyle.Render("→ "+fieldHints[m.focus]) + "\n")

	if m.submitting {
		b.WriteString("\n" + detailStyle.Render("Extracting + uploading…") + "\n")
	} else if m.status != "" {
		style := cfgOKStyle
		if strings.HasPrefix(m.status, "✗") {
			style = cfgErrStyle
		}
		b.WriteString("\n" + detailStyle.Render(style.Render(m.status)) + "\n")
	}
	b.WriteString("\n" + footerStyle.Render("tab/↑↓ move · type to edit · enter upload · esc back"))
	return frame(b.String(), m.width, m.height)
}
