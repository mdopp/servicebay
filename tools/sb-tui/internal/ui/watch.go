// The Bubble Tea model for the native install-watch dashboard (#1274). It
// polls the box once a second via the watch package and exits when ServiceBay's
// wizard takes over (Takeover=true) or the operator quits. Rendering and the
// poll ladder live in the watch package; this is the thin Bubble Tea shell,
// mirroring how menu.go wraps the phase package.
package ui

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"servicebay-tui/internal/rest"
	"servicebay-tui/internal/watch"
)

const watchInterval = time.Second

// usbInterval throttles the authed USB-boot query — `efibootmgr` runs via an
// agent exec on the box, so we re-check readiness only every few seconds rather
// than on every 1s poll tick.
const usbInterval = 6 * time.Second

// WatchModel is the Bubble Tea model for the install-watch dashboard.
type WatchModel struct {
	host, port string
	token      string // scoped token for the USB-boot query/enable; "" disables it
	tracker    *watch.Tracker
	last       watch.Probe
	width      int
	now        time.Time
	// requireReboot gates takeover on first observing the box go offline — for a
	// REINSTALL, the box is currently up (old install) and we must wait for it to
	// reboot into the installer before "the app is serving" means the new box.
	requireReboot bool
	// live is set once the box is up — the dashboard switches to the "✓ live"
	// landing and stops polling, staying until the operator leaves.
	live bool
	// usb is the last observed USB-boot readiness (gray until first answered).
	usb watch.USBState
	// usbBusy guards against overlapping USB queries; lastUSB throttles them.
	usbBusy bool
	lastUSB time.Time
	// usbMsg is a transient line shown after pressing u to enable USB boot.
	usbMsg string
	// Takeover is set when the box's real app replaced the splash; the
	// entrypoint reads it after the program exits to print the handoff banner.
	Takeover bool
}

// NewWatch builds a watch model targeting host:port (fresh-boot watch — takeover
// counts as soon as the real app serves). token authenticates the USB-boot
// readiness query/enable; pass "" to disable it (the dot then stays gray).
func NewWatch(host, port, token string) WatchModel {
	now := time.Now()
	return WatchModel{host: host, port: port, token: token, tracker: watch.NewTracker(now), width: 80, now: now}
}

// NewWatchReinstall builds a watch that waits for the box to reboot first, so a
// reinstall of an already-up box doesn't instantly report "done" before the
// operator has booted the USB.
func NewWatchReinstall(host, port, token string) WatchModel {
	m := NewWatch(host, port, token)
	m.requireReboot = true
	return m
}

// usbStatusMsg carries a USB-boot readiness query result.
type usbStatusMsg struct{ state watch.USBState }

// usbEnableResultMsg carries the result of pressing u to enable USB boot.
type usbEnableResultMsg struct {
	msg string
	err error
}

// mapUSB folds the rest client's readiness into the dashboard glyph state.
func mapUSB(r rest.USBBootReadiness) watch.USBState {
	switch {
	case !r.Known:
		return watch.USBUnknown
	case r.WillBoot:
		return watch.USBWillBoot
	case r.Ready:
		return watch.USBReady
	default:
		return watch.USBNotReady
	}
}

// usbQueryCmd asks the box whether it would boot from USB. Any error (box
// offline, route missing, efibootmgr failure) resolves to Unknown → gray dot.
func (m WatchModel) usbQueryCmd() tea.Cmd {
	host, port, token := m.host, m.port, m.token
	return func() tea.Msg {
		client, err := rest.New(host, port, token)
		if err != nil {
			return usbStatusMsg{state: watch.USBUnknown}
		}
		r, err := client.USBBootStatus(context.Background())
		if err != nil {
			return usbStatusMsg{state: watch.USBUnknown}
		}
		return usbStatusMsg{state: mapUSB(r)}
	}
}

// usbEnableCmd sets the one-shot BootNext to USB (without rebooting).
func (m WatchModel) usbEnableCmd() tea.Cmd {
	host, port, token := m.host, m.port, m.token
	return func() tea.Msg {
		client, err := rest.New(host, port, token)
		if err != nil {
			return usbEnableResultMsg{err: err}
		}
		msg, err := client.EnableUSBBoot(context.Background())
		return usbEnableResultMsg{msg: msg, err: err}
	}
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
		// Observe is anonymous and leaves USB unset; carry our last queried state.
		msg.probe.USB = m.usb
		m.last = msg.probe
		// In reinstall mode, ignore "takeover" until the box has actually
		// rebooted (≥1 observed reboot) — otherwise the still-running old install
		// would be mistaken for the finished new one before the USB even boots.
		if msg.takeover && (!m.requireReboot || m.tracker.Reboots >= 1) {
			// Box is up — stop polling and show a "live" screen. The operator
			// stays here until they press q/esc (then App pops to the menu, or a
			// standalone watch quits). It no longer auto-exits to the shell.
			m.Takeover = true
			m.live = true
			return m, nil
		}
		cmds := []tea.Cmd{tea.Tick(watchInterval, func(time.Time) tea.Msg { return scheduledPoll{} })}
		// While the box is reachable, re-check USB-boot readiness on a throttle
		// (only it can answer efibootmgr, and only when the port is open).
		if m.token != "" && msg.probe.TCP && !m.usbBusy && msg.at.Sub(m.lastUSB) >= usbInterval {
			m.usbBusy, m.lastUSB = true, msg.at
			cmds = append(cmds, m.usbQueryCmd())
		}
		return m, tea.Batch(cmds...)
	case usbStatusMsg:
		m.usb = msg.state
		m.last.USB = msg.state
		m.usbBusy = false
		return m, nil
	case usbEnableResultMsg:
		if msg.err != nil {
			m.usbMsg = cfgErrStyle.Render("✗ USB enable failed: " + friendlyErr(msg.err))
			return m, nil
		}
		m.usbMsg = cfgOKStyle.Render("✓ " + msg.msg)
		m.lastUSB = time.Time{} // force a refresh on the next tick
		return m, m.usbQueryCmd()
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
		case "u":
			// Enable one-shot USB boot (no reboot) when the box can answer.
			if m.token != "" && m.last.TCP && !m.live {
				m.usbMsg = detailStyle.Render("Setting USB boot…")
				return m, m.usbEnableCmd()
			}
		}
	}
	return m, nil
}

// View renders the live dashboard, or the "✓ live" landing once the box is up.
func (m WatchModel) View() string {
	if m.live {
		return frame(liveView(m.host, m.port, m.tracker), m.width, 0)
	}
	out := watch.Render(m.host, m.port, m.tracker, m.last, m.now, m.width)
	if m.usbMsg != "" {
		out += "  " + m.usbMsg + "\n"
	}
	return out
}

// liveView is the post-takeover landing: the box is up, the install is done,
// and the operator decides when to leave.
func liveView(host, port string, t *watch.Tracker) string {
	var b strings.Builder
	b.WriteString(titleStyle.Render("ServiceBay  ·  install complete") + "\n\n")
	b.WriteString(cfgOKStyle.Render("  ✓ ServiceBay is live") + "\n\n")
	b.WriteString(normalStyle.Render("  Dashboard:    ") + cfgValueStyle.Render("http://"+host+":"+port+"/") + "\n")
	b.WriteString(normalStyle.Render("  Setup wizard: ") + cfgValueStyle.Render("http://"+host+":"+port+"/setup") + "\n\n")
	b.WriteString(detailStyle.Render(fmt.Sprintf("Observed %d reboot(s).", t.Reboots)) + "\n")
	b.WriteString("\n" + footerStyle.Render("q/esc — back to menu"))
	return b.String()
}

// Stats returns elapsed time and observed reboots for the handoff banner.
func (m WatchModel) Stats() (time.Duration, int) {
	return m.now.Sub(m.tracker.Start), m.tracker.Reboots
}
