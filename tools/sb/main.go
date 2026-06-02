// Command sb is the ServiceBay lifecycle launcher (#1272/#1273): one front
// door for ISO build → boot → watch → install. It ports the Ink launcher's
// phase-detection menu to Go/Bubble Tea. The install-watch dashboard is native
// (#1274) and the ISO build is now native too (#1278/#1295): the BuildISO
// action runs the in-process buildflow wizard — install-fedora-coreos.sh is
// gone.
//
// Run from the repo: `go run ./tools/sb` for the menu, or
// `go run ./tools/sb watch` to open the install-watch dashboard directly.
// Operators who don't clone the repo install a cross-compiled binary via the
// curl|sh installer (install-sb.sh) — see .github/workflows/release-binaries.yml.
package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"sb/internal/build"
	"sb/internal/buildflow"
	"sb/internal/cli"
	"sb/internal/iso"
	"sb/internal/phase"
	"sb/internal/probes"
	"sb/internal/rest"
	"sb/internal/ui"
	"sb/internal/usb"
	"sb/internal/watch"
)

// version is the released ServiceBay version this binary was built from. It
// defaults to "dev" for local `go run`/`go build` and is overridden at release
// build time via -ldflags "-X main.version=<x.y.z>" (see release-binaries.yml),
// so the shipped curl|sh binary self-reports which release it carries.
var version = "dev"

func detect(ctx context.Context) (bool, phase.BoxStatus) {
	return probes.ISOBuilt(), probes.BoxStatus(ctx)
}

// buildConfig assembles the build form's seeded settings + IO deps, shared by
// the in-app build form (menu BuildISO) and the standalone runBuild path
// (Express + the `build` subcommand).
func buildConfig() ui.BuildConfig {
	buildDir := probes.BuildDir()
	saved, _ := build.Load(filepath.Join(buildDir, "install-settings.env"))
	return ui.BuildConfig{
		Saved: buildflow.WithDefaults(saved),
		Deps: ui.BuildDeps{
			Images: func() ([]iso.Choice, int) {
				host := iso.HostArch()
				local := iso.ListLocalISOs(buildflow.ISOSearchDirs(buildDir))
				remote := iso.FetchAllStreams(context.Background())
				ch := iso.BuildChoices(local, remote, host)
				return ch, iso.DefaultChoiceIndex(ch, host)
			},
			USB:            usb.Enumerate,
			GenerateSSHKey: generateSSHKey,
		},
	}
}

// generateSSHKey returns the operator's SSH public key, generating an ed25519
// keypair at ~/.ssh/id_ed25519 if none exists yet (Ctrl+G in the build form).
// An existing key is reused, never overwritten.
func generateSSHKey() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	sshDir := filepath.Join(home, ".ssh")
	priv := filepath.Join(sshDir, "id_ed25519")
	pub := priv + ".pub"
	if b, err := os.ReadFile(pub); err == nil {
		return strings.TrimSpace(string(b)), nil // already have one — reuse
	}
	if err := os.MkdirAll(sshDir, 0o700); err != nil {
		return "", err
	}
	cmd := exec.Command("ssh-keygen", "-t", "ed25519", "-N", "", "-f", priv, "-C", "servicebay")
	if out, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	b, err := os.ReadFile(pub)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

// runExecute runs a confirmed build Plan in the normal terminal: the bake
// streams output and the USB flash needs sudo + a real TTY, so this runs after
// any alt-screen program has exited.
// ensureBuildTools checks for the build-host tools and, when some are missing,
// OFFERS to auto-install them (butane from its GitHub release binary, the rest
// via the package manager / cargo) rather than dead-ending with "install them
// by hand" — restoring the old install-fedora-coreos.sh behaviour (#1327).
// Returns true when every tool is present.
func ensureBuildTools() bool {
	missing := buildflow.MissingTools()
	if len(missing) == 0 {
		return true
	}
	fmt.Fprintf(os.Stderr, "Missing build-host tools: %v\n", missing)
	fmt.Fprint(os.Stderr, "Install them now? (curl-fetches butane + uses your package manager; needs sudo) [Y/n] ")
	if !readYes() {
		fmt.Fprintln(os.Stderr, "Skipped. Install manually (Fedora: sudo dnf install butane coreos-installer openssl openssh) and retry.")
		return false
	}
	if err := buildflow.InstallMissingTools(missing, func(f string, a ...any) { fmt.Fprintf(os.Stderr, f, a...) }); err != nil {
		fmt.Fprintln(os.Stderr, "install failed:", err)
		return false
	}
	if still := buildflow.MissingTools(); len(still) > 0 {
		fmt.Fprintf(os.Stderr, "Still missing after install: %v — check the output above.\n", still)
		return false
	}
	return true
}

// readYes reads a Y/n answer from stdin, defaulting to yes on empty input.
func readYes() bool {
	line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	line = strings.ToLower(strings.TrimSpace(line))
	return line == "" || line == "y" || line == "yes"
}

func runExecute(plan buildflow.Plan) int {
	if !ensureBuildTools() {
		return 2
	}
	if err := buildflow.Execute(plan, buildflow.Options{BuildDir: probes.BuildDir(), Deps: buildflow.DefaultDeps()},
		func(f string, a ...any) { fmt.Printf(f, a...) }); err != nil {
		fmt.Fprintln(os.Stderr, "build failed:", err)
		return 1
	}
	return 0
}

// runBuild runs the build wizard standalone (the `build` subcommand + Express):
// the full-screen form gathers a Plan, then runExecute runs it. The menu's
// BuildISO action instead hosts the form in-app so esc returns to the menu.
func runBuild() int {
	if !ensureBuildTools() {
		return 2
	}
	cfg := buildConfig()
	final, err := tea.NewProgram(ui.NewBuildForm(cfg.Saved, cfg.Deps), tea.WithAltScreen()).Run()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	bf, ok := final.(ui.BuildFormModel)
	if !ok || !bf.Confirmed {
		return 0 // operator cancelled the wizard
	}
	return runExecute(bf.Plan())
}

// runWatch opens the native install-watch dashboard against the resolved box
// target. On a clean exit because ServiceBay's wizard took over, it prints a
// handoff banner (in the normal screen, after the alt-screen program exits)
// pointing the operator at the setup URL. It is shared by the `sb watch`
// subcommand and Express's step 3, so it only reports the exit code; the
// post-install menu hand-off is the caller's call (Express continues into
// runExpressPostBoot; the bare subcommand re-opens the menu — see main).
func runWatch() int {
	t := probes.ResolveTarget()
	if t.Host == "" {
		fmt.Fprintln(os.Stderr, "no target host — set SB_HOST (and SB_PORT), or build an ISO first so build/fcos/install-settings.env exists.")
		return 2
	}
	_, code := watchTarget(ui.NewWatch(t.Host, t.Port, probes.ResolveToken(t.Host)), t.Host, t.Port)
	return code
}

// watchTarget runs a watch dashboard model and prints the handoff banner on a
// takeover exit. Shared by runWatch and the post-build reinstall continuation.
// Returns whether the install completed (the wizard took over) so the caller
// can advance the journey to the post-install menu rather than the shell (#1555).
func watchTarget(model ui.WatchModel, host, port string) (takeover bool, code int) {
	final, err := tea.NewProgram(model, tea.WithAltScreen()).Run()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return false, 1
	}
	if wm, ok := final.(ui.WatchModel); ok && wm.Takeover {
		elapsed, reboots := wm.Stats()
		fmt.Printf("\n→ ServiceBay wizard is live\n\n")
		fmt.Printf("   Setup wizard:  http://%s:%s/setup\n", host, port)
		fmt.Printf("   Dashboard:     http://%s:%s/\n\n", host, port)
		fmt.Printf("   Total: %s, %d reboot(s) observed.\n\n", watch.FmtDur(elapsed), reboots)
		return true, 0
	}
	return false, 0
}

// boxClient resolves the box target + scoped `sb_` token (SB_TOKEN) into a REST
// client shared by the box-control panels. On failure it prints an actionable
// message and returns a non-zero exit code so the caller can return it directly
// rather than opening a blank panel.
func boxClient() (*rest.Client, int) {
	t := probes.ResolveTarget()
	if t.Host == "" {
		fmt.Fprintln(os.Stderr, "no box target — set SB_HOST (and SB_PORT), or build an ISO first so build/fcos/install-settings.env exists.")
		return nil, 2
	}
	client, err := rest.New(t.Host, t.Port, probes.ResolveToken(t.Host))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		fmt.Fprintln(os.Stderr, "Run `sb` (no subcommand) and pick a box-control action to sign in — the TUI mints + saves its own token.")
		return nil, 2
	}
	return client, 0
}

// runExpress runs the guided Express setup (#1233): a confirm screen, then the
// pre-boot legs — build + flash, a boot pause, watch — and finally the post-boot
// legs once the box is reachable: sign in (mint a saved token), restore config
// from the NAS, and install stacks. Any leg failing aborts the rest.
func runExpress() int {
	t := probes.ResolveTarget()
	final, err := tea.NewProgram(ui.NewExpress(t.Host, t.Port), tea.WithAltScreen()).Run()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	em, ok := final.(ui.ExpressModel)
	if !ok || !em.Confirmed {
		return 0 // operator cancelled the plan
	}

	// 0) Optional: stage an existing backup on the NAS first (FTP-only, no box
	// yet) so the fresh install restores it. esc in the panel just continues to
	// the build — staging is a convenience, not a gate.
	if em.StageBackup {
		if code := runNasUpload(); code != 0 {
			return code
		}
	}

	// 1) Build + flash the ISO (the buildflow wizard does both).
	if code := runBuild(); code != 0 {
		return code
	}

	// 2) Boot pause — the physical step Express can't do for the operator.
	fmt.Print("\n→ Boot the box from the USB stick now.\n")
	fmt.Print("   Press Enter once it's powering on to watch the install… ")
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')

	// 3) Watch the install through to the wizard handoff.
	if code := runWatch(); code != 0 {
		return code
	}

	// 4) Post-boot continuation (#1233): the box is up now — sign in (mint a
	//    saved token if needed), restore config from the NAS, then install the
	//    stacks. This is the token-gated tail the pre-boot legs couldn't reach.
	return runExpressPostBoot()
}

// runExpressPostBoot drives the token-gated tail of Express once the box is
// reachable: ensure a scoped token (sign in + mint if none is saved), restore
// NAS config backups, then install stacks. Each leg failing aborts the rest.
func runExpressPostBoot() int {
	t := probes.ResolveTarget()
	if probes.ResolveToken(t.Host) == "" {
		fmt.Print("\n→ Sign in to the box to finish setup (one-time)…\n")
		ok, err := ui.RunLogin(t.Host, t.Port, probes.SaveToken)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		if !ok {
			fmt.Println("Sign-in skipped — run `sb` later to restore + install your stacks.")
			return 0
		}
	}
	// Restore config from the NAS, then install stacks. On a fresh data dir the
	// install also re-seeds config via the server-side auto-restore (#1218).
	if code := runBackups(); code != 0 {
		return code
	}
	return runInstallStacks()
}

// runNasUpload opens the direct-FTP backup-staging panel (#1367). It talks only
// to the FritzBox over FTP — no box/token — so it needs no boxClient and works
// before any box exists (the pre-install staging step + Express's optional step 0).
func runNasUpload() int {
	if _, err := tea.NewProgram(ui.NewNasUpload(), tea.WithAltScreen()).Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

// runConfig opens the edit-config panel (#1275).
func runConfig() int {
	client, code := boxClient()
	if client == nil {
		return code
	}
	if _, err := tea.NewProgram(ui.NewConfig(client), tea.WithAltScreen()).Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

// runInstallStacks opens the stack-install panel (#1276).
func runInstallStacks() int {
	client, code := boxClient()
	if client == nil {
		return code
	}
	if _, err := tea.NewProgram(ui.NewInstall(client), tea.WithAltScreen()).Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

// runBackups opens the backup panel (#1277).
func runBackups() int {
	client, code := boxClient()
	if client == nil {
		return code
	}
	if _, err := tea.NewProgram(ui.NewBackup(client), tea.WithAltScreen()).Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

func main() {
	// Subcommands skip the menu and run one leg directly. `watch` is used by the
	// install scripts' auto-launch; `build` runs the native ISO-build wizard
	// (the same path the menu's BuildISO action takes).
	// Surface the version into the UI layer so the menu can show it.
	ui.Version = version

	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "version", "--version", "-v":
			// Print and exit before touching the TTY, so `sb version` works
			// in a pipe / non-interactive shell.
			fmt.Printf("sb %s\n", version)
			return
		case "help", "-h", "--help":
			cli.PrintUsage()
			return
		case "watch":
			os.Exit(runWatchThenMenu())
		case "build":
			os.Exit(runBuild())
		case "express":
			os.Exit(runExpress())
		case "upload":
			os.Exit(runNasUpload())
		// Groups with both a bare interactive panel and a non-interactive CLI:
		// `sb config` opens the TUI panel; `sb config get|set …` runs headless.
		case "config":
			if len(os.Args) > 2 {
				os.Exit(cli.Config(os.Args[2:]))
			}
			os.Exit(runConfig())
		case "install":
			if len(os.Args) > 2 {
				os.Exit(cli.Install(os.Args[2:]))
			}
			os.Exit(runInstallStacks())
		case "backups":
			if len(os.Args) > 2 {
				os.Exit(cli.Backups(os.Args[2:]))
			}
			os.Exit(runBackups())
		// CLI-only groups (no interactive panel of their own):
		case "channel":
			os.Exit(cli.Channel(os.Args[2:]))
		case "stacks":
			os.Exit(cli.Stacks(os.Args[2:]))
		case "boot":
			os.Exit(cli.Boot(os.Args[2:]))
		case "nas":
			os.Exit(cli.Nas(os.Args[2:]))
		case "token":
			os.Exit(cli.Token(os.Args[2:]))
		}
	}

	os.Exit(runMenu())
}

// runMenu opens the full-screen unified app (alt-screen): the menu, login, and
// the box-control panels (edit-config / install / backups) all live in one
// program — sub-views return to the menu instead of exiting, and the box panels
// sign in + mint a token in-flow rather than dead-ending on a missing SB_TOKEN.
// The build / express handoff legs are the only ones that quit the app (build
// is an interactive stdin wizard; express is a guided sequence), so this runs
// them after the app exits and then re-opens the menu so the operator lands
// back on the setup-journey map rather than a shell prompt (#1555).
func runMenu() int {
	t := probes.ResolveTarget()
	app := ui.NewApp(detect, t.Host, t.Port, probes.ResolveToken(t.Host), probes.SaveToken, probes.DeleteToken, buildConfig())
	final, err := tea.NewProgram(app, tea.WithAltScreen()).Run()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	res, ok := final.(ui.App)
	if !ok {
		return 0
	}

	switch {
	case res.BuildPlan != nil:
		takeover, code := runBuildThenWatch(*res.BuildPlan)
		if code != 0 || !takeover {
			return code
		}
		// The reinstall finished and the box is up; re-open the menu so the
		// operator advances to "Install a stack on the server" (now Recommended
		// in the post-install Ready phase) rather than dropping to a shell.
		return runMenu()
	case res.Chosen == phase.Express:
		return runExpress()
	}
	return 0
}

// runBuildThenWatch runs a confirmed build Plan, then — instead of stopping —
// keeps going: it tells the operator to boot the server from the USB and opens
// the install-watch dashboard on the target box (offline → reboot → install →
// live). Reinstall mode waits for the box to reboot first, so the still-running
// old install isn't mistaken for the finished new one.
func runBuildThenWatch(plan buildflow.Plan) (takeover bool, code int) {
	if code := runExecute(plan); code != 0 {
		return false, code
	}
	host, port := plan.Settings.StaticIP, plan.Settings.ServicebayPort
	if host == "" {
		return false, 0 // nothing to watch (no target); build is done
	}
	fmt.Printf("\n→ USB is ready. Now make the SERVER boot FROM this USB stick:\n\n")
	fmt.Printf("   1. Plug the USB into the server.\n")
	fmt.Printf("   2. Boot it FROM the USB — pick the stick in the firmware boot menu\n")
	fmt.Printf("      (often F12/F11/Esc right after power-on), or set USB first in BIOS\n")
	fmt.Printf("      boot order. A plain reboot just boots the existing install again.\n")
	fmt.Printf("      (On a running ServiceBay box you can instead use Settings → Boot →\n")
	fmt.Printf("       \"boot from USB next\", which sets a one-shot UEFI entry and reboots.)\n\n")
	fmt.Printf("   Watching %s:%s — offline → reboot → install → live. Ctrl+C to stop.\n\n", host, port)
	return watchTarget(ui.NewWatchReinstall(host, port, probes.ResolveToken(host)), host, port)
}

// runWatchThenMenu runs the bare `sb watch` subcommand: watch the install, then
// — once the wizard has taken over — re-open the menu so the operator advances
// to "Install a stack on the server" rather than dropping back to the shell
// (#1555). If the operator aborted before takeover, it just exits with the code.
func runWatchThenMenu() int {
	t := probes.ResolveTarget()
	if t.Host == "" {
		fmt.Fprintln(os.Stderr, "no target host — set SB_HOST (and SB_PORT), or build an ISO first so build/fcos/install-settings.env exists.")
		return 2
	}
	takeover, code := watchTarget(ui.NewWatch(t.Host, t.Port, probes.ResolveToken(t.Host)), t.Host, t.Port)
	if code != 0 || !takeover {
		return code
	}
	return runMenu()
}
