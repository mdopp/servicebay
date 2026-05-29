// Command sb-tui is the ServiceBay lifecycle launcher (#1272/#1273): one front
// door for ISO build → boot → watch → install. It ports the Ink launcher's
// phase-detection menu to Go/Bubble Tea. The install-watch dashboard is now
// native (#1274, replacing scripts/install-tui.sh); the ISO build still shells
// to the existing bash script until #1278 ports it and deletes it:
//
//	#1278 — native ISO build + USB flash, delete install-fedora-coreos.sh
//
// Run from the repo: `go run ./tools/sb-tui` for the menu, or
// `go run ./tools/sb-tui watch` to open the install-watch dashboard directly
// (the distributable binary + curl|sh installer come in #1279).
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	tea "github.com/charmbracelet/bubbletea"

	"servicebay-tui/internal/phase"
	"servicebay-tui/internal/probes"
	"servicebay-tui/internal/ui"
	"servicebay-tui/internal/watch"
)

func detect(ctx context.Context) (bool, phase.BoxStatus) {
	return probes.ISOBuilt(), probes.BoxStatus(ctx)
}

// repoRoot locates the bash legs the launcher still shells to. SB_REPO_ROOT
// overrides; otherwise the current working directory (the launcher is run from
// the repo root for now — #1279 makes it relocatable).
func repoRoot() string {
	if r := os.Getenv("SB_REPO_ROOT"); r != "" {
		return r
	}
	wd, _ := os.Getwd()
	return wd
}

// runLeg execs a subprocess with inherited stdio and returns its exit code.
func runLeg(name string, args ...string) int {
	cmd := exec.Command(name, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitErr.ExitCode()
		}
		fmt.Fprintln(os.Stderr, err)
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

func main() {
	// `sb-tui watch` skips the menu and opens the dashboard directly — used by
	// the install scripts' auto-launch and reachable from the menu's Watch action.
	if len(os.Args) > 1 && os.Args[1] == "watch" {
		os.Exit(runWatch())
	}

	final, err := tea.NewProgram(ui.New(detect)).Run()
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
		os.Exit(runLeg("bash", filepath.Join(repoRoot(), "install-fedora-coreos.sh")))
	case phase.WatchInstall:
		os.Exit(runWatch())
	}
}
