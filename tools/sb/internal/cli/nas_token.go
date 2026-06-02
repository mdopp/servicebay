package cli

import (
	"fmt"
	"os"

	"sb/internal/probes"
	"sb/internal/rest"
)

// Nas implements `sb nas register --host H --user U --pass P` — registers the
// FritzBox NAS as a backup source (config write via the scoped token).
func Nas(args []string) int {
	if len(args) == 0 || args[0] != "register" {
		return usageErr(os.Stderr, "usage: sb nas register --host H --user U --pass P")
	}
	fs := newFlags("nas register")
	host := fs.String("host", "", "FritzBox/NAS host")
	user := fs.String("user", "", "NAS (FTP) username")
	pass := fs.String("pass", "", "NAS (FTP) password")
	jsonMode := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args[1:]); err != nil {
		return 2
	}
	if *host == "" || *user == "" {
		return usageErr(os.Stderr, "nas register: --host and --user are required")
	}
	client, code := boxClient()
	if client == nil {
		return code
	}
	if err := client.RegisterNasSource(ctx(), *host, *user, *pass); err != nil {
		return fail(err)
	}
	return emit(*jsonMode, map[string]string{"host": *host, "status": "registered"}, func() {
		fmt.Printf("✓ registered NAS source %s\n", *host)
	})
}

// Token implements `sb token mint --user U --pass P`: sign in with the box admin
// credentials, mint a scoped `sb_` token, and save it per-host so every later
// `sb` command reuses it. The non-interactive replacement for the TUI sign-in.
func Token(args []string) int {
	if len(args) == 0 || args[0] != "mint" {
		return usageErr(os.Stderr, "usage: sb token mint --user U --pass P [--json]")
	}
	fs := newFlags("token mint")
	user := fs.String("user", "", "box admin username")
	pass := fs.String("pass", "", "box admin password")
	jsonMode := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args[1:]); err != nil {
		return 2
	}
	if *user == "" || *pass == "" {
		return usageErr(os.Stderr, "token mint: --user and --pass are required")
	}
	t := probes.ResolveTarget()
	if t.Host == "" {
		fmt.Fprintln(os.Stderr, "no box target — set SB_HOST (and SB_PORT), or build an ISO first.")
		return 2
	}
	token, err := rest.Login(ctx(), t.Host, t.Port, *user, *pass)
	if err != nil {
		return fail(err)
	}
	if err := probes.SaveToken(t.Host, token); err != nil {
		return fail(err)
	}
	return emit(*jsonMode, map[string]string{"host": t.Host, "status": "minted", "saved": "true"}, func() {
		fmt.Printf("✓ minted + saved a scoped token for %s\n", t.Host)
	})
}
