package ui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"servicebay-tui/internal/rest"
)

func TestInstallSelectThenStart(t *testing.T) {
	m := NewInstall(&rest.Client{})
	mi, _ := m.Update(stacksLoadedMsg{stacks: []rest.Stack{
		{Name: "immich", Tier: "core"},
		{Name: "vaultwarden", Tier: "feature"},
	}})
	m = mi.(InstallModel)
	if m.stage != stageSelect {
		t.Fatalf("stage = %v, want select", m.stage)
	}

	// Enter with nothing checked must NOT start an install.
	mi, cmd := m.Update(namedKey(tea.KeyEnter))
	m = mi.(InstallModel)
	if cmd != nil || m.stage != stageSelect {
		t.Fatal("enter with no selection should be a no-op")
	}

	// Toggle the first stack, then start.
	mi, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{' '}})
	m = mi.(InstallModel)
	if !m.checked[0] {
		t.Fatal("space should check the cursor row")
	}
	if names := m.selectedNames(); len(names) != 1 || names[0] != "immich" {
		t.Fatalf("selectedNames = %v", names)
	}
	mi, cmd = m.Update(namedKey(tea.KeyEnter))
	m = mi.(InstallModel)
	if m.stage != stageStarting || cmd == nil {
		t.Fatalf("enter should move to starting with a command, stage=%v", m.stage)
	}
}

func TestInstallProgressToDone(t *testing.T) {
	m := NewInstall(&rest.Client{})
	mi, _ := m.Update(installStartedMsg{jobID: "job-1"})
	m = mi.(InstallModel)
	if m.stage != stageInstalling || m.jobID != "job-1" {
		t.Fatalf("after start: stage=%v job=%q", m.stage, m.jobID)
	}

	// An active progress tick keeps installing and appends logs.
	mi, cmd := m.Update(progressMsg{p: &rest.Progress{Phase: "running", Percent: 30, Active: true, NewLogs: "pulling image\n", NextOffset: 14}})
	m = mi.(InstallModel)
	if m.stage != stageInstalling || cmd == nil {
		t.Fatal("active progress should keep polling")
	}
	if m.percent != 30 || m.offset != 14 || len(m.logTail) != 1 {
		t.Fatalf("progress state: pct=%d off=%d logs=%v", m.percent, m.offset, m.logTail)
	}

	// A terminal (inactive) progress with no error → done, success.
	mi, _ = m.Update(progressMsg{p: &rest.Progress{Phase: "completed", Percent: 100, Active: false}})
	m = mi.(InstallModel)
	if m.stage != stageDone || m.failed {
		t.Fatalf("should be done+success, stage=%v failed=%v", m.stage, m.failed)
	}
	if !strings.Contains(m.View(), "complete") {
		t.Error("done view should report completion")
	}
}

func TestInstallFailureSurfaces(t *testing.T) {
	m := NewInstall(&rest.Client{})
	mi, _ := m.Update(installStartedMsg{jobID: "job-1"})
	m = mi.(InstallModel)
	mi, _ = m.Update(progressMsg{p: &rest.Progress{Phase: "failed", Active: false, Error: "image pull failed"}})
	m = mi.(InstallModel)
	if m.stage != stageDone || !m.failed {
		t.Fatalf("should be done+failed, stage=%v failed=%v", m.stage, m.failed)
	}
	if !strings.Contains(m.View(), "image pull failed") {
		t.Error("failure view should show the error")
	}
}

func TestInstallStartErrorGoesToErrorStage(t *testing.T) {
	m := NewInstall(&rest.Client{})
	mi, _ := m.Update(installStartedMsg{err: rest.ErrUnauthorized})
	m = mi.(InstallModel)
	if m.stage != stageError {
		t.Fatalf("start error should reach error stage, got %v", m.stage)
	}
}

func TestProgressBar(t *testing.T) {
	bar := progressBar(50, 10)
	if !strings.Contains(bar, "50%") {
		t.Errorf("bar missing percent: %q", bar)
	}
	// 50% of 10 = 5 filled blocks.
	if strings.Count(bar, "█") != 5 {
		t.Errorf("expected 5 filled blocks, got %q", bar)
	}
}

// TestInstallSurfacesPollError: a failing progress poll must be visible in the
// installing view, not silently leave it frozen at 0%.
func TestInstallSurfacesPollError(t *testing.T) {
	m := InstallModel{client: &rest.Client{BaseURL: "http://box:5888"}, stage: stageInstalling, jobID: "j1"}
	mi, _ := m.Update(progressMsg{err: &rest.APIError{Status: 404, Message: "job not found"}})
	m = mi.(InstallModel)
	v := m.View()
	if !strings.Contains(v, "progress unavailable") || !strings.Contains(v, "job not found") {
		t.Errorf("installing view should surface the poll error, got:\n%s", v)
	}
}

// TestInstallNeedsCredentials: a needs_credentials phase points the operator at
// the web UI instead of spinning forever.
func TestInstallNeedsCredentials(t *testing.T) {
	m := InstallModel{client: &rest.Client{BaseURL: "http://box:5888"}, stage: stageInstalling, jobID: "j1"}
	mi, _ := m.Update(progressMsg{p: &rest.Progress{Phase: "needs_credentials", Active: true}})
	m = mi.(InstallModel)
	v := m.View()
	if !strings.Contains(v, "needs configuration") || !strings.Contains(v, "http://box:5888/") {
		t.Errorf("needs_credentials should point to the web UI, got:\n%s", v)
	}
}
