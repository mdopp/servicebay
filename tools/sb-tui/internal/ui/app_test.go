package ui

import (
	"context"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"servicebay-tui/internal/build"
	"servicebay-tui/internal/buildflow"
	"servicebay-tui/internal/iso"
	"servicebay-tui/internal/phase"
)

func testDetect(context.Context) (bool, phase.BoxStatus) {
	return true, phase.BoxStatus{Reachable: true, WizardDone: true}
}

func buildflowPlanStub() buildflow.Plan {
	return buildflow.Plan{Settings: build.Settings{ServerName: "box"}, Image: iso.Choice{Kind: "local", Path: "/x.iso"}}
}

func newTestApp(token string) (App, *[]string) {
	app, saved, _ := newTestAppWithDelete(token)
	return app, saved
}

func newTestAppWithDelete(token string) (App, *[]string, *[]string) {
	var saved, deleted []string
	save := func(host, tok string) error { saved = append(saved, host+"="+tok); return nil }
	del := func(host string) error { deleted = append(deleted, host); return nil }
	return NewApp(testDetect, "box", "5888", token, save, del, BuildConfig{}), &saved, &deleted
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

// TestReauthRequiredDropsStaleTokenAndReopensLogin: a panel reporting a rejected
// token (reauthRequiredMsg) drops the in-memory + persisted token and re-opens
// sign-in for the same panel, instead of dead-ending. Signing in then resumes
// into the originally-requested panel. This is the post-reinstall stale-token
// recovery (#1502).
func TestReauthRequiredDropsStaleTokenAndReopensLogin(t *testing.T) {
	app, _, deleted := newTestAppWithDelete("sb_stale")
	// Open a panel (records pending=InstallStacks) — the box would 401 on its
	// first call; the panel returns reauthRequiredMsg.
	mi, _ := app.Update(menuSelectedMsg{id: phase.InstallStacks})
	app = mi.(App)
	mi, _ = app.Update(reauthRequiredMsg{})
	app = mi.(App)
	if app.screen != appLogin {
		t.Fatalf("screen = %v, want appLogin after reauth", app.screen)
	}
	if app.token != "" {
		t.Errorf("stale token not dropped: %q", app.token)
	}
	if len(*deleted) != 1 || (*deleted)[0] != "box" {
		t.Errorf("persisted token not deleted: %v", *deleted)
	}
	if _, ok := app.active.(LoginModel); !ok {
		t.Errorf("active = %T, want LoginModel", app.active)
	}
	// A fresh sign-in resumes into the panel that 401'd.
	mi, _ = app.Update(authSucceededMsg{token: "sb_fresh"})
	app = mi.(App)
	if app.token != "sb_fresh" {
		t.Errorf("token = %q after re-auth", app.token)
	}
	if _, ok := app.active.(InstallModel); !ok {
		t.Errorf("active = %T, want InstallModel resumed after re-auth", app.active)
	}
}

// TestExpressQuitsApp: Express hands off to the entrypoint (sets Chosen + quits).
func TestExpressQuitsApp(t *testing.T) {
	app, _ := newTestApp("")
	mi, cmd := app.Update(menuSelectedMsg{id: phase.Express})
	app = mi.(App)
	if app.Chosen != phase.Express {
		t.Errorf("Chosen = %v", app.Chosen)
	}
	if cmd == nil || cmd() != tea.Quit() {
		t.Error("Express should quit the app")
	}
}

// TestBuildOpensFormInApp: BuildISO opens the build form in-app (esc → menu),
// it does NOT immediately set Chosen / quit.
func TestBuildOpensFormInApp(t *testing.T) {
	app, _ := newTestApp("")
	mi, _ := app.Update(menuSelectedMsg{id: phase.BuildISO})
	app = mi.(App)
	if app.screen != appPanel || app.Chosen != "" {
		t.Fatalf("build: screen=%v chosen=%q", app.screen, app.Chosen)
	}
	if _, ok := app.active.(BuildFormModel); !ok {
		t.Errorf("active = %T, want BuildFormModel", app.active)
	}
}

// TestBuildConfirmedHandsOffPlan: the form's confirm sets the BuildPlan + Chosen
// and quits so the entrypoint runs the bake/flash.
func TestBuildConfirmedHandsOffPlan(t *testing.T) {
	app, _ := newTestApp("")
	mi, cmd := app.Update(buildConfirmedMsg{plan: buildflowPlanStub()})
	app = mi.(App)
	if app.BuildPlan == nil || app.Chosen != phase.BuildISO {
		t.Fatalf("expected BuildPlan + Chosen=BuildISO, got %v / %q", app.BuildPlan, app.Chosen)
	}
	if cmd == nil || cmd() != tea.Quit() {
		t.Error("confirm should quit the app to run the build")
	}
}

// TestUploadToNASRoutesWithoutLogin: the NAS upload is FTP-only (no ServiceBay
// box/token), so it must open its panel directly even with no token — never the
// login view. This is the pre-install backup-staging step.
func TestUploadToNASRoutesWithoutLogin(t *testing.T) {
	app, _ := newTestApp("") // no token
	mi, _ := app.Update(menuSelectedMsg{id: phase.UploadToNAS})
	app = mi.(App)
	if app.screen != appPanel {
		t.Fatalf("screen = %v, want appPanel (not login)", app.screen)
	}
	if _, ok := app.active.(NasUploadModel); !ok {
		t.Errorf("active = %T, want NasUploadModel", app.active)
	}
}

// TestWatchRunsInApp: watch opens as an in-app sub-view (no auth) and does NOT
// set Chosen / quit the app.
func TestWatchRunsInApp(t *testing.T) {
	app, _ := newTestApp("")
	mi, _ := app.Update(menuSelectedMsg{id: phase.WatchInstall})
	app = mi.(App)
	if app.screen != appPanel || app.Chosen != "" {
		t.Fatalf("watch: screen=%v chosen=%q", app.screen, app.Chosen)
	}
	if _, ok := app.active.(WatchModel); !ok {
		t.Errorf("watch active = %T, want WatchModel", app.active)
	}
}
