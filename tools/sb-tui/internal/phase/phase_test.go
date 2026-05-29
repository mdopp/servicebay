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
	// no-iso: build only, then refresh/quit
	if got := ids(ActionsFor(Detect(false, BoxStatus{}))); !eq(got, []ActionID{BuildISO, Refresh, Quit}) {
		t.Fatalf("no-iso actions = %v", got)
	}
	// iso-ready: build + watch, then refresh/quit
	if got := ids(ActionsFor(Detect(true, BoxStatus{}))); !eq(got, []ActionID{BuildISO, WatchInstall, Refresh, Quit}) {
		t.Fatalf("iso-ready actions = %v", got)
	}
	// installing: watch only
	if got := ids(ActionsFor(Detect(true, BoxStatus{Reachable: true}))); !eq(got, []ActionID{WatchInstall, Refresh, Quit}) {
		t.Fatalf("installing actions = %v", got)
	}
	// ready: watch (reinstall)
	if got := ids(ActionsFor(Detect(true, BoxStatus{Reachable: true, WizardDone: true}))); !eq(got, []ActionID{WatchInstall, Refresh, Quit}) {
		t.Fatalf("ready actions = %v", got)
	}
}

func TestBuildLabelFlipsOnRebuild(t *testing.T) {
	fresh := ActionsFor(Detect(false, BoxStatus{}))[0]
	rebuilt := ActionsFor(Detect(true, BoxStatus{}))[0]
	if fresh.Label != "Build install ISO + flash USB" {
		t.Fatalf("fresh label = %q", fresh.Label)
	}
	if rebuilt.Label != "Rebuild install ISO + flash USB" {
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
