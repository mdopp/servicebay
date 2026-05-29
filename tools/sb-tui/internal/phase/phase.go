// Package phase holds the lifecycle phase-detection logic for the sb-tui
// launcher (#1273, porting packages/tui/src/phase.ts to Go). Pure: it takes
// already-probed facts (is an ISO built? is the box up? is setup done?) and
// derives the phase + the relevant menu actions, so the decision tree is unit
// testable with no network or filesystem. The real probes live in the probes
// package.
package phase

// Lifecycle is the operator's current spot in the build→boot→install arc.
type Lifecycle string

const (
	NoISO      Lifecycle = "no-iso"     // nothing built yet — bake an install ISO
	ISOReady   Lifecycle = "iso-ready"  // ISO built, box not reachable — boot the USB then watch
	Installing Lifecycle = "installing" // box reachable but setup/install still running
	Ready      Lifecycle = "ready"      // box up and the setup wizard is complete
)

// BoxStatus is the probed reachability + setup-completion of the target box.
type BoxStatus struct {
	Reachable  bool
	WizardDone bool
}

// State is the derived phase plus the raw facts it came from.
type State struct {
	Phase        Lifecycle
	ISOBuilt     bool
	BoxReachable bool
	WizardDone   bool
}

// Detect derives the lifecycle phase from the probed facts.
func Detect(isoBuilt bool, status BoxStatus) State {
	var p Lifecycle
	switch {
	case status.Reachable && status.WizardDone:
		p = Ready
	case status.Reachable:
		p = Installing
	case isoBuilt:
		p = ISOReady
	default:
		p = NoISO
	}
	return State{Phase: p, ISOBuilt: isoBuilt, BoxReachable: status.Reachable, WizardDone: status.WizardDone}
}

// ActionID identifies a menu entry. Handoff actions (build/watch) are run by
// the entrypoint; refresh/quit are handled in the UI model.
type ActionID string

const (
	BuildISO     ActionID = "build-iso"
	WatchInstall ActionID = "watch-install"
	Refresh      ActionID = "refresh"
	Quit         ActionID = "quit"
)

// Action is one selectable menu entry.
type Action struct {
	ID    ActionID
	Label string
}

// ActionsFor returns the menu entries relevant to a phase.
//
// Note vs the Ink original: the "Choose / download a Fedora CoreOS ISO" entry
// (the ISO picker sub-screen) is intentionally deferred to the build/flash
// leg (#1278), which owns the picker. The build + watch handoffs shell to the
// existing bash scripts for now; #1274 / #1278 replace those with native Go
// and delete the scripts.
func ActionsFor(s State) []Action {
	var a []Action
	switch {
	case !s.BoxReachable:
		label := "Build install ISO + flash USB"
		if s.ISOBuilt {
			label = "Rebuild install ISO + flash USB"
		}
		a = append(a, Action{BuildISO, label})
		if s.ISOBuilt {
			a = append(a, Action{WatchInstall, "Boot the USB, then watch the install"})
		}
	case s.Phase == Installing:
		a = append(a, Action{WatchInstall, "Watch install progress"})
	default:
		a = append(a, Action{WatchInstall, "Watch a reinstall"})
	}
	a = append(a, Action{Refresh, "Refresh status"}, Action{Quit, "Quit"})
	return a
}

// Describe is the one-line phase summary shown above the menu.
func Describe(s State) string {
	switch s.Phase {
	case NoISO:
		return "No install ISO built yet — start by baking one."
	case ISOReady:
		return "Install ISO is ready. Boot the box from the USB, then watch the install."
	case Installing:
		return "Box is reachable; an install or setup is still in progress."
	case Ready:
		return "Box is up and the setup wizard is complete."
	default:
		return ""
	}
}
