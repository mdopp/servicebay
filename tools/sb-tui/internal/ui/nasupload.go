// The Bubble Tea "upload Home Assistant backup to NAS" panel (#1367). The
// operator points it at a Home Assistant OS (Supervisor) backup; it extracts +
// manifest-filters the config locally (habackup) and uploads the small result
// straight to the FritzBox over FTP (fritz) — bypassing the box's ~10 MB /api
// request-body cap. FritzBox FTP creds are entered once and saved locally.
package ui

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"servicebay-tui/internal/fritz"
	"servicebay-tui/internal/habackup"
)

// haServiceTar is the on-NAS name the box's restore flow (#1363) reads back.
const haServiceTar = "sb-backup/home-assistant.tar"

// maxCandidatesShown caps the picker list height so a directory full of tars
// can't push the form off-screen; the rest are summarised as "…N more".
const maxCandidatesShown = 8

type nasUploadResultMsg struct {
	detail string
	err    error
}

// candidatesMsg delivers the background backup-file scan to the panel.
type candidatesMsg struct{ list []habackup.Candidate }

// NasUploadModel collects a Home Assistant backup path + FritzBox FTP creds and
// uploads the extracted config to the NAS.
type NasUploadModel struct {
	width, height int

	path, ftpHost, ftpUser, ftpPass textInput
	focus                           int // 0 path, 1 host, 2 user, 3 password
	submitting                      bool
	status                          string

	// Backup-file picker: a background scan of likely dirs for *.tar, filtered
	// live by what's typed in the path field, so the operator picks rather than
	// types an exact path. The path field's text doubles as the filter and the
	// free-text fallback.
	candidates []habackup.Candidate // all discovered, newest-first
	filtered   []habackup.Candidate // those matching the current path filter
	candCursor int
	scanning   bool
}

const nasUploadFields = 4

// NewNasUpload builds the panel, pre-filling FritzBox FTP creds from a previous
// upload so the operator only enters them once, and kicks off the backup scan.
func NewNasUpload() NasUploadModel {
	c := fritz.LoadCreds()
	host := c.Host
	if host == "" {
		host = "192.168.178.1" // FritzBox's default LAN IP — a sensible starting guess
	}
	return NasUploadModel{
		path:     newTextInput("", false),
		ftpHost:  newTextInput(host, false),
		ftpUser:  newTextInput(c.User, false),
		ftpPass:  newTextInput(c.Password, true),
		scanning: true,
	}
}

// scanCmd runs the backup-file discovery off the UI thread.
func scanCmd() tea.Cmd {
	return func() tea.Msg { return candidatesMsg{list: habackup.FindCandidates()} }
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
	path, host, user, pass := expandHome(m.path.Value()), m.ftpHost.Value(), m.ftpUser.Value(), m.ftpPass.Value()
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

// Init kicks off the background backup-file scan that feeds the picker.
func (m NasUploadModel) Init() tea.Cmd { return scanCmd() }

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
	case candidatesMsg:
		m.candidates = msg.list
		m.scanning = false
		m.refilter()
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
	case "tab":
		m.focus = (m.focus + 1) % nasUploadFields
		return m, nil
	case "shift+tab":
		m.focus = (m.focus - 1 + nasUploadFields) % nasUploadFields
		return m, nil
	case "down":
		// On the path field ↑/↓ walk the candidate list; elsewhere they move
		// between fields. tab/shift+tab always move fields, so the picker never
		// traps focus.
		if m.showCandidates() {
			m.candCursor = step(m.candCursor, 1, len(m.filtered))
			return m, nil
		}
		m.focus = (m.focus + 1) % nasUploadFields
		return m, nil
	case "up":
		if m.showCandidates() {
			m.candCursor = step(m.candCursor, -1, len(m.filtered))
			return m, nil
		}
		m.focus = (m.focus - 1 + nasUploadFields) % nasUploadFields
		return m, nil
	case "enter":
		if m.focus == 0 {
			// Choose the highlighted candidate (if the list is open), then submit
			// when every field is filled, else advance to the FTP fields.
			if c, ok := m.selectedCandidate(); ok {
				m.path.SetValue(c.Path)
			}
			if m.allFilled() {
				m.submitting, m.status = true, ""
				return m, m.uploadCmd()
			}
			m.focus = 1
			return m, nil
		}
		if m.allFilled() {
			m.submitting, m.status = true, ""
			return m, m.uploadCmd()
		}
		m.focus = (m.focus + 1) % nasUploadFields
		return m, nil
	}
	// Everything else (caret movement, backspace/delete, runes) edits the focused
	// field; typing in the path field re-filters the candidate list.
	before := m.path.Value()
	m.focusedField().handleKey(msg)
	if m.focus == 0 && m.path.Value() != before {
		m.refilter()
	}
	return m, nil
}

// step moves an index by delta within [0,n), wrapping; returns 0 when n==0.
func step(i, delta, n int) int {
	if n == 0 {
		return 0
	}
	return (i + delta + n) % n
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

// allFilled reports whether every field needed to upload is non-empty.
func (m NasUploadModel) allFilled() bool {
	return m.path.Value() != "" && m.ftpHost.Value() != "" && m.ftpUser.Value() != "" && m.ftpPass.Value() != ""
}

// refilter rebuilds the candidate list from the current path-field text: an
// empty filter shows everything (newest-first), otherwise a case-insensitive
// substring match on the full path. Keeps the cursor in range.
func (m *NasUploadModel) refilter() {
	q := strings.ToLower(strings.TrimSpace(m.path.Value()))
	m.filtered = m.filtered[:0]
	for _, c := range m.candidates {
		if q == "" || strings.Contains(strings.ToLower(c.Path), q) {
			m.filtered = append(m.filtered, c)
		}
	}
	if m.candCursor >= len(m.filtered) {
		m.candCursor = 0
	}
}

// showCandidates reports whether the picker list is live: on the path field,
// scan finished, at least one match, and the typed value isn't already an exact
// existing file (in which case the operator has settled on a concrete path).
func (m NasUploadModel) showCandidates() bool {
	return m.focus == 0 && !m.scanning && len(m.filtered) > 0 && !pathIsFile(m.path.Value())
}

// selectedCandidate returns the highlighted candidate when the list is live.
func (m NasUploadModel) selectedCandidate() (habackup.Candidate, bool) {
	if m.showCandidates() && m.candCursor < len(m.filtered) {
		return m.filtered[m.candCursor], true
	}
	return habackup.Candidate{}, false
}

// pathIsFile reports whether v names an existing regular file.
func pathIsFile(v string) bool {
	v = strings.TrimSpace(v)
	if v == "" {
		return false
	}
	info, err := os.Stat(expandHome(v))
	return err == nil && info.Mode().IsRegular()
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
	// The backup-file picker sits directly under the path field when it's focused.
	if m.focus == 0 {
		b.WriteString(m.pickerView())
	}
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
	footer := "tab/↑↓ move · type to edit · enter upload · esc back"
	if m.showCandidates() {
		footer = "↑/↓ pick · type to filter · enter select · tab next field · esc back"
	}
	b.WriteString("\n" + footerStyle.Render(footer))
	return frame(b.String(), m.width, m.height)
}

// pickerView renders the candidate list (or scan/empty state) shown beneath the
// focused path field.
func (m NasUploadModel) pickerView() string {
	if m.scanning {
		return detailStyle.Render("scanning ~/Downloads, home, USB sticks for backups…") + "\n"
	}
	if pathIsFile(m.path.Value()) {
		return detailStyle.Render(cfgOKStyle.Render("✓ using this file")) + "\n"
	}
	if len(m.filtered) == 0 {
		hint := "no .tar backups found nearby — type a full path"
		if strings.TrimSpace(m.path.Value()) != "" {
			hint = "no backups match — clear the field or type a full path"
		}
		return detailStyle.Render(hint) + "\n"
	}
	var b strings.Builder
	b.WriteString("\n")
	shown := m.filtered
	if len(shown) > maxCandidatesShown {
		shown = shown[:maxCandidatesShown]
	}
	for i, c := range shown {
		b.WriteString(candidateRow(c, i == m.candCursor) + "\n")
	}
	if extra := len(m.filtered) - len(shown); extra > 0 {
		b.WriteString(footerStyle.Render(fmt.Sprintf("   …and %d more — type to narrow", extra)) + "\n")
	}
	return b.String()
}

// candidateRow renders one discovered backup: HA-validated mark, filename,
// directory, size and age, highlighted when it's the cursor row.
func candidateRow(c habackup.Candidate, selected bool) string {
	mark := "·"
	if c.IsHA {
		mark = "✓"
	}
	name := filepath.Base(c.Path)
	meta := fmt.Sprintf("%s · %s · %s", abbrevHome(filepath.Dir(c.Path)), humanSize(c.Size), fmtAge(time.Since(c.Mod)))
	if selected {
		return selectedStyle.Render("❯ " + mark + " " + name + "   " + meta)
	}
	markPart := normalStyle.Render(mark)
	if c.IsHA {
		markPart = cfgOKStyle.Render(mark)
	}
	return normalStyle.Render("  ") + markPart + normalStyle.Render(" "+name) + footerStyle.Inline(true).Render("   "+meta)
}

// expandHome turns a leading ~ into the user's home dir, so a typed
// "~/Downloads/x.tar" resolves like the shell would.
func expandHome(p string) string {
	p = strings.TrimSpace(p)
	home, err := os.UserHomeDir()
	if err != nil {
		return p
	}
	switch {
	case p == "~":
		return home
	case strings.HasPrefix(p, "~/"):
		return filepath.Join(home, p[2:])
	}
	return p
}

// fmtAge renders how long ago a file was modified, compactly: "just now",
// "5m ago", "3h ago", "2d ago".
func fmtAge(d time.Duration) string {
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours())/24)
	}
}

// abbrevHome replaces the home-dir prefix with ~ for compact display.
func abbrevHome(p string) string {
	if home, err := os.UserHomeDir(); err == nil {
		if p == home {
			return "~"
		}
		if strings.HasPrefix(p, home+string(os.PathSeparator)) {
			return "~" + p[len(home):]
		}
	}
	return p
}
