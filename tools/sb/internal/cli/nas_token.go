package cli

import (
	"fmt"
	"os"
	"strings"
	"time"

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

// Token dispatches the `sb token …` group:
//
//	sb token mint --user U --pass P            sign in + mint/save a scoped token
//	sb token mint --parent T --scopes a,b --ttl 4h    delegate a scoped leaf child
//	sb token delegate --parent T --scopes a,b --ttl 4h   (alias for the above)
//
// `mint` with --parent (or any delegate flag) and the explicit `delegate` verb
// both route to tokenDelegate; bare `mint --user/--pass` is the admin sign-in.
func Token(args []string) int {
	if len(args) == 0 {
		return usageErr(os.Stderr, "usage: sb token mint --user U --pass P | sb token mint --parent T --scopes a,b --ttl 4h")
	}
	switch args[0] {
	case "delegate":
		return tokenDelegate(args[1:])
	case "mint":
		// Delegate mode when a parent credential or a delegate-only flag is given.
		for _, a := range args[1:] {
			if a == "--parent" || strings.HasPrefix(a, "--parent=") ||
				a == "--scopes" || strings.HasPrefix(a, "--scopes=") ||
				a == "--ttl" || strings.HasPrefix(a, "--ttl=") {
				return tokenDelegate(args[1:])
			}
		}
		return tokenMint(args[1:])
	default:
		return usageErr(os.Stderr, "usage: sb token mint … | sb token delegate …")
	}
}

// tokenMint implements `sb token mint --user U --pass P`: sign in with the box
// admin credentials, mint a scoped `sb_` token, and save it per-host so every
// later `sb` command reuses it. The non-interactive replacement for the TUI
// sign-in.
func tokenMint(args []string) int {
	fs := newFlags("token mint")
	user := fs.String("user", "", "box admin username")
	pass := fs.String("pass", "", "box admin password")
	jsonMode := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
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

// tokenDelegate implements `sb token mint --parent T --scopes a,b --ttl 4h`
// (and the `sb token delegate` alias): mint a short-lived, narrow-scope CHILD
// token from an existing parent token via POST /api/system/api-tokens/delegate
// (#2048). The box enforces scopes ⊆ parent and TTL ≤ parent — a super-scope or
// longer-TTL request is rejected and surfaced as an error. The minted child
// secret is printed (NOT saved); the caller owns revoking it when done.
func tokenDelegate(args []string) int {
	fs := newFlags("token delegate")
	parent := fs.String("parent", "", "raw parent sb_… token (default: SB_TOKEN)")
	scopes := fs.String("scopes", "", "comma-separated scope subset (e.g. read,lifecycle)")
	ttl := fs.String("ttl", "", "Go duration for the child TTL, e.g. 4h, 30m (≤ parent)")
	name := fs.String("name", "sb-delegate", "name the child token is created under")
	jsonMode := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	parentTok := *parent
	if parentTok == "" {
		parentTok = strings.TrimSpace(os.Getenv("SB_TOKEN"))
	}
	if parentTok == "" {
		return usageErr(os.Stderr, "token delegate: a parent token is required (--parent or SB_TOKEN)")
	}
	scopeList := splitCSV(*scopes)
	if len(scopeList) == 0 {
		return usageErr(os.Stderr, "token delegate: --scopes is required (comma-separated subset)")
	}
	var expiresAt string
	if *ttl != "" {
		d, err := time.ParseDuration(*ttl)
		if err != nil {
			return usageErr(os.Stderr, fmt.Sprintf("token delegate: invalid --ttl %q: %v", *ttl, err))
		}
		if d <= 0 {
			return usageErr(os.Stderr, "token delegate: --ttl must be positive")
		}
		expiresAt = time.Now().Add(d).UTC().Format(time.RFC3339)
	}
	t := probes.ResolveTarget()
	if t.Host == "" {
		fmt.Fprintln(os.Stderr, "no box target — set SB_HOST (and SB_PORT), or build an ISO first.")
		return 2
	}
	secret, err := rest.Delegate(ctx(), t.Host, t.Port, parentTok, *name, scopeList, expiresAt)
	if err != nil {
		return fail(err)
	}
	return emit(*jsonMode, map[string]string{"host": t.Host, "status": "delegated", "secret": secret}, func() {
		// Human mode prints the bare secret on its own line so it's pipe-friendly
		// (e.g. SB_TOKEN=$(sb token delegate …)); the caller must revoke it.
		fmt.Println(secret)
	})
}
