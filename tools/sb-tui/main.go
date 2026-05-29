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
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"

	tea "github.com/charmbracelet/bubbletea"

	"servicebay-tui/internal/buildflow"
	"servicebay-tui/internal/phase"
	"servicebay-tui/internal/probes"
	"servicebay-tui/internal/rest"
	"servicebay-tui/internal/ui"
	"servicebay-tui/internal/watch"
)

func detect(ctx context.Context) (bool, phase.BoxStatus) {
	return probes.ISOBuilt(), probes.BoxStatus(ctx)
}

// runBuild runs the native interactive ISO-build wizard (#1295). Build-host
// tools (butane, coreos-installer, openssl, ssh-keygen) must be on PATH; the
// wizard surfaces a clear error if a step can't find one.
func runBuild() int {
	if missing := buildflow.MissingTools(); len(missing) > 0 {
		fmt.Fprintf(os.Stderr, "Cannot build an ISO — missing build-host tools: %v\n", missing)
		fmt.Fprintln(os.Stderr, "Install them and retry (Fedora: sudo dnf install butane coreos-installer openssl openssh).")
		return 2
	}
	p := buildflow.NewIOPrompter(os.Stdin, os.Stdout)
	if err := buildflow.Run(p, buildflow.Options{BuildDir: probes.BuildDir(), Deps: buildflow.DefaultDeps()}); err != nil {
		fmt.Fprintln(os.Stderr, "build failed:", err)
		return 1
	}
	return 0
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
	final, err := tea.NewProgram(ui.NewWatch(t.Host, t.Port), tea.WithAltScreen()).Run()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if wm, ok := final.(ui.WatchModel); ok && wm.Takeover {
		elapsed, reboots := wm.Stats()
		fmt.Printf("\n→ ServiceBay wizard is live\n\n")
		fmt.Printf("   Setup wizard:  http://%s:%s/setup\n", t.Host, t.Port)
		fmt.Printf("   Dashboard:     http://%s:%s/\n\n", t.Host, t.Port)
		fmt.Printf("   Total: %s, %d reboot(s) observed.\n\n", watch.FmtDur(elapsed), reboots)
	}
	return 0
}

// runOpenBox prints the box's setup + dashboard URLs and best-effort opens the
// dashboard in the operator's browser (#1272 menu action OpenBox).
func runOpenBox() int {
	t := probes.ResolveTarget()
	if t.Host == "" {
		fmt.Fprintln(os.Stderr, "no box target — set SB_HOST (and SB_PORT), or build an ISO first so build/fcos/install-settings.env exists.")
		return 2
	}
	dashboard := fmt.Sprintf("http://%s:%s/", t.Host, t.Port)
	fmt.Printf("\n→ ServiceBay\n\n")
	fmt.Printf("   Dashboard:     %s\n", dashboard)
	fmt.Printf("   Setup wizard:  http://%s:%s/setup\n\n", t.Host, t.Port)
	openBrowser(dashboard)
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
	client, err := rest.New(t.Host, t.Port, probes.ResolveToken())
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		fmt.Fprintln(os.Stderr, "Mint one in ServiceBay → Settings → API tokens (scopes: mutate + lifecycle) and export it as SB_TOKEN.")
		return nil, 2
	}
	return client, 0
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

// openBrowser best-effort launches the host's default browser; failures are
// ignored (the URLs are already printed for the operator to copy).
func openBrowser(url string) {
	var name string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		name, args = "open", []string{url}
	case "windows":
		name, args = "rundll32", []string{"url.dll,FileProtocolHandler", url}
	default:
		name, args = "xdg-open", []string{url}
	}
	_ = exec.Command(name, args...).Start()
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
		case "config":
			os.Exit(runConfig())
		case "install":
			os.Exit(runInstallStacks())
		}
	}

	// Full-screen (alt-screen): the launcher owns the terminal like a real
	// installer rather than scrolling inline.
	final, err := tea.NewProgram(ui.New(detect), tea.WithAltScreen()).Run()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	m, ok := final.(ui.Model)
	if !ok {
		return
	}

	switch m.Chosen {
	case phase.BuildISO:
		os.Exit(runBuild())
	case phase.WatchInstall:
		os.Exit(runWatch())
	case phase.OpenBox:
		os.Exit(runOpenBox())
	case phase.EditConfig:
		os.Exit(runConfig())
	case phase.InstallStacks:
		os.Exit(runInstallStacks())
	}
}
