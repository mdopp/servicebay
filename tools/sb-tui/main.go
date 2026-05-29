// Command sb-tui is the ServiceBay lifecycle launcher (#1272/#1273): one front
// door for ISO build → boot → watch → install. This scaffold ports the Ink
// launcher's phase-detection menu to Go/Bubble Tea; the build + watch actions
// still shell out to the existing bash scripts, which later issues replace with
// native Go (then delete the scripts):
//
//	#1274 — native install-watch, delete scripts/install-tui.sh
//	#1278 — native ISO build + USB flash, delete install-fedora-coreos.sh
//
// Run from the repo: `go run ./tools/sb-tui` (the distributable binary +
// curl|sh installer come in #1279).
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
)

func detect(ctx context.Context) (bool, phase.BoxStatus) {
	return probes.ISOBuilt(), probes.BoxStatus(ctx)
}

// repoRoot locates the bash legs the scaffold still shells to. SB_REPO_ROOT
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

func main() {
	final, err := tea.NewProgram(ui.New(detect)).Run()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	m, ok := final.(ui.Model)
	if !ok {
		return
	}

	root := repoRoot()
	switch m.Chosen {
	case phase.BuildISO:
		os.Exit(runLeg("bash", filepath.Join(root, "install-fedora-coreos.sh")))
	case phase.WatchInstall:
		os.Exit(runLeg("bash", filepath.Join(root, "scripts", "install-tui.sh")))
	}
}
