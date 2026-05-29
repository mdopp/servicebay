// IO for the watch dashboard: the ICMP/TCP/HTTP probes against a booting box.
// Kept apart from the pure logic in watch.go so the dashboard's parsing and
// tracking stay testable without a network. Mirrors the probes in the old
// scripts/install-tui.sh (#1274).
package watch

import (
	"context"
	"io"
	"net"
	"net/http"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const httpTimeout = 3 * time.Second

// Ping reports whether host answers a single ICMP echo within ~1s. It shells
// out to the system `ping` so it needs no raw-socket privileges; the timeout
// flag differs between Linux (-W, seconds) and macOS (-t, seconds). A missing
// or failed ping reads as down.
func Ping(host string) bool {
	var args []string
	switch runtime.GOOS {
	case "darwin":
		args = []string{"-c", "1", "-t", "1", host}
	default:
		args = []string{"-c", "1", "-W", "1", host}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "ping", args...).Run() == nil
}

// TCPOpen reports whether host:port accepts a connection within ~1.5s.
func TCPOpen(host, port string) bool {
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, port), 1500*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func httpGet(url string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), httpTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return string(body), err
}

var titleRe = regexp.MustCompile(`(?is)<title>([^<]*)</title>`)

func fetchRootTitle(host, port string) string {
	body, err := httpGet("http://" + host + ":" + port + "/")
	if err != nil {
		return ""
	}
	m := titleRe.FindStringSubmatch(body)
	if m == nil {
		return ""
	}
	return strings.TrimSpace(m[1])
}

// Observe runs one tick of probes against the box and returns the folded facts
// plus whether ServiceBay has taken over (the caller should then exit). The
// ladder mirrors install-tui.sh: ping first; only check the port when ping is
// up; only fetch the log when a real status line is present; and only sniff
// the root title (for takeover) when the port is open but status isn't a TSV.
func Observe(host, port string) (Probe, bool) {
	p := Probe{ICMP: Ping(host)}
	if p.ICMP {
		p.TCP = TCPOpen(host, port)
	}
	if !p.TCP {
		return p, false
	}
	if raw, err := httpGet("http://" + host + ":" + port + "/status.txt"); err == nil {
		if s, ok := ParseStatus(raw); ok {
			p.Status = &s
			if log, err := httpGet("http://" + host + ":" + port + "/log.txt"); err == nil {
				p.Log = log
			}
			return p, false
		}
	}
	// Port open but no status TSV — maybe the real app replaced the splash.
	return p, IsTakeover(fetchRootTitle(host, port))
}
