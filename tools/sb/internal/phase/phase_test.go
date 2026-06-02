package phase

import "testing"

func ids(actions []Action) []ActionID {
	out := make([]ActionID, len(actions))
	for i, a := range actions {
		out[i] = a.ID
	}
	return out
}

func eq(a, b []ActionID) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestDetect(t *testing.T) {
	cases := []struct {
		name     string
		isoBuilt bool
		status   BoxStatus
		want     Lifecycle
	}{
		{"no iso, box down", false, BoxStatus{}, NoISO},
		{"iso built, box down", true, BoxStatus{}, ISOReady},
		{"box up, wizard pending", true, BoxStatus{Reachable: true}, Installing},
		{"box up, wizard done", true, BoxStatus{Reachable: true, WizardDone: true}, Ready},
		{"box up wins over no-iso", false, BoxStatus{Reachable: true, WizardDone: true}, Ready},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Detect(c.isoBuilt, c.status).Phase; got != c.want {
				t.Fatalf("Detect = %q, want %q", got, c.want)
			}
		})
	}
}

func TestActionsFor(t *testing.T) {
	// The selectable projection of the journey arc (stage → build → boot → manage),
	// signposts skipped. Auto-refresh + persistent URL mean no Refresh / Open items.
	// no-iso: stage-backups (step 1, recommended) + build, then express + quit.
	if got := ids(ActionsFor(Detect(false, BoxStatus{}))); !eq(got, []ActionID{UploadToNAS, BuildISO, Express, Quit}) {
		t.Fatalf("no-iso actions = %v", got)
	}
	// iso-ready: stage-backups + build (done) + boot-and-watch, then quit.
	if got := ids(ActionsFor(Detect(true, BoxStatus{}))); !eq(got, []ActionID{UploadToNAS, BuildISO, WatchInstall, Quit}) {
		t.Fatalf("iso-ready actions = %v", got)
	}
	// installing: stage + reinstall + watch + manage children (config/stacks/backups/channel/boot-usb), then quit.
	if got := ids(ActionsFor(Detect(true, BoxStatus{Reachable: true}))); !eq(got, []ActionID{UploadToNAS, BuildISO, WatchInstall, EditConfig, InstallStacks, Backups, SwitchChannel, BootFromUSB, Quit}) {
		t.Fatalf("installing actions = %v", got)
	}
	// ready: stage + reinstall + manage children, then quit. No Watch on an up box
	// (step 3 is a done signpost); no Open-in-browser — URL is shown persistently.
	if got := ids(ActionsFor(Detect(true, BoxStatus{Reachable: true, WizardDone: true}))); !eq(got, []ActionID{UploadToNAS, BuildISO, InstallStacks, EditConfig, Backups, SwitchChannel, BootFromUSB, Quit}) {
		t.Fatalf("ready actions = %v", got)
	}
}

// TestJourneyHasSignpostsAndRecommended checks the journey-map invariants the
// menu relies on: pre-install phases show greyed future-step signposts, and
// every phase nominates exactly one recommended (default-cursor) selectable row.
func TestJourneyHasSignpostsAndRecommended(t *testing.T) {
	for _, s := range []State{
		Detect(false, BoxStatus{}),
		Detect(true, BoxStatus{}),
		Detect(true, BoxStatus{Reachable: true}),
		Detect(true, BoxStatus{Reachable: true, WizardDone: true}),
	} {
		rows := Journey(s)
		rec := 0
		for _, r := range rows {
			if r.Recommended {
				if !r.Selectable() {
					t.Fatalf("phase %q: recommended row %q is not selectable", s.Phase, r.Action.Label)
				}
				rec++
			}
		}
		if rec != 1 {
			t.Fatalf("phase %q: want exactly 1 recommended row, got %d", s.Phase, rec)
		}
	}
	// NoISO must signpost the not-yet-reachable boot + manage steps (greyed): the
	// phase-3 and phase-4 headers are Ahead, and every Ahead row (header or
	// sub-item) is non-selectable.
	aheadHeaders := map[int]bool{}
	for _, r := range Journey(Detect(false, BoxStatus{})) {
		if r.Ahead {
			if r.Selectable() {
				t.Fatalf("ahead signpost %q should not be selectable", r.Action.Label)
			}
			if r.Num >= 1 {
				aheadHeaders[r.Num] = true
			}
		}
	}
	if !aheadHeaders[3] || !aheadHeaders[4] {
		t.Fatalf("NoISO: want phase-3 (boot) and phase-4 (manage) headers greyed Ahead, got %v", aheadHeaders)
	}
}

// TestJourneyEveryPhaseIsHeaderWithSubs verifies the consistency the menu wants:
// all four numbered steps are non-selectable headers, and their actions live
// beneath as Sub rows — no bare numbered action rows.
func TestJourneyEveryPhaseIsHeaderWithSubs(t *testing.T) {
	for _, s := range []State{
		Detect(false, BoxStatus{}),
		Detect(true, BoxStatus{}),
		Detect(true, BoxStatus{Reachable: true}),
		Detect(true, BoxStatus{Reachable: true, WizardDone: true}),
	} {
		seen := map[int]bool{}
		for _, r := range Journey(s) {
			if r.Num >= 1 {
				seen[r.Num] = true
				if r.Selectable() {
					t.Errorf("phase %q: numbered header %d (%q) must not be selectable", s.Phase, r.Num, r.Action.Label)
				}
			}
			if r.Selectable() && r.Action.ID != Express && r.Action.ID != Quit && !r.Sub {
				t.Errorf("phase %q: selectable action %q should be a Sub row under a phase header", s.Phase, r.Action.Label)
			}
		}
		for n := 1; n <= 4; n++ {
			if !seen[n] {
				t.Errorf("phase %q: missing numbered header %d", s.Phase, n)
			}
		}
	}
}

func TestEveryActionHasLabelAndDetail(t *testing.T) {
	phases := []State{
		Detect(false, BoxStatus{}),
		Detect(true, BoxStatus{}),
		Detect(true, BoxStatus{Reachable: true}),
		Detect(true, BoxStatus{Reachable: true, WizardDone: true}),
	}
	for _, s := range phases {
		for _, a := range ActionsFor(s) {
			if a.Label == "" || a.Detail == "" {
				t.Fatalf("phase %q action %q missing label/detail", s.Phase, a.ID)
			}
		}
	}
}

func TestBuildLabelFlipsOnRebuild(t *testing.T) {
	// Both phases lead with stage-backups (step 1); the build action is at index 1.
	fresh := ActionsFor(Detect(false, BoxStatus{}))[1]
	rebuilt := ActionsFor(Detect(true, BoxStatus{}))[1]
	if fresh.Label != "Build the install USB  ·  server config baked in" {
		t.Fatalf("fresh label = %q", fresh.Label)
	}
	if rebuilt.Label != "Rebuild the install USB  ·  fresh secrets + config" {
		t.Fatalf("rebuilt label = %q", rebuilt.Label)
	}
}

func TestDescribeCoversEveryPhase(t *testing.T) {
	for _, p := range []Lifecycle{NoISO, ISOReady, Installing, Ready} {
		if Describe(State{Phase: p}) == "" {
			t.Fatalf("Describe(%q) is empty", p)
		}
	}
}
