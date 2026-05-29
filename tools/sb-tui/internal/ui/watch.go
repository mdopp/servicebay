// The Bubble Tea model for the native install-watch dashboard (#1274). It
// polls the box once a second via the watch package and exits when ServiceBay's
// wizard takes over (Takeover=true) or the operator quits. Rendering and the
// poll ladder live in the watch package; this is the thin Bubble Tea shell,
// mirroring how menu.go wraps the phase package.
package ui

import (
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"servicebay-tui/internal/watch"
)

const watchInterval = time.Second

// WatchModel is the Bubble Tea model for the install-watch dashboard.
type WatchModel struct {
	host, port string
	tracker    *watch.Tracker
	last       watch.Probe
	width      int
	now        time.Time
	// Takeover is set when the box's real app replaced the splash; the
	// entrypoint reads it after the program exits to print the handoff banner.
	Takeover bool
}

// NewWatch builds a watch model targeting host:port.
func NewWatch(host, port string) WatchModel {
	now := time.Now()
	return WatchModel{host: host, port: port, tracker: watch.NewTracker(now), width: 80, now: now}
}

type watchTickMsg struct {
	probe    watch.Probe
	takeover bool
	at       time.Time
}

type scheduledPoll struct{}

func (m WatchModel) pollCmd() tea.Cmd {
	host, port := m.host, m.port
	return func() tea.Msg {
		p, takeover := watch.Observe(host, port)
		return watchTickMsg{probe: p, takeover: takeover, at: time.Now()}
	}
}

// Init kicks off the first poll.
func (m WatchModel) Init() tea.Cmd { return m.pollCmd() }

// Update folds in poll results, schedules the next poll, and handles input.
func (m WatchModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case watchTickMsg:
		m.now = msg.at
		m.tracker.Apply(msg.probe, msg.at)
		m.last = msg.probe
		if msg.takeover {
			// Box is up — leave the dashboard. Hosted by App this pops back to
			// the menu (which re-detects → now a manageable box); standalone
			// (`sb-tui watch`) the model's own backMsg case quits and main
			// prints the handoff banner.
			m.Takeover = true
			return m, backCmd()
		}
		return m, tea.Tick(watchInterval, func(time.Time) tea.Msg { return scheduledPoll{} })
	case scheduledPoll:
		return m, m.pollCmd()
	case backMsg:
		return m, tea.Quit // standalone-only; App intercepts when hosted
	case tea.WindowSizeMsg:
		m.width = msg.Width
		return m, nil
	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c":
			return m, tea.Quit
		case "q", "esc":
			return m, backCmd()
		}
	}
	return m, nil
}

// View renders the dashboard.
func (m WatchModel) View() string {
	return watch.Render(m.host, m.port, m.tracker, m.last, m.now, m.width)
}

// Stats returns elapsed time and observed reboots for the handoff banner.
func (m WatchModel) Stats() (time.Duration, int) {
	return m.now.Sub(m.tracker.Start), m.tracker.Reboots
}
