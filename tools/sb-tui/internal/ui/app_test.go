package ui

import (
	"context"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"servicebay-tui/internal/phase"
)

func testDetect(context.Context) (bool, phase.BoxStatus) {
	return true, phase.BoxStatus{Reachable: true, WizardDone: true}
}

func newTestApp(token string) (App, *[]string) {
	var saved []string
	save := func(host, tok string) error { saved = append(saved, host+"="+tok); return nil }
	return NewApp(testDetect, "box", "5888", token, save), &saved
}

// TestRouteToLoginWhenNoToken: picking a box-control action with no token opens
// the login view, not the panel.
func TestRouteToLoginWhenNoToken(t *testing.T) {
	app, _ := newTestApp("")
	mi, _ := app.Update(menuSelectedMsg{id: phase.EditConfig})
	app = mi.(App)
	if app.screen != appLogin {
		t.Fatalf("screen = %v, want appLogin", app.screen)
	}
	if app.pending != phase.EditConfig {
		t.Errorf("pending = %v", app.pending)
	}
	if _, ok := app.active.(LoginModel); !ok {
		t.Errorf("active = %T, want LoginModel", app.active)
	}
}

// TestRouteToPanelWhenTokenPresent: with a token, the panel opens directly.
func TestRouteToPanelWhenTokenPresent(t *testing.T) {
	app, _ := newTestApp("sb_existing")
	mi, _ := app.Update(menuSelectedMsg{id: phase.Backups})
	app = mi.(App)
	if app.screen != appPanel {
		t.Fatalf("screen = %v, want appPanel", app.screen)
	}
	if _, ok := app.active.(BackupModel); !ok {
		t.Errorf("active = %T, want BackupModel", app.active)
	}
}

// TestAuthSucceededSavesTokenAndOpensPending: logging in persists the token and
// opens the panel that was requested before login.
func TestAuthSucceededSavesTokenAndOpensPending(t *testing.T) {
	app, saved := newTestApp("")
	mi, _ := app.Update(menuSelectedMsg{id: phase.InstallStacks})
	app = mi.(App)
	mi, _ = app.Update(authSucceededMsg{token: "sb_new"})
	app = mi.(App)
	if app.token != "sb_new" {
		t.Errorf("token = %q", app.token)
	}
	if len(*saved) != 1 || (*saved)[0] != "box=sb_new" {
		t.Errorf("saved = %v", *saved)
	}
	if _, ok := app.active.(InstallModel); !ok {
		t.Errorf("active = %T, want InstallModel after auth", app.active)
	}
}

// TestBackReturnsToMenu: a sub-view's backMsg pops to the menu.
func TestBackReturnsToMenu(t *testing.T) {
	app, _ := newTestApp("sb_existing")
	mi, _ := app.Update(menuSelectedMsg{id: phase.EditConfig})
	app = mi.(App)
	mi, _ = app.Update(backMsg{})
	app = mi.(App)
	if app.screen != appMenu || app.active != nil {
		t.Fatalf("after back: screen=%v active=%v", app.screen, app.active)
	}
}

// TestBootstrapLegQuitsApp: build/express/watch/open set Chosen and quit so the
// entrypoint runs them.
func TestBootstrapLegQuitsApp(t *testing.T) {
	app, _ := newTestApp("")
	mi, cmd := app.Update(menuSelectedMsg{id: phase.BuildISO})
	app = mi.(App)
	if app.Chosen != phase.BuildISO {
		t.Errorf("Chosen = %v", app.Chosen)
	}
	if cmd == nil || cmd() != tea.Quit() {
		t.Error("bootstrap leg should quit the app")
	}
}
