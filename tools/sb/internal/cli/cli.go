// Package cli is the non-interactive, scriptable surface of `sb` — the same
// box-control operations the Bubble Tea panels expose, but driven by flags and
// emitting plain text or `--json` so an agent (or any script) can drive a box
// without a TTY. Every group resolves the box target + scoped token the same
// way the TUI does (probes.ResolveTarget / ResolveToken), so a token minted by
// the interactive sign-in is reused here automatically.
//
// Destructive operations (channel flip, stack install/wipe, install abort,
// backup restore, USB-boot reinstall) refuse to run without an explicit --yes.
package cli

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"sb/internal/probes"
	"sb/internal/rest"
)

// ctx is a process-lifetime context — CLI commands are one-shot.
func ctx() context.Context { return context.Background() }

// boxClient resolves the box target + scoped `sb_` token into a REST client,
// mirroring main.boxClient. On failure it prints an actionable hint and returns
// a non-zero code so the caller returns it directly.
func boxClient() (*rest.Client, int) {
	t := probes.ResolveTarget()
	if t.Host == "" {
		fmt.Fprintln(os.Stderr, "no box target — set SB_HOST (and SB_PORT), or build an ISO first so build/fcos/install-settings.env exists.")
		return nil, 2
	}
	client, err := rest.New(t.Host, t.Port, probes.ResolveToken(t.Host))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		fmt.Fprintln(os.Stderr, "No saved token. Mint one non-interactively with: sb token mint --user <admin> --pass <password>")
		return nil, 2
	}
	return client, 0
}

// fail prints err to stderr and returns exit code 1 — the uniform "the box
// call failed" path.
func fail(err error) int {
	fmt.Fprintln(os.Stderr, err)
	return 1
}

// emit writes v as indented JSON when jsonMode, else calls text() for the
// human-readable rendering. Returns 0 (success exit code) for convenience.
func emit(jsonMode bool, v any, text func()) int {
	if jsonMode {
		return emitJSON(v)
	}
	text()
	return 0
}

func emitJSON(v any) int {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fail(err)
	}
	fmt.Println(string(b))
	return 0
}

// parseFlags binds a flag.FlagSet over args, returning the set so the caller
// can read its values. On a parse error it prints usage and the caller should
// return 2. Output goes to stderr so --json stdout stays clean.
func newFlags(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	return fs
}

// requireYes returns 0 when --yes was passed, else prints why and returns 2.
// The single guard for every destructive CLI op.
func requireYes(yes bool, what string) int {
	if yes {
		return 0
	}
	fmt.Fprintf(os.Stderr, "refusing to %s without --yes (this is destructive).\n", what)
	return 2
}

// usageErr prints a one-line usage hint for a group and returns 2.
func usageErr(w io.Writer, usage string) int {
	fmt.Fprintln(w, usage)
	return 2
}

// PrintUsage prints the full non-interactive command reference. `sb` with no
// args still opens the interactive menu; this is `sb help`.
func PrintUsage() {
	fmt.Print(`sb — ServiceBay lifecycle CLI

Interactive (no args opens the menu):
  sb                      open the launcher menu (build / watch / panels)
  sb build | watch | express | upload | config | install | backups
                          open that leg/panel interactively

Non-interactive box control (flags; add --json for machine output):
  sb channel [latest|dev|test] [--yes]   show or flip the release channel
  sb config get [--json]                  read allow-listed config fields
  sb config set --key K --value V         write one config field
  sb stacks list [--json]                 list the stack catalog
  sb stacks install --stacks a,b [--var K=V ...] --yes
  sb stacks wipe --name NAME --yes        uninstall a (wipeable) stack
  sb install status [--json]              current install job
  sb install progress [--job ID] [--json] install progress snapshot
  sb install abort [--job ID] --yes       abort the running install
  sb backups list [--json]                list system backups
  sb backups create [--json]              take a system backup
  sb backups restore --file NAME --yes    restore a system backup
  sb boot usb-status [--json]             USB-boot readiness
  sb boot usb-enable --yes                set one-shot USB boot + reboot
  sb nas register --host H --user U --pass P   register the FritzBox NAS source
  sb token mint --user U --pass P [--json]     sign in + mint/save a scoped token
  sb token mint --parent T --scopes a,b --ttl 4h   delegate a scoped leaf child token
  sb token delegate --parent T --scopes a,b --ttl 4h   (alias for mint --parent)

Target + auth come from SB_HOST/SB_PORT (or build/fcos/install-settings.env)
and a saved token (or SB_TOKEN). Mint one with: sb token mint
`)
}
