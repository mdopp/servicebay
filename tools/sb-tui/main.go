// Command sb-tui is the ServiceBay lifecycle launcher (#1272/#1273): one front
// door for ISO build → boot → watch → install. It ports the Ink launcher's
// phase-detection menu to Go/Bubble Tea. The install-watch dashboard is native
// (#1274) and the ISO build is now native too (#1278/#1295): the BuildISO
// action runs the in-process buildflow wizard — install-fedora-coreos.sh is
// gone.
//
// Run from the repo: `go run ./tools/sb-tui` for the menu, or
// `go run ./tools/sb-tui watch` to open the install-watch dashboard directly.
// Operators who don't clone the repo install a cross-compiled binary via the
// curl|sh installer (install-sb-tui.sh) — see .github/workflows/release-binaries.yml.
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

	"servicebay-tui/internal/build"
	"servicebay-tui/internal/buildflow"
	"servicebay-tui/internal/iso"
	"servicebay-tui/internal/phase"
	"servicebay-tui/internal/probes"
	"servicebay-tui/internal/rest"
	"servicebay-tui/internal/ui"
	"servicebay-tui/internal/usb"
	"servicebay-tui/internal/watch"
)

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
func runExecute(plan buildflow.Plan) int {
	if missing := buildflow.MissingTools(); len(missing) > 0 {
		fmt.Fprintf(os.Stderr, "Cannot build an ISO — missing build-host tools: %v\n", missing)
		fmt.Fprintln(os.Stderr, "Install them and retry (Fedora: sudo dnf install butane coreos-installer openssl openssh).")
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
	if missing := buildflow.MissingTools(); len(missing) > 0 {
		fmt.Fprintf(os.Stderr, "Cannot build an ISO — missing build-host tools: %v\n", missing)
		fmt.Fprintln(os.Stderr, "Install them and retry (Fedora: sudo dnf install butane coreos-installer openssl openssh).")
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
// pointing the operator at the setup URL.
func runWatch() int {
	t := probes.ResolveTarget()
	if t.Host == "" {
		fmt.Fprintln(os.Stderr, "no target host — set SB_HOST (and SB_PORT), or build an ISO first so build/fcos/install-settings.env exists.")
		return 2
	}
	return watchTarget(ui.NewWatch(t.Host, t.Port), t.Host, t.Port)
}

// watchTarget runs a watch dashboard model and prints the handoff banner on a
// takeover exit. Shared by runWatch and the post-build reinstall continuation.
func watchTarget(model ui.WatchModel, host, port string) int {
	final, err := tea.NewProgram(model, tea.WithAltScreen()).Run()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if wm, ok := final.(ui.WatchModel); ok && wm.Takeover {
		elapsed, reboots := wm.Stats()
		fmt.Printf("\n→ ServiceBay wizard is live\n\n")
		fmt.Printf("   Setup wizard:  http://%s:%s/setup\n", host, port)
		fmt.Printf("   Dashboard:     http://%s:%s/\n\n", host, port)
		fmt.Printf("   Total: %s, %d reboot(s) observed.\n\n", watch.FmtDur(elapsed), reboots)
	}
	return 0
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
		fmt.Fprintln(os.Stderr, "Run `sb-tui` (no subcommand) and pick a box-control action to sign in — the TUI mints + saves its own token.")
		return nil, 2
	}
	return client, 0
}

// runExpress runs the guided Express setup (#1233): a confirm screen, then the
// auto-sequenceable pre-boot legs — build + flash, a boot pause, then watch.
// The post-boot restore/install steps stay as the dedicated panels since they
// need a reachable box + token. Any leg failing aborts the sequence.
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

	// 1) Build + flash the ISO (the buildflow wizard does both).
	if code := runBuild(); code != 0 {
		return code
	}

	// 2) Boot pause — the physical step Express can't do for the operator.
	fmt.Print("\n→ Boot the box from the USB stick now.\n")
	fmt.Print("   Press Enter once it's powering on to watch the install… ")
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')

	// 3) Watch the install through to the wizard handoff.
	return runWatch()
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
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "watch":
			os.Exit(runWatch())
		case "build":
			os.Exit(runBuild())
		case "express":
			os.Exit(runExpress())
		case "config":
			os.Exit(runConfig())
		case "install":
			os.Exit(runInstallStacks())
		case "backups":
			os.Exit(runBackups())
		}
	}

	// Full-screen unified app (alt-screen): the menu, login, and the
	// box-control panels (edit-config / install / backups) all live in one
	// program — sub-views return to the menu instead of exiting, and the box
	// panels sign in + mint a token in-flow rather than dead-ending on a
	// missing SB_TOKEN. The bootstrap/watch legs below are the only handoffs
	// that quit the app, because build is an interactive stdin wizard and the
	// rest are natural one-shots.
	t := probes.ResolveTarget()
	app := ui.NewApp(detect, t.Host, t.Port, probes.ResolveToken(t.Host), probes.SaveToken, buildConfig())
	final, err := tea.NewProgram(app, tea.WithAltScreen()).Run()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	res, ok := final.(ui.App)
	if !ok {
		return
	}

	// Watch / edit-config / install / backups / the build form all run inside
	// the App and return to the menu. Only these need a post-exit handoff: the
	// build form's confirmed Plan (bake + sudo flash run in the normal
	// terminal), and Express's guided sequence.
	switch {
	case res.BuildPlan != nil:
		os.Exit(runBuildThenWatch(*res.BuildPlan))
	case res.Chosen == phase.Express:
		os.Exit(runExpress())
	}
}

// runBuildThenWatch runs a confirmed build Plan, then — instead of stopping —
// keeps going: it tells the operator to boot the server from the USB and opens
// the install-watch dashboard on the target box (offline → reboot → install →
// live). Reinstall mode waits for the box to reboot first, so the still-running
// old install isn't mistaken for the finished new one.
func runBuildThenWatch(plan buildflow.Plan) int {
	if code := runExecute(plan); code != 0 {
		return code
	}
	host, port := plan.Settings.StaticIP, plan.Settings.ServicebayPort
	if host == "" {
		return 0 // nothing to watch (no target); build is done
	}
	fmt.Printf("\n→ USB is ready. Take it to the server and boot from it now.\n")
	fmt.Printf("  Watching %s:%s — it'll show offline → reboot → install progress → live.\n", host, port)
	fmt.Printf("  (Ctrl+C to stop watching; the install continues on the box regardless.)\n\n")
	return watchTarget(ui.NewWatchReinstall(host, port), host, port)
}
