// The Bubble Tea open-box sub-view (#1272 UX): shows the box's dashboard +
// setup URLs and best-effort launches the system browser, then returns to the
// menu on a keypress — instead of the launcher exiting to the shell.
package ui

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// OpenModel renders the box URLs and opens the dashboard in a browser.
type OpenModel struct {
	host, port    string
	width, height int
}

// NewOpen builds the open-box view for a target.
func NewOpen(host, port string) OpenModel { return OpenModel{host: host, port: port} }

func (m OpenModel) dashboard() string { return fmt.Sprintf("http://%s:%s/", m.host, m.port) }
func (m OpenModel) setup() string     { return fmt.Sprintf("http://%s:%s/setup", m.host, m.port) }

// Init best-effort launches the dashboard in the operator's browser.
func (m OpenModel) Init() tea.Cmd { return openBrowserCmd(m.dashboard()) }

// Update returns to the menu on any of esc/q/enter.
func (m OpenModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case backMsg:
		return m, tea.Quit // standalone-only; App intercepts when hosted
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil
	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c":
			return m, tea.Quit
		case "q", "esc", "enter":
			return m, backCmd()
		}
	}
	return m, nil
}

// View renders the URLs.
func (m OpenModel) View() string {
	width := m.width
	if width <= 0 {
		width = 72
	}
	var b strings.Builder
	b.WriteString(titleStyle.Width(width).Render("ServiceBay  ·  open in browser") + "\n")
	b.WriteString(phaseStyle.Render("Opening the dashboard in your browser…") + "\n\n")
	b.WriteString(normalStyle.Render("  Dashboard:    ") + cfgValueStyle.Render(m.dashboard()) + "\n")
	b.WriteString(normalStyle.Render("  Setup wizard: ") + cfgValueStyle.Render(m.setup()) + "\n")
	b.WriteString("\n" + footerStyle.Render("esc back to menu"))
	return frame(b.String(), m.width, m.height)
}

// openBrowserCmd best-effort launches the host's default browser; failures are
// ignored (the URL is shown for the operator to copy).
func openBrowserCmd(url string) tea.Cmd {
	return func() tea.Msg {
		var name string
		var args []string
		switch runtime.GOOS {
		case "darwin":
			name, args = "open", []string{url}
		case "windows":
			name, args = "rundll32", []string{"url.dll,FileProtocolHandler", url}
		default:
			name, args = "xdg-open", []string{url}
		}
		_ = exec.Command(name, args...).Start()
		return nil
	}
}
