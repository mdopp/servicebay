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
	Express       ActionID = "express"
	BuildISO      ActionID = "build-iso"
	WatchInstall  ActionID = "watch-install"
	EditConfig    ActionID = "edit-config"
	InstallStacks ActionID = "install-stacks"
	Backups       ActionID = "backups"
	UploadToNAS   ActionID = "upload-to-nas"
	BootFromUSB   ActionID = "boot-from-usb"
	Quit          ActionID = "quit"
)

// expressAction is the guided happy-path entry (#1233): chain the
// auto-sequenceable pre-boot legs — build + flash the ISO, prompt the operator
// to boot, then watch the install — behind one confirm screen. The post-boot
// restore + stack-install steps are token-gated, so they stay as the dedicated
// panels reached once the box is up. Offered when no box is reachable yet.
var expressAction = Action{Express, "Express setup — build, boot, watch",
	"Guided happy path: build + flash the install ISO, boot the box, and watch the install through to the setup wizard."}

// editConfigAction is the in-TUI box-control entry (#1275): edit allow-listed
// config over the authenticated REST API without leaving the launcher. Only
// meaningful once the box is reachable.
var editConfigAction = Action{EditConfig, "Edit server config",
	"Change allow-listed settings on the box — server name, domain, log level."}

// installStacksAction is the in-TUI stack-install entry (#1276): pick stacks
// from the box catalog and drive a server-side install over the REST API. Only
// meaningful once the box is reachable.
var installStacksAction = Action{InstallStacks, "Install a stack on the server",
	"Pick services from the catalog and install them on the box, with live progress."}

// backupsAction is the in-TUI backup entry (#1277): list, create, and restore
// system backups over the authenticated REST API. Only meaningful once the box
// is reachable; restore is confirmation-gated in the panel.
var backupsAction = Action{Backups, "Create / restore server backups",
	"List, create, and restore the box's full system backups (config + service data)."}

// uploadToNASAction stages a local service config archive on the box's NAS
// (#1352) so a fresh install pulls it. Only meaningful once the box is reachable.
var uploadToNASAction = Action{UploadToNAS, "Upload a Home Assistant backup to the NAS",
	"Pick a Home Assistant backup file; its config is sent to the FritzBox NAS so a fresh install restores it."}

// bootFromUSBAction reinstalls a reachable box: with the freshly-built USB
// plugged into the server, sign in and set a one-shot UEFI boot to the USB +
// reboot, so the next boot installs from it instead of the existing disk.
var bootFromUSBAction = Action{BootFromUSB, "Boot the server from USB (reinstall)",
	"With the new USB plugged into the server: set it to boot from USB once and reboot, then watch the reinstall."}

// Action is one selectable menu entry: a short Label plus a one-line Detail
// rendered with the selection so the operator always knows what each does.
type Action struct {
	ID     ActionID
	Label  string
	Detail string
}

// buildAction returns the build/reinstall entry, with the verb adapted to the
// phase: a fresh "Build" when nothing exists, "Rebuild" once an ISO is baked,
// and "Reinstall" framing once the box is up.
func buildAction(s State) Action {
	switch {
	case s.BoxReachable:
		return Action{BuildISO, "Reinstall — create install ISO + write it to a USB stick",
			"Bake a fresh ServiceBay installer and write it to a USB stick to reinstall this server from scratch."}
	case s.ISOBuilt:
		return Action{BuildISO, "Rebuild install ISO + write it to a USB stick",
			"Re-bake the installer ISO with fresh secrets / config and write it to a USB stick."}
	default:
		return Action{BuildISO, "Create install ISO + write it to a USB stick",
			"Bake a ServiceBay installer ISO from Fedora CoreOS and write it to a USB stick."}
	}
}

// ActionsFor returns the menu entries relevant to a phase. The list is
// comprehensive — every action that makes sense in the phase is shown, with
// the recommended next step first — rather than a single-action stub.
func ActionsFor(s State) []Action {
	var a []Action
	switch s.Phase {
	case NoISO:
		// Nothing built and no box — express (guided) is the recommended path,
		// with a plain build available for operators who want only the ISO.
		a = append(a, expressAction, buildAction(s))
	case ISOReady:
		// ISO baked, box not up yet — rebuild, or boot-then-watch.
		a = append(a,
			buildAction(s),
			Action{WatchInstall, "Boot the USB, then watch the install",
				"Power on the box from the USB stick; this live-tracks the install until the setup wizard is up."})
	case Installing:
		// Box is up mid-install — watch it, or start managing it / reinstall.
		// The dashboard URL is shown persistently by the menu, so there's no
		// separate "open in browser" action.
		a = append(a,
			Action{WatchInstall, "Watch the server's install logs",
				"Live-track the running install until ServiceBay's setup wizard takes over."},
			editConfigAction,
			installStacksAction,
			backupsAction,
			uploadToNASAction,
			bootFromUSBAction,
			buildAction(s))
	case Ready:
		// Box is fully up — manage it in-TUI, or reinstall. No Watch (nothing to
		// watch on an up box) and no "open in browser" (the URL is always shown).
		a = append(a,
			editConfigAction,
			installStacksAction,
			backupsAction,
			uploadToNASAction,
			bootFromUSBAction,
			buildAction(s))
	}
	// Quit closes the launcher. Status auto-refreshes on a timer, so there's no
	// manual "Refresh" action.
	a = append(a, Action{Quit, "Quit", "Exit the launcher."})
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
		return "Box is reachable; an install is actively running."
	case Ready:
		return "Box is up and reachable — manage it below."
	default:
		return ""
	}
}
