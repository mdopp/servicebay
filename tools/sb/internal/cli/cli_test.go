package cli

import "testing"

func TestSplitCSV(t *testing.T) {
	got := splitCSV(" media , auth ,, ai ")
	want := []string{"media", "auth", "ai"}
	if len(got) != len(want) {
		t.Fatalf("splitCSV len = %d, want %d (%v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("splitCSV[%d] = %q, want %q", i, got[i], want[i])
		}
	}
	if len(splitCSV("")) != 0 {
		t.Errorf("splitCSV(\"\") should be empty")
	}
}

func TestValidChannel(t *testing.T) {
	for _, c := range []string{"latest", "dev", "test"} {
		if !validChannel(c) {
			t.Errorf("validChannel(%q) = false, want true", c)
		}
	}
	if validChannel("prod") {
		t.Errorf("validChannel(\"prod\") = true, want false")
	}
}

func TestKVFlagSet(t *testing.T) {
	k := kvFlag{}
	if err := k.Set("PUBLIC_DOMAIN=example.com"); err != nil {
		t.Fatalf("Set valid: %v", err)
	}
	if k["PUBLIC_DOMAIN"] != "example.com" {
		t.Errorf("kvFlag = %v, want PUBLIC_DOMAIN=example.com", k)
	}
	if err := k.Set("VALUE=a=b"); err != nil { // value may contain '='
		t.Fatalf("Set value-with-eq: %v", err)
	}
	if k["VALUE"] != "a=b" {
		t.Errorf("kvFlag VALUE = %q, want a=b", k["VALUE"])
	}
	if err := k.Set("noequals"); err == nil {
		t.Errorf("Set(%q) should error", "noequals")
	}
}

func TestRequireYes(t *testing.T) {
	if requireYes(true, "x") != 0 {
		t.Errorf("requireYes(true) should be 0")
	}
	if requireYes(false, "x") != 2 {
		t.Errorf("requireYes(false) should be 2")
	}
}

// Destructive commands must refuse without --yes BEFORE touching the network,
// so these run hermetically (no box) and must all return exit code 2.
func TestDestructiveGateWithoutYes(t *testing.T) {
	cases := []struct {
		name string
		run  func() int
	}{
		{"channel flip", func() int { return Channel([]string{"dev"}) }},
		{"stacks install", func() int { return Stacks([]string{"install", "--stacks", "media"}) }},
		{"stacks wipe", func() int { return Stacks([]string{"wipe", "--name", "media"}) }},
		{"install abort", func() int { return Install([]string{"abort"}) }},
		{"backups restore", func() int { return Backups([]string{"restore", "--file", "x.tar"}) }},
		{"boot usb-enable", func() int { return Boot([]string{"usb-enable"}) }},
	}
	for _, c := range cases {
		if code := c.run(); code != 2 {
			t.Errorf("%s without --yes: exit = %d, want 2", c.name, code)
		}
	}
}

// TestTokenDelegateValidation: the `sb token mint --parent …` / `sb token
// delegate …` surface validates its flags BEFORE any network call, so these run
// hermetically (no box) and must all return exit code 2. SB_TOKEN is cleared so
// the parent-from-env fallback doesn't accidentally satisfy a "missing parent"
// case.
func TestTokenDelegateValidation(t *testing.T) {
	t.Setenv("SB_TOKEN", "")
	cases := []struct {
		name string
		args []string
	}{
		// --parent routes to delegate mode; --scopes is required.
		{"mint parent without scopes", []string{"mint", "--parent", "sb_p", "--ttl", "4h"}},
		// delegate verb with no parent and no SB_TOKEN.
		{"delegate without parent", []string{"delegate", "--scopes", "read"}},
		// invalid Go duration.
		{"delegate bad ttl", []string{"delegate", "--parent", "sb_p", "--scopes", "read", "--ttl", "soon"}},
		// non-positive ttl.
		{"delegate zero ttl", []string{"delegate", "--parent", "sb_p", "--scopes", "read", "--ttl", "0s"}},
	}
	for _, c := range cases {
		if code := Token(c.args); code != 2 {
			t.Errorf("%s: exit = %d, want 2", c.name, code)
		}
	}
}

// TestTokenDelegateRouting: `token mint` with a delegate-only flag routes to the
// delegate path (which then fails validation at exit 2), while bare `token mint`
// without --user/--pass is the admin sign-in path (also exit 2 on missing creds)
// — both hermetic, no box.
func TestTokenDelegateRouting(t *testing.T) {
	t.Setenv("SB_TOKEN", "")
	if code := Token([]string{"mint", "--scopes", "read"}); code != 2 {
		t.Errorf("mint --scopes (delegate route, missing parent): exit = %d, want 2", code)
	}
	if code := Token([]string{"mint"}); code != 2 {
		t.Errorf("bare mint (admin route, missing creds): exit = %d, want 2", code)
	}
}

func TestUnknownSubcommandUsage(t *testing.T) {
	cases := []struct {
		name string
		run  func() int
	}{
		{"channel bogus", func() int { return Channel([]string{"bogus"}) }}, // invalid channel name
		{"config bogus", func() int { return Config([]string{"bogus"}) }},
		{"stacks empty", func() int { return Stacks(nil) }},
		{"install empty", func() int { return Install(nil) }},
		{"backups empty", func() int { return Backups(nil) }},
		{"boot empty", func() int { return Boot(nil) }},
		{"nas empty", func() int { return Nas(nil) }},
		{"token empty", func() int { return Token(nil) }},
	}
	for _, c := range cases {
		if code := c.run(); code != 2 {
			t.Errorf("%s: exit = %d, want 2", c.name, code)
		}
	}
}
