package build

import (
	"strings"
	"testing"
)

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
