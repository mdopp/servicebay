// Package watch is the native install-watch dashboard (#1274), porting
// scripts/install-tui.sh to Go. While a freshly-flashed box is booting and
// installing, a lightweight splash server publishes the current stage and a
// live log tail at /status.txt and /log.txt; this polls them once a second,
// renders a dashboard, and exits when ServiceBay's real wizard takes over (the
// root page title stops being "ServiceBay setup…"). The pure parsing,
// formatting, and cross-tick tracking live here so they're unit-testable; the
// HTTP/ping IO is in io.go and the Bubble Tea model in the ui package.
package watch

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
)

// Status colours for the connection glyphs/badge: green = up, amber =
// reconnecting/transitional, red = down.
var (
	upStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("46"))
	warnStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("214"))
	downStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("196"))
	grayStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("240"))
)

// USBState is the box's USB-boot readiness for the dashboard glyph: would the
// firmware boot from USB on the next reboot? Unknown when we couldn't query the
// box (offline mid-reboot, or no token) → gray dot.
type USBState int

const (
	USBUnknown  USBState = iota // not queried / box offline — gray
	USBNotReady                 // no active USB/removable UEFI entry — red
	USBReady                    // an active USB entry exists (firmware can boot USB) — green
	USBWillBoot                 // BootNext points at USB (will boot USB next) — green
)

// usbGlyph renders the USB-boot dot: green when the box can/will boot from USB,
// red when it can't (no/inactive entry), gray when unknown.
func usbGlyph(s USBState) string {
	switch s {
	case USBReady, USBWillBoot:
		return upStyle.Render("●")
	case USBNotReady:
		return downStyle.Render("●")
	default:
		return grayStyle.Render("○")
	}
}

// Status is one decoded /status.txt line. The splash writes a single
// tab-separated line: an RFC3339 UTC timestamp, the current install stage
// title, and a human description.
type Status struct {
	TimestampISO string
	Stage        string
	Desc         string
}

// statusLine matches the leading `2026-05-29T09:30:00Z` timestamp the splash
// writes; a line without it isn't a status TSV (the splash hasn't written one
// yet, or ServiceBay has taken over and serves something else).
var statusLine = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z`)

// ParseStatus decodes a /status.txt line. ok is false when the line isn't the
// expected `<ts>\t<stage>\t<desc>` TSV.
func ParseStatus(raw string) (Status, bool) {
	line := strings.TrimRight(raw, "\r\n")
	if !statusLine.MatchString(line) {
		return Status{}, false
	}
	parts := strings.SplitN(line, "\t", 3)
	s := Status{TimestampISO: parts[0]}
	if len(parts) > 1 {
		s.Stage = parts[1]
	}
	if len(parts) > 2 {
		s.Desc = parts[2]
	}
	return s, true
}

// FmtDur renders a duration the way the dashboard shows it: "45s", "3m05s",
// "1h02m". Negative inputs clamp to 0.
func FmtDur(d time.Duration) string {
	s := int(d.Seconds())
	if s < 0 {
		s = 0
	}
	switch {
	case s < 60:
		return fmt.Sprintf("%ds", s)
	case s < 3600:
		return fmt.Sprintf("%dm%02ds", s/60, s%60)
	default:
		return fmt.Sprintf("%dh%02dm", s/3600, (s%3600)/60)
	}
}

// IsTakeover reports whether ServiceBay's real app has replaced the splash:
// the root page returns a <title> that isn't the splash's "ServiceBay setup…".
// An empty title means the splash is still up (or nothing is serving yet).
func IsTakeover(rootTitle string) bool {
	t := strings.TrimSpace(rootTitle)
	return t != "" && !strings.HasPrefix(t, "ServiceBay setup")
}

// Probe is one tick's worth of observed facts about the box.
type Probe struct {
	ICMP   bool     // host answers ping
	TCP    bool     // the ServiceBay port accepts a connection
	Status *Status  // decoded /status.txt, nil when unavailable or not-yet-TSV
	Log    string   // /log.txt body (only fetched when Status is present)
	USB    USBState // USB-boot readiness; set by the UI layer (authed query), not Observe
}

// ConnLevel is the connection-badge state derived from a probe.
type ConnLevel int

const (
	// Offline — neither ping nor port responding.
	Offline ConnLevel = iota
	// Reconnecting — host pings but the port/status isn't up yet (e.g. mid-reboot).
	Reconnecting
	// Connected — port open and a fresh status was just read.
	Connected
)

// Tracker accumulates the cross-tick state the dashboard needs: total elapsed,
// observed reboots (ping dropping after being up), the current stage and how
// long we've been in it, and a consecutive-failure counter for the connection
// badge. Apply folds one Probe into it.
type Tracker struct {
	Start            time.Time
	Reboots          int
	Stage            string
	StageStart       time.Time
	ConsecutiveFails int
	icmpUp           bool // previous tick's ping state, for the down-edge
}

// NewTracker starts a tracker at the given clock time.
func NewTracker(now time.Time) *Tracker {
	return &Tracker{Start: now, StageStart: now}
}

// Apply folds one tick's probe into the tracker.
func (t *Tracker) Apply(p Probe, now time.Time) {
	if p.Status != nil {
		if p.Status.Stage != "" && p.Status.Stage != t.Stage {
			t.Stage = p.Status.Stage
			t.StageStart = now
		}
		t.ConsecutiveFails = 0
	} else {
		t.ConsecutiveFails++
	}
	// Count a reboot on the ping down-edge (was up, now down). icmpUp starts
	// false so the first tick never registers a phantom reboot.
	if t.icmpUp && !p.ICMP {
		t.Reboots++
	}
	t.icmpUp = p.ICMP
}

// Conn derives the connection-badge level from raw reachability: an open port is
// "connected", ping-only (port closed, e.g. mid-reboot) is "reconnecting", and
// neither is "offline". It deliberately does NOT key off whether an install
// status is being published — a box serving its real app (no splash status) is
// still connected, not "reconnecting". Status freshness is shown separately by
// the "updated … ago" meta line.
func (t *Tracker) Conn(p Probe) ConnLevel {
	switch {
	case p.TCP:
		return Connected
	case p.ICMP:
		return Reconnecting
	default:
		return Offline
	}
}

func connLabel(l ConnLevel) string {
	switch l {
	case Connected:
		return "connected"
	case Reconnecting:
		return "reconnecting…"
	default:
		return "OFFLINE"
	}
}

// glyph renders a filled/hollow dot for an up/down state: green ● when up, red
// ○ when down.
func glyph(up bool) string {
	if up {
		return upStyle.Render("●")
	}
	return downStyle.Render("○")
}

// badge renders the connection label coloured by level: green connected, amber
// reconnecting, red offline.
func badge(l ConnLevel) string {
	switch l {
	case Connected:
		return upStyle.Render(connLabel(l))
	case Reconnecting:
		return warnStyle.Render(connLabel(l))
	default:
		return downStyle.Render(connLabel(l))
	}
}

// truncate cuts s to at most max runes (no ellipsis), so a long line can't
// wrap and jitter the frame. max <= 0 returns "".
func truncate(s string, max int) string {
	if max <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}

// lastLines returns up to n trailing non-empty-tail lines of s.
func lastLines(s string, n int) []string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines
}

// updatedAgo formats how long ago the status timestamp was, relative to now.
func updatedAgo(iso string, now time.Time) (string, bool) {
	ts, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return "", false
	}
	return FmtDur(now.Sub(ts)), true
}

// Render assembles the full dashboard frame for one tick. Bubble Tea handles
// the alternate-screen buffer and flicker-free diff redraw, so this just
// returns plain text. width is the terminal width (<=0 falls back to 80).
func Render(host, port string, t *Tracker, p Probe, now time.Time, width int) string {
	if width <= 0 {
		width = 80
	}
	var b strings.Builder

	fmt.Fprintf(&b, "ServiceBay install monitor — %s:%s    %s\n", host, port, now.Format("15:04:05"))
	b.WriteString(strings.Repeat("─", width-1) + "\n\n")

	// Stage block.
	switch {
	case p.Status != nil && p.Status.Stage != "":
		fmt.Fprintf(&b, "  Stage    %s\n", p.Status.Stage)
		if p.Status.Desc != "" {
			b.WriteString("           " + truncate(p.Status.Desc, width-13) + "\n")
		}
	case p.TCP:
		b.WriteString("  Stage    (port open, no status yet)\n")
	case p.ICMP:
		b.WriteString("  Stage    (network up, services starting)\n")
	default:
		b.WriteString("  Stage    REBOOTING…\n")
	}
	b.WriteString("\n")

	// Status + meta rows.
	fmt.Fprintf(&b, "  Status   %s ping   %s :%s   %s usb-boot   [%s]\n",
		glyph(p.ICMP), glyph(p.TCP), port, usbGlyph(p.USB), badge(t.Conn(p)))
	switch p.USB {
	case USBNotReady:
		b.WriteString("           " + warnStyle.Render("no USB detected — plug the install USB into THIS server, then press u") + "\n")
	case USBReady:
		b.WriteString("           " + grayStyle.Render("USB detected — press u to arm one-shot USB boot, then reboot the box") + "\n")
	case USBWillBoot:
		b.WriteString("           " + upStyle.Render("✓ USB boot armed — reboot the box now to boot the installer from USB") + "\n")
	}
	meta := "  Meta     elapsed " + FmtDur(now.Sub(t.Start))
	if t.Stage != "" {
		meta += "   |   at stage " + FmtDur(now.Sub(t.StageStart))
	}
	meta += fmt.Sprintf("   |   reboots %d", t.Reboots)
	if p.Status != nil {
		if ago, ok := updatedAgo(p.Status.TimestampISO, now); ok {
			meta += "   |   updated " + ago + " ago"
		}
	}
	b.WriteString(meta + "\n\n")

	// Recent activity heading + log tail.
	heading := "─── Recent install activity "
	if pad := width - 1 - len([]rune(heading)); pad > 0 {
		heading += strings.Repeat("─", pad)
	}
	b.WriteString(heading + "\n\n")
	if strings.TrimSpace(p.Log) != "" {
		for _, ln := range lastLines(p.Log, 18) {
			b.WriteString("  " + truncate(ln, width-4) + "\n")
		}
	} else {
		b.WriteString("  (no log content yet — splash quadlet may still be starting)\n")
	}
	foot := "q quit"
	if p.USB != USBUnknown {
		foot = "u arm USB boot  ·  " + foot
	}
	b.WriteString("\n" + foot + "\n")
	return b.String()
}
