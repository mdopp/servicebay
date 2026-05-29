// The Bubble Tea model for the edit-config panel (#1275): the first box-control
// panel and the template the others (stack-install #1276, backup #1277) follow.
// It reads the box's allow-listed config via the authenticated rest client,
// lets the operator edit a field in place, and writes a minimal partial back.
// All HTTP + auth + error surfacing lives in internal/rest; this is the thin
// Bubble Tea shell, mirroring how watch.go wraps the watch package.
package ui

import (
	"context"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"servicebay-tui/internal/rest"
)

var (
	cfgValueStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("114"))
	cfgEmptyStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("240")).Italic(true)
	cfgEditingStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("231")).Background(lipgloss.Color("63"))
	cfgErrStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("203"))
	cfgOKStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("114"))
)

// ConfigModel is the Bubble Tea model for the edit-config panel.
type ConfigModel struct {
	client        *rest.Client
	fields        []rest.EditableField
	values        map[string]string
	cursor        int
	width, height int

	loading bool
	editing bool
	buf     string // edit buffer for the field being edited

	status string // transient status / error line
	loadEr error  // a load/auth error that blocks the whole panel
}

// configLoadedMsg carries the result of the initial (or refreshed) GET.
type configLoadedMsg struct {
	cfg *rest.Config
	err error
}

// configSavedMsg carries the result of a POST for one field.
type configSavedMsg struct {
	key, value string
	err        error
}

// NewConfig builds the edit-config model against an authenticated client.
func NewConfig(client *rest.Client) ConfigModel {
	return ConfigModel{
		client:  client,
		fields:  rest.EditableFields,
		values:  map[string]string{},
		loading: true,
	}
}

func (m ConfigModel) loadCmd() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		cfg, err := client.GetConfig(context.Background())
		return configLoadedMsg{cfg: cfg, err: err}
	}
}

func (m ConfigModel) saveCmd(key, value string) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		err := client.UpdateConfig(context.Background(), key, value)
		return configSavedMsg{key: key, value: value, err: err}
	}
}

// Init kicks off the first config load.
func (m ConfigModel) Init() tea.Cmd { return m.loadCmd() }

// Update folds in load/save results and handles input.
func (m ConfigModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case configLoadedMsg:
		m.loading = false
		if msg.err != nil {
			m.loadEr = msg.err
			return m, nil
		}
		m.loadEr = nil
		m.values = msg.cfg.Values
		return m, nil
	case configSavedMsg:
		m.editing = false
		if msg.err != nil {
			m.status = "✗ " + friendlyErr(msg.err)
			return m, nil
		}
		m.values[msg.key] = msg.value
		m.status = "✓ saved " + msg.key
		return m, nil
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil
	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

func (m ConfigModel) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if msg.String() == "ctrl+c" {
		return m, tea.Quit
	}
	if m.editing {
		return m.handleEditKey(msg)
	}
	// A blocking load error leaves only quit/refresh meaningful.
	if m.loadEr != nil {
		switch msg.String() {
		case "q", "esc":
			return m, tea.Quit
		case "r":
			m.loading, m.loadEr = true, nil
			return m, m.loadCmd()
		}
		return m, nil
	}
	if m.loading || len(m.fields) == 0 {
		return m, nil
	}
	switch msg.String() {
	case "q", "esc":
		return m, tea.Quit
	case "up", "k":
		m.cursor = (m.cursor - 1 + len(m.fields)) % len(m.fields)
		m.status = ""
	case "down", "j":
		m.cursor = (m.cursor + 1) % len(m.fields)
		m.status = ""
	case "r":
		m.loading, m.status = true, ""
		return m, m.loadCmd()
	case "enter":
		m.editing = true
		m.buf = m.values[m.fields[m.cursor].Key]
		m.status = ""
	}
	return m, nil
}

// handleEditKey drives the in-place editor. Enum fields (logLevel) cycle
// through their allowed values with ←/→; free-text fields take typed runes.
func (m ConfigModel) handleEditKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	f := m.fields[m.cursor]
	switch msg.String() {
	case "esc":
		m.editing = false
		m.status = ""
		return m, nil
	case "enter":
		return m, m.saveCmd(f.Key, strings.TrimSpace(m.buf))
	case "left", "right":
		if len(f.Allowed) > 0 {
			m.buf = cycle(f.Allowed, m.buf, msg.String() == "right")
		}
		return m, nil
	case "backspace":
		if len(f.Allowed) == 0 && m.buf != "" {
			m.buf = m.buf[:len(m.buf)-1]
		}
		return m, nil
	default:
		// Free-text fields take printable runes; enum fields ignore typing.
		if len(f.Allowed) == 0 && msg.Type == tea.KeyRunes {
			m.buf += string(msg.Runes)
		}
		return m, nil
	}
}

// cycle returns the value before/after cur in vals (wrapping). An unknown cur
// starts at the first value.
func cycle(vals []string, cur string, forward bool) string {
	idx := 0
	for i, v := range vals {
		if v == cur {
			idx = i
			break
		}
	}
	if forward {
		idx = (idx + 1) % len(vals)
	} else {
		idx = (idx - 1 + len(vals)) % len(vals)
	}
	return vals[idx]
}

// friendlyErr maps the rest client's typed errors to a one-line operator hint.
func friendlyErr(err error) string {
	switch {
	case err == rest.ErrUnauthorized:
		return "token rejected — mint one with the `mutate` scope (Settings → API tokens) and set SB_TOKEN."
	case err == rest.ErrNoToken:
		return rest.ErrNoToken.Error()
	default:
		return err.Error()
	}
}

// View renders the panel.
func (m ConfigModel) View() string {
	width := m.width
	if width <= 0 {
		width = 72
	}
	var b strings.Builder
	b.WriteString(titleStyle.Width(width).Render("ServiceBay  ·  edit config") + "\n")

	if m.loading {
		b.WriteString(phaseStyle.Render("Loading config…"))
		return frame(b.String(), m.width, m.height)
	}
	if m.loadEr != nil {
		b.WriteString(phaseStyle.Render(cfgErrStyle.Render("Couldn't load config:")) + "\n")
		b.WriteString(detailStyle.Render(friendlyErr(m.loadEr)) + "\n")
		b.WriteString(footerStyle.Render("r retry · q quit"))
		return frame(b.String(), m.width, m.height)
	}

	b.WriteString(phaseStyle.Render("Edit allow-listed config. Secrets are managed in the web UI.") + "\n\n")
	for i, f := range m.fields {
		val := m.values[f.Key]
		var rendered string
		switch {
		case m.editing && i == m.cursor:
			rendered = cfgEditingStyle.Render(f.Label + ": " + m.buf + "▌")
		case i == m.cursor:
			rendered = selectedStyle.Render("❯ " + f.Label + ": " + valueText(val))
		default:
			rendered = normalStyle.Render("  " + f.Label + ": " + valueText(val))
		}
		b.WriteString(rendered + "\n")
	}

	if m.status != "" {
		style := cfgOKStyle
		if strings.HasPrefix(m.status, "✗") {
			style = cfgErrStyle
		}
		b.WriteString("\n" + detailStyle.Render(style.Render(m.status)) + "\n")
	}

	b.WriteString("\n")
	if m.editing {
		if len(m.fields[m.cursor].Allowed) > 0 {
			b.WriteString(footerStyle.Render("←/→ choose · enter save · esc cancel"))
		} else {
			b.WriteString(footerStyle.Render("type to edit · enter save · esc cancel"))
		}
	} else {
		b.WriteString(footerStyle.Render("↑/↓ move · enter edit · r refresh · q quit"))
	}
	return frame(b.String(), m.width, m.height)
}

// valueText renders a config value, marking the empty string as unset rather
// than showing a blank.
func valueText(v string) string {
	if v == "" {
		return cfgEmptyStyle.Render("(unset)")
	}
	return cfgValueStyle.Render(v)
}
