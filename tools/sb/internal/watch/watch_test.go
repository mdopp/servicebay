package watch

import (
	"strings"
	"testing"
	"time"
)

func TestParseStatus(t *testing.T) {
	s, ok := ParseStatus("2026-05-29T09:30:00Z\tInstalling NVIDIA\trpm-ostree layering\n")
	if !ok {
		t.Fatal("expected ok for a valid TSV line")
	}
	if s.TimestampISO != "2026-05-29T09:30:00Z" || s.Stage != "Installing NVIDIA" || s.Desc != "rpm-ostree layering" {
		t.Fatalf("bad parse: %+v", s)
	}

	// Stage with no description.
	s, ok = ParseStatus("2026-05-29T09:30:00Z\tBooting")
	if !ok || s.Stage != "Booting" || s.Desc != "" {
		t.Fatalf("two-field parse: %+v ok=%v", s, ok)
	}

	// Non-status content (e.g. ServiceBay served HTML) → not ok.
	if _, ok := ParseStatus("<!doctype html><title>ServiceBay</title>"); ok {
		t.Fatal("expected ok=false for non-TSV content")
	}
	if _, ok := ParseStatus(""); ok {
		t.Fatal("expected ok=false for empty input")
	}
}

func TestFmtDur(t *testing.T) {
	cases := map[time.Duration]string{
		45 * time.Second:                           "45s",
		3*time.Minute + 5*time.Second:              "3m05s",
		time.Hour + 2*time.Minute + 30*time.Second: "1h02m",
		-5 * time.Second:                           "0s",
	}
	for d, want := range cases {
		if got := FmtDur(d); got != want {
			t.Errorf("FmtDur(%v) = %q, want %q", d, got, want)
		}
	}
}

func TestIsTakeover(t *testing.T) {
	if IsTakeover("ServiceBay setup — getting ready") {
		t.Error("splash title must not read as takeover")
	}
	if IsTakeover("") {
		t.Error("empty title must not read as takeover")
	}
	if !IsTakeover("ServiceBay") {
		t.Error("the real app title should read as takeover")
	}
	if !IsTakeover("  ServiceBay Dashboard  ") {
		t.Error("trimmed real-app title should read as takeover")
	}
}

func TestTrackerStageTransitionAndConn(t *testing.T) {
	start := time.Unix(1000, 0)
	tr := NewTracker(start)

	// First status: stage set, stage timer starts, fails reset, connected.
	t1 := start.Add(5 * time.Second)
	st := Status{TimestampISO: "2026-05-29T09:30:00Z", Stage: "A"}
	tr.Apply(Probe{ICMP: true, TCP: true, Status: &st}, t1)
	if tr.Stage != "A" || !tr.StageStart.Equal(t1) {
		t.Fatalf("stage not set: %q start=%v", tr.Stage, tr.StageStart)
	}
	if tr.Conn(Probe{ICMP: true, TCP: true, Status: &st}) != Connected {
		t.Error("want Connected with fresh status + port up")
	}

	// Same stage again later: stage timer must NOT reset.
	t2 := t1.Add(10 * time.Second)
	tr.Apply(Probe{ICMP: true, TCP: true, Status: &st}, t2)
	if !tr.StageStart.Equal(t1) {
		t.Errorf("stage timer reset on unchanged stage: %v", tr.StageStart)
	}

	// New stage: timer resets.
	t3 := t2.Add(3 * time.Second)
	st2 := Status{TimestampISO: "2026-05-29T09:31:00Z", Stage: "B"}
	tr.Apply(Probe{ICMP: true, TCP: true, Status: &st2}, t3)
	if tr.Stage != "B" || !tr.StageStart.Equal(t3) {
		t.Errorf("stage timer did not reset on new stage: %q %v", tr.Stage, tr.StageStart)
	}
}

func TestTrackerRebootEdgeAndFails(t *testing.T) {
	start := time.Unix(2000, 0)
	tr := NewTracker(start)

	// First tick down → no phantom reboot (icmpUp starts false).
	tr.Apply(Probe{ICMP: false}, start.Add(time.Second))
	if tr.Reboots != 0 {
		t.Fatalf("phantom reboot on first tick: %d", tr.Reboots)
	}
	if tr.ConsecutiveFails != 1 {
		t.Fatalf("fails should increment when no status: %d", tr.ConsecutiveFails)
	}

	// Ping comes up.
	tr.Apply(Probe{ICMP: true}, start.Add(2*time.Second))
	// Ping drops → one reboot counted on the down-edge.
	tr.Apply(Probe{ICMP: false}, start.Add(3*time.Second))
	if tr.Reboots != 1 {
		t.Fatalf("reboot down-edge not counted: %d", tr.Reboots)
	}

	// A valid status resets the fail counter.
	st := Status{TimestampISO: "2026-05-29T09:30:00Z", Stage: "A"}
	tr.Apply(Probe{ICMP: true, TCP: true, Status: &st}, start.Add(4*time.Second))
	if tr.ConsecutiveFails != 0 {
		t.Fatalf("fails not reset on valid status: %d", tr.ConsecutiveFails)
	}
}

func TestConnLevels(t *testing.T) {
	tr := NewTracker(time.Unix(0, 0))
	tr.ConsecutiveFails = 2
	if tr.Conn(Probe{ICMP: false, TCP: false}) != Offline {
		t.Error("want Offline when nothing responds")
	}
	if tr.Conn(Probe{ICMP: true, TCP: false}) != Reconnecting {
		t.Error("want Reconnecting when ping up but port/status not ready")
	}
	// Port open is "connected" even with no fresh install status (e.g. the box
	// serving its real app) — connectivity, not splash presence, drives the badge.
	if tr.Conn(Probe{ICMP: true, TCP: true}) != Connected {
		t.Error("want Connected when the port is open regardless of status freshness")
	}
}

func TestRenderContent(t *testing.T) {
	start := time.Unix(5000, 0)
	tr := NewTracker(start)
	now := start.Add(90 * time.Second)
	st := Status{TimestampISO: "2026-05-29T09:30:00Z", Stage: "Layering NVIDIA", Desc: "rpm-ostree"}
	tr.Apply(Probe{ICMP: true, TCP: true, Status: &st}, now)
	out := Render("192.168.178.100", "5888", tr, Probe{ICMP: true, TCP: true, Status: &st, Log: "line one\nline two\n"}, now, 80)

	for _, want := range []string{"192.168.178.100:5888", "Layering NVIDIA", "rpm-ostree", "elapsed 1m30s", "line two", "connected"} {
		if !strings.Contains(out, want) {
			t.Errorf("render missing %q\n---\n%s", want, out)
		}
	}

	// No log yet → placeholder.
	empty := Render("h", "5888", tr, Probe{ICMP: true, TCP: true, Status: &st}, now, 80)
	if !strings.Contains(empty, "no log content yet") {
		t.Errorf("expected empty-log placeholder:\n%s", empty)
	}
}

func TestLastLinesAndTruncate(t *testing.T) {
	got := lastLines("a\nb\nc\nd\n", 2)
	if len(got) != 2 || got[0] != "c" || got[1] != "d" {
		t.Errorf("lastLines tail wrong: %#v", got)
	}
	if truncate("hello", 3) != "hel" {
		t.Errorf("truncate cut wrong: %q", truncate("hello", 3))
	}
	if truncate("hi", 5) != "hi" {
		t.Errorf("truncate should pass short strings: %q", truncate("hi", 5))
	}
	if truncate("x", 0) != "" {
		t.Error("truncate(max<=0) should be empty")
	}
}

func TestRenderUSBBoot(t *testing.T) {
	now := time.Now()
	tr := NewTracker(now)
	will := Render("h", "5888", tr, Probe{ICMP: true, TCP: true, USB: USBWillBoot}, now, 80)
	if !strings.Contains(will, "usb-boot") {
		t.Error("status row should include the usb-boot label")
	}
	if !strings.Contains(will, "armed") || !strings.Contains(will, "reboot the box") {
		t.Error("USBWillBoot should tell the operator it's armed and to reboot")
	}
	notReady := Render("h", "5888", tr, Probe{ICMP: true, TCP: true, USB: USBNotReady}, now, 80)
	if !strings.Contains(notReady, "no USB detected") {
		t.Error("USBNotReady should show the no-USB-detected hint")
	}
}
