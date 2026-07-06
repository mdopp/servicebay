package build

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// shellQuote wraps s in single quotes, escaping any embedded single quote,
// so an arbitrary filesystem path (e.g. a t.TempDir() that embeds a subtest
// name with shell metacharacters like parens) is safe to splice into a
// `bash -c` script as a literal.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func TestSubstituteAllowed_Forms(t *testing.T) {
	allow := map[string]bool{"FOO": true, "BAR": true}
	vals := map[string]string{"FOO": "foo-val", "BAR": "bar-val"}
	cases := []struct{ in, want string }{
		{"${FOO}", "foo-val"},                  // braced, allowlisted
		{"$FOO", "foo-val"},                    // bare, allowlisted
		{"x${FOO}y$BAR.", "xfoo-valybar-val."}, // mixed
		{"${RAID_DISK}", "${RAID_DISK}"},       // braced, NOT allowlisted -> literal
		{"$RAID_DISK", "$RAID_DISK"},           // bare, NOT allowlisted -> literal
		{`$$SECRET`, `$$SECRET`},               // $$ escape + non-allowlisted name
		{"price is $5", "price is $5"},         // $ not a ref
		{"${FOO", "${FOO"},                     // unterminated brace -> literal
		{"${}", "${}"},                         // empty name -> literal
		{"$FOO_BAR", "$FOO_BAR"},               // FOO_BAR not allowlisted (longest ident)
		{"trailing $", "trailing $"},           // bare $ at EOF
	}
	for _, c := range cases {
		if got := substituteAllowed(c.in, allow, vals); got != c.want {
			t.Errorf("substituteAllowed(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestSubstituteAllowed_UnsetIsEmpty(t *testing.T) {
	// allowlisted but absent from vals -> empty (matches envsubst).
	got := substituteAllowed("a${FOO}b", map[string]bool{"FOO": true}, map[string]string{})
	if got != "ab" {
		t.Errorf("unset allowlisted var should render empty, got %q", got)
	}
}

func TestIndentLines(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", ""},
		{"a", "  a"},
		{"a\nb", "  a\n  b"},
		{"a\nb\n", "  a\n  b\n"},   // trailing newline: no phantom prefixed line
		{"a\n\nb", "  a\n  \n  b"}, // empty middle line still prefixed
	}
	for _, c := range cases {
		if got := indentLines(c.in, "  "); got != c.want {
			t.Errorf("indentLines(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestVersionFromChannel(t *testing.T) {
	for ch, want := range map[string]string{"test": "test", "dev": "dev", "stable": "latest", "": "latest"} {
		if got := VersionFromChannel(ch); got != want {
			t.Errorf("VersionFromChannel(%q) = %q, want %q", ch, got, want)
		}
	}
}

func TestRenderButane_SubstitutesAndPreserves(t *testing.T) {
	in := RenderInputs{
		Settings: Settings{
			ServerName:          "OSCAR",
			HostUser:            "core",
			ServicebayChannel:   "stable",
			ServicebayAdminUser: "admin",
			ServicebayPort:      "5888",
		},
		Secrets:      Secrets{AdminPassword: "adminpw"},
		PasswordHash: "$6$salt$hash",
		SSHPublic:    "ssh-rsa AAAApub host\n",
		SSHPrivate:   "-----BEGIN-----\nkeyline\n-----END-----\n",
		ConfigJSON:   "{\n  \"serverName\": \"OSCAR\"\n}",
	}
	out := in.Butane()
	// Build-time vars substituted.
	if !strings.Contains(out, "ghcr.io/mdopp/servicebay:latest") {
		t.Error("SERVICEBAY_VERSION not substituted to 'latest'")
	}
	if strings.Contains(out, "${SERVER_NAME}") || strings.Contains(out, "${SERVICEBAY_PORT}") {
		t.Error("build-time placeholders left unsubstituted")
	}
	// Runtime shell vars preserved (NOT in the allowlist).
	for _, lit := range []string{"${RAID_DISK}", "${API_WAIT}", "${INSTALLED_WAIT}"} {
		if !strings.Contains(out, lit) {
			t.Errorf("runtime shell var %s should be left literal", lit)
		}
	}
	// SSH public key (single-line, trimmed) present.
	if !strings.Contains(out, "ssh-rsa AAAApub host") {
		t.Error("SSH public key not substituted")
	}
	// config.json indented 10 spaces under its inline-block key.
	if !strings.Contains(out, yamlInlineIndent+`"serverName": "OSCAR"`) {
		t.Error("config.json not indented to the inline-block column")
	}
}

// The servicebay.container quadlet must wire the out-of-band crash breadcrumb
// (#2159): an ExecStartPre relabel/permission self-heal and an ExecStopPost
// breadcrumb writer, plus the two helper scripts they invoke. A missing hook
// makes servicebay's own crash-loop invisible again.
func TestRenderButane_CrashBreadcrumbWiring(t *testing.T) {
	out := RenderInputs{
		Settings: Settings{ServerName: "OSCAR", HostUser: "core", ServicebayChannel: "stable", ServicebayPort: "5888"},
	}.Butane()

	wiring := []string{
		// ExecStartPre self-heal for the relabel/permission failure class.
		"ExecStartPre=-/bin/bash /usr/local/bin/servicebay-relabel-selfheal.sh",
		// ExecStopPost out-of-band breadcrumb writer.
		"ExecStopPost=-/bin/bash /usr/local/bin/servicebay-crash-breadcrumb.sh",
		// The helper scripts themselves are shipped.
		"path: /usr/local/bin/servicebay-relabel-selfheal.sh",
		"path: /usr/local/bin/servicebay-crash-breadcrumb.sh",
	}
	for _, w := range wiring {
		if !strings.Contains(out, w) {
			t.Errorf("servicebay.container is missing crash-breadcrumb wiring: %q", w)
		}
	}

	// The breadcrumb file lands in the data dir (survives the container being
	// down) and the writer only fires on an abnormal stop.
	if !strings.Contains(out, "${DATA_ROOT}/servicebay/last-crash.json") &&
		!strings.Contains(out, "/servicebay/last-crash.json") {
		t.Error("breadcrumb writer should target <data-dir>/last-crash.json")
	}
	if !strings.Contains(out, `[ "$RESULT" = "success" ]`) {
		t.Error("breadcrumb writer should skip clean (SERVICE_RESULT=success) stops")
	}
	// The self-heal names the *.bak-verify* stray class explicitly.
	if !strings.Contains(out, "*.bak-verify*") {
		t.Error("relabel self-heal should name the *.bak-verify* stray class")
	}
}

func TestRenderButane_FactoryFresh(t *testing.T) {
	base := RenderInputs{Settings: Settings{ServerName: "OSCAR", HostUser: "core", ServicebayChannel: "stable"}}

	// Default (unset) renders as the safe "off" and leaves no placeholder.
	off := base.Butane()
	if strings.Contains(off, "${FACTORY_FRESH}") {
		t.Error("FACTORY_FRESH placeholder left unsubstituted")
	}
	if !strings.Contains(off, `"off" == "wipe-all-data"`) {
		t.Error("default factory-fresh should render the literal off into the guard")
	}

	// Chosen level is baked into the install-time guard.
	in := base
	in.Settings.FactoryFresh = "wipe-configs"
	if got := in.Butane(); !strings.Contains(got, `"wipe-configs" == "wipe-configs"`) {
		t.Error("wipe-configs not substituted into the setup-raid guard")
	}
}

// TestRenderButane_MdadmConfIdempotent guards #1666: setup-raid.sh must NOT
// blind-append the mdadm scan to /etc/mdadm.conf. A `>>` append wrote a second
// identical ARRAY line on every reinstall, and a duplicate ARRAY name aborts the
// next assembly ("Duplicate MD device names in conf file") → the data RAID never
// assembles → var-mnt-data.mount fails → the box bricks on reinstall. The conf
// must be rewritten fresh each run (truncating `>`) from a de-duplicated scan.
func TestRenderButane_MdadmConfIdempotent(t *testing.T) {
	out := RenderInputs{Settings: Settings{ServerName: "OSCAR", HostUser: "core", ServicebayChannel: "stable"}}.Butane()

	// The bricking regression: no executable line may append to the conf. Scan
	// line-by-line, ignoring comments (the fix references the old `>>` form in an
	// explanatory comment).
	for _, ln := range strings.Split(out, "\n") {
		trimmed := strings.TrimSpace(ln)
		if strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.Contains(trimmed, ">> /etc/mdadm.conf") {
			t.Errorf("setup-raid.sh blind-appends to /etc/mdadm.conf — #1666 duplicate-ARRAY brick: %q", trimmed)
		}
	}
	// The fix: rewrite the conf fresh (truncating redirect) with a dedup of the scan.
	if !strings.Contains(out, "} > /etc/mdadm.conf") {
		t.Error("mdadm.conf is not rewritten fresh (truncating `> /etc/mdadm.conf`) — #1666")
	}
	if !strings.Contains(out, "mdadm --detail --scan | sort -u") {
		t.Error("mdadm scan is not de-duplicated (`| sort -u`) before persisting — #1666")
	}
}

// TestSetupRaid_MdadmPersistRerunSingleArray simulates a re-run/reinstall of the
// conf-persistence step and asserts /etc/mdadm.conf ends with exactly ONE ARRAY
// line, proving the fix is idempotent (the old `>>` append produced two). It runs
// the actual shell idiom extracted from the rendered Butane against a stub `mdadm`
// so the test exercises the real script text, not a copy.
func TestSetupRaid_MdadmPersistRerunSingleArray(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not available")
	}
	out := RenderInputs{Settings: Settings{ServerName: "OSCAR", HostUser: "core", ServicebayChannel: "stable"}}.Butane()

	// Extract the persistence idiom (the `{ ... } > /etc/mdadm.conf` block) from
	// the rendered script so we test the shipped text.
	const marker = "} > /etc/mdadm.conf"
	end := strings.Index(out, marker)
	if end == -1 {
		t.Fatal("persistence block not found in rendered Butane")
	}
	start := strings.LastIndex(out[:end], "{")
	if start == -1 {
		t.Fatal("opening brace of persistence block not found")
	}
	block := strings.TrimSpace(out[start : end+len(marker)])
	// Butane indents inline-script lines; strip the common leading whitespace so
	// the snippet is runnable bash. Also retarget the conf path into a tmpdir.
	dir := t.TempDir()
	conf := filepath.Join(dir, "mdadm.conf")
	var lines []string
	for _, ln := range strings.Split(block, "\n") {
		lines = append(lines, strings.TrimSpace(ln))
	}
	snippet := strings.Join(lines, "\n")
	snippet = strings.ReplaceAll(snippet, "/etc/mdadm.conf", conf)

	// Stub `mdadm`: emit a single deterministic ARRAY line for `--detail --scan`.
	stub := filepath.Join(dir, "mdadm")
	stubBody := "#!/usr/bin/env bash\n" +
		"if [[ \"$1\" == \"--detail\" && \"$2\" == \"--scan\" ]]; then\n" +
		"  echo 'ARRAY /dev/md/data metadata=1.2 name=any:data UUID=deadbeef:deadbeef:deadbeef:deadbeef'\n" +
		"fi\n"
	if err := os.WriteFile(stub, []byte(stubBody), 0o755); err != nil {
		t.Fatal(err)
	}

	// Run the persistence idiom twice (initial install + reinstall/re-run).
	script := "set -euo pipefail\nexport PATH=" + shellQuote(dir) + ":\"$PATH\"\n" + snippet + "\n" + snippet + "\n"
	cmd := exec.Command("bash", "-c", script)
	if combined, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("persistence snippet failed: %v\n%s", err, combined)
	}

	data, err := os.ReadFile(conf)
	if err != nil {
		t.Fatal(err)
	}
	got := 0
	for _, ln := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(strings.TrimSpace(ln), "ARRAY ") {
			got++
		}
	}
	if got != 1 {
		t.Errorf("after a simulated re-run, /etc/mdadm.conf has %d ARRAY lines, want exactly 1 (#1666)\nconf:\n%s", got, data)
	}
}

// TestSetupRaid_WipeConfigsPreservesKeysWhenEncConfig guards #1667: on a
// wipe-configs reinstall the per-box encryption keys (secret.key /
// .auth-secret.env) must be PRESERVED when there is preserved `enc:` config
// to decrypt (the FritzBox gateway password + every OIDC/SSO client secret),
// and only wiped on a genuinely-fresh box (no `enc:` config anywhere).
// Regenerating them while preserved enc: config exists orphans all SSO
// credentials — the root cause of the #1559 family. The test runs the real
// shell idiom extracted from the rendered Butane against two fixtures.
func TestSetupRaid_WipeConfigsPreservesKeysWhenEncConfig(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not available")
	}
	in := RenderInputs{Settings: Settings{ServerName: "OSCAR", HostUser: "core", ServicebayChannel: "stable"}}
	in.Settings.FactoryFresh = "wipe-configs"
	out := in.Butane()

	// Extract the `if [[ "wipe-configs" == "wipe-configs" ]]; then ... fi`
	// block (the rendered guard) so the test exercises the shipped text.
	const guard = `"wipe-configs" == "wipe-configs" ]]; then`
	gi := strings.Index(out, guard)
	if gi == -1 {
		t.Fatal("wipe-configs guard not found in rendered Butane")
	}
	start := strings.LastIndex(out[:gi], "if [[")
	if start == -1 {
		t.Fatal("opening 'if [[' of wipe-configs block not found")
	}
	// Find the matching closing `fi` after the guard.
	rest := out[gi:]
	fiRel := strings.Index(rest, "\n          fi")
	if fiRel == -1 {
		t.Fatal("closing fi of wipe-configs block not found")
	}
	block := out[start : gi+fiRel+len("\n          fi")]

	// De-indent to runnable bash.
	var lines []string
	for _, ln := range strings.Split(block, "\n") {
		lines = append(lines, strings.TrimSpace(ln))
	}
	snippet := strings.Join(lines, "\n")

	run := func(t *testing.T, configBody string, wantKeysKept bool) {
		t.Helper()
		dir := t.TempDir()
		sb := filepath.Join(dir, "servicebay")
		if err := os.MkdirAll(sb, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(sb, "config.json"), []byte(configBody), 0o600); err != nil {
			t.Fatal(err)
		}
		secretKey := filepath.Join(sb, "secret.key")
		authEnv := filepath.Join(sb, ".auth-secret.env")
		for _, p := range []string{secretKey, authEnv} {
			if err := os.WriteFile(p, []byte("seed"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		// MOUNT_POINT is the parent so $MOUNT_POINT/servicebay/... resolves.
		// Quote the path: t.TempDir() embeds the subtest name, which can
		// contain shell metacharacters like parens (e.g. "(no enc: config)").
		script := "set -uo pipefail\nMOUNT_POINT=" + shellQuote(dir) + "\n" + snippet + "\n"
		cmd := exec.Command("bash", "-c", script)
		if combined, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("wipe-configs snippet failed: %v\n%s", err, combined)
		}
		// config.json is always removed by wipe-configs.
		if _, err := os.Stat(filepath.Join(sb, "config.json")); !os.IsNotExist(err) {
			t.Error("wipe-configs should remove config.json")
		}
		_, keyErr := os.Stat(secretKey)
		_, authErr := os.Stat(authEnv)
		keysKept := keyErr == nil && authErr == nil
		if keysKept != wantKeysKept {
			t.Errorf("secret.key/.auth-secret.env kept=%v, want %v (#1667)", keysKept, wantKeysKept)
		}
	}

	t.Run("preserves keys when config carries enc: values", func(t *testing.T) {
		run(t, `{"gateway":{"password":"enc:v1:aa:bb:cc"},"reverseProxy":{"npm":{"password":"enc:v1:dd:ee:ff"}}}`, true)
	})
	t.Run("wipes keys on a fresh box (no enc: config)", func(t *testing.T) {
		run(t, `{"serverName":"OSCAR","publicDomain":"example.com"}`, false)
	})
}

func TestRenderPreInstall_OnlyServerName(t *testing.T) {
	in := RenderInputs{Settings: Settings{ServerName: "OSCAR"}}
	out := in.PreInstall()
	if !strings.Contains(out, `set-hostname "OSCAR"`) {
		t.Errorf("SERVER_NAME not substituted into pre-install header:\n%s", out[:200])
	}
	// The disk-select body's shell vars must survive.
	for _, lit := range []string{"${name}", "$BEST", "$dev"} {
		if !strings.Contains(out, lit) {
			t.Errorf("pre-install runtime shell var %s should be literal", lit)
		}
	}
}

func TestPostInstall_NonEmpty(t *testing.T) {
	if !strings.Contains(PostInstall(), "post-install") {
		t.Error("post-install script missing expected content")
	}
}
