// Package phase holds the lifecycle phase-detection logic for the sb
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
	AttachInstall ActionID = "attach-install"
	EditConfig    ActionID = "edit-config"
	InstallStacks ActionID = "install-stacks"
	Backups       ActionID = "backups"
	SwitchChannel ActionID = "switch-channel"
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

// switchChannelAction is the in-TUI update-channel switch: run a different
// release channel on this server (latest / dev / test). Re-points the
// ServiceBay image + restarts; reverts on reinstall. Mainly to try an
// unreleased `:dev` build. Only meaningful once the box is reachable.
var switchChannelAction = Action{SwitchChannel, "Switch update channel (latest / dev / test)",
	"Run a different release channel on this server — e.g. `dev` to try the latest unreleased build. Pulls the image and restarts ServiceBay; reverts to the baked channel on reinstall."}

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
		return Action{BuildISO, "Reinstall — build a new install USB from scratch",
			"Bake a fresh ServiceBay installer and write it to a USB stick to reinstall this server from scratch."}
	case s.ISOBuilt:
		return Action{BuildISO, "Rebuild the install USB  ·  fresh secrets + config",
			"Re-bake the installer ISO with fresh secrets / config and write it to a USB stick."}
	default:
		return Action{BuildISO, "Build the install USB  ·  server config baked in",
			"Bake a ServiceBay installer ISO from Fedora CoreOS — with your server config baked in — and write it to a USB stick."}
	}
}

// quitAction closes the launcher. The menu auto-refreshes its phase on a timer,
// so there's no manual "Refresh" entry.
var quitAction = Action{Quit, "Quit", "Exit the launcher."}

// StepStatus / journey rows ---------------------------------------------------

// JourneyRow is one line of the setup-journey map the launcher menu renders: the
// build → boot → install → manage arc, top to bottom, so an operator always sees
// where they are and what's next. Numbered rows (Num 1..4) are the arc itself;
// Num 0 rows are helpers (Express, Quit) or the management sub-actions under
// step 4. A row whose Action.ID is empty is a non-selectable signpost — either a
// future step shown greyed for orientation (Ahead) or a section header.
type JourneyRow struct {
	Action      Action
	Num         int  // 1..4 journey step; 0 = helper / sub-item
	Done        bool // already accomplished — rendered with a ✓
	Ahead       bool // not actionable yet — rendered greyed
	Recommended bool // the default cursor target for this phase
}

// Selectable reports whether the cursor can land on (and enter) this row.
// Signposts and section headers carry an empty Action.ID and are skipped.
func (r JourneyRow) Selectable() bool { return r.Action.ID != "" }

// uploadStep frames the NAS-staging action for the operator's current phase: a
// "stage your backups first" prompt before install (when it matters most, and
// reachable over plain FTP with no box yet), a routine re-stage afterwards.
func uploadStep(s State) Action {
	if s.BoxReachable {
		return uploadToNASAction
	}
	return Action{UploadToNAS, "Stage existing backups on the NAS",
		"Migrating? Send your Home Assistant backup to the FritzBox NAS first, so the fresh install restores it. Skip if you have nothing to migrate."}
}

// watchStep frames the boot+watch action: a "boot the USB then watch" prompt
// before the box is up, a plain "watch the logs" once it's installing.
func watchStep(s State) Action {
	if s.BoxReachable {
		return Action{WatchInstall, "Watch the install logs",
			"Live-track the running install until ServiceBay's setup wizard takes over."}
	}
	return Action{WatchInstall, "Boot the box from USB, then watch the install",
		"Power the box on from the USB stick; this live-tracks the install until the setup wizard is up."}
}

// signpost is a non-selectable journey row (empty ID): a future step shown for
// orientation, or a section header.
func signpost(label, detail string) Action { return Action{"", label, detail} }

// Journey returns the full setup-journey map for a phase — the numbered arc plus
// helpers — including non-selectable signposts for steps that aren't reachable
// yet, so the menu can render the whole path top-to-bottom with a "you are here"
// cursor on the recommended next step.
func Journey(s State) []JourneyRow {
	afterBoot := signpost("After boot: install stacks / tweak config",
		"Server config is baked into the USB at build time, so this step is optional — add services or adjust settings once the box is up.")
	manage := signpost("Manage your server", "")
	switch s.Phase {
	case NoISO:
		return []JourneyRow{
			{Action: uploadStep(s), Num: 1, Recommended: true},
			{Action: buildAction(s), Num: 2},
			{Action: signpost("Boot the box from USB + watch the install",
				"Available once you've built the USB: power the box on from it and watch the install through to the setup wizard."), Num: 3, Ahead: true},
			{Action: afterBoot, Num: 4, Ahead: true},
			{Action: expressAction},
			{Action: quitAction},
		}
	case ISOReady:
		return []JourneyRow{
			{Action: uploadStep(s), Num: 1},
			{Action: buildAction(s), Num: 2, Done: true},
			{Action: watchStep(s), Num: 3, Recommended: true},
			{Action: afterBoot, Num: 4, Ahead: true},
			{Action: quitAction},
		}
	case Installing:
		return []JourneyRow{
			{Action: uploadStep(s), Num: 1, Done: true},
			{Action: buildAction(s), Num: 2, Done: true},
			{Action: watchStep(s), Num: 3, Recommended: true},
			{Action: manage, Num: 4},
			{Action: editConfigAction},
			{Action: installStacksAction},
			{Action: backupsAction},
			{Action: switchChannelAction},
			{Action: bootFromUSBAction},
			{Action: quitAction},
		}
	case Ready:
		return []JourneyRow{
			{Action: uploadStep(s), Num: 1, Done: true},
			{Action: buildAction(s), Num: 2, Done: true},
			{Action: signpost("Install complete — setup wizard finished", ""), Num: 3, Done: true},
			{Action: manage, Num: 4},
			{Action: installStacksAction, Recommended: true},
			{Action: editConfigAction},
			{Action: backupsAction},
			{Action: switchChannelAction},
			{Action: bootFromUSBAction},
			{Action: quitAction},
		}
	}
	return nil
}

// ActionsFor returns just the selectable menu entries for a phase, in journey
// order — the build → boot → install → manage arc with the recommended next
// step surfaced. It is the selectable projection of Journey.
func ActionsFor(s State) []Action {
	rows := Journey(s)
	out := make([]Action, 0, len(rows))
	for _, r := range rows {
		if r.Selectable() {
			out = append(out, r.Action)
		}
	}
	return out
}

// Describe is the one-line phase summary shown above the menu.
func Describe(s State) string {
	switch s.Phase {
	case NoISO:
		return "Fresh setup — follow the steps below. Stage any backups first, then build the install USB."
	case ISOReady:
		return "Install USB is ready. Stage backups if you're migrating, then boot the box and watch it install."
	case Installing:
		return "Box is reachable; an install is actively running."
	case Ready:
		return "Box is up and reachable — manage it below."
	default:
		return ""
	}
}
