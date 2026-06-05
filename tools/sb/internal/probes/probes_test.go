package probes

import "testing"

// TestClassifyBoxStatus covers the #1669 fold: a 401 means reachable-but-stale
// (Unauthorized), never "not set up". A closed port stays unreachable; an OK or
// unknown auth result doesn't set Unauthorized.
func TestClassifyBoxStatus(t *testing.T) {
	cases := []struct {
		name       string
		tcpOpen    bool
		appServing bool
		auth       authStatus
		wantReach  bool
		wantDone   bool
		wantUnauth bool
	}{
		{"port closed", false, false, authUnknown, false, false, false},
		{"port closed ignores 401", false, false, authUnauthorized, false, false, false},
		{"installing splash, no token", true, false, authUnknown, true, false, false},
		{"real app serving, token ok", true, true, authOK, true, true, false},
		{"stale token 401, app sniff missed takeover", true, false, authUnauthorized, true, false, true},
		{"stale token 401 but app also serving", true, true, authUnauthorized, true, true, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := classifyBoxStatus(c.tcpOpen, c.appServing, c.auth)
			if got.Reachable != c.wantReach || got.WizardDone != c.wantDone || got.Unauthorized != c.wantUnauth {
				t.Fatalf("classifyBoxStatus = %+v, want reach=%v done=%v unauth=%v",
					got, c.wantReach, c.wantDone, c.wantUnauth)
			}
		})
	}
}

// TestTokenRoundTripAndDelete: SaveToken persists a per-host token that
// ResolveToken reads back, and DeleteToken removes it so ResolveToken then
// returns "" (the no-token path that re-triggers sign-in). #1502.
func TestTokenRoundTripAndDelete(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("SB_TOKEN", "") // env must not shadow the per-host file

	const host = "192.168.178.100"
	if err := SaveToken(host, "sb_minted"); err != nil {
		t.Fatalf("SaveToken: %v", err)
	}
	if got := ResolveToken(host); got != "sb_minted" {
		t.Fatalf("ResolveToken after save = %q, want sb_minted", got)
	}
	if err := DeleteToken(host); err != nil {
		t.Fatalf("DeleteToken: %v", err)
	}
	if got := ResolveToken(host); got != "" {
		t.Fatalf("ResolveToken after delete = %q, want empty", got)
	}
}

// TestDeleteTokenMissingIsNoError: deleting an absent token file is a no-op, not
// an error — re-auth shouldn't fail just because nothing was saved.
func TestDeleteTokenMissingIsNoError(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if err := DeleteToken("never-saved"); err != nil {
		t.Fatalf("DeleteToken on missing file: %v", err)
	}
}

// TestSBTokenEnvWinsOverFile: SB_TOKEN takes precedence over the persisted file
// (CI / power users) — and is unaffected by DeleteToken, which only touches the
// file.
func TestSBTokenEnvWinsOverFile(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("SB_TOKEN", "sb_env")
	if got := ResolveToken("box"); got != "sb_env" {
		t.Fatalf("ResolveToken = %q, want sb_env", got)
	}
}
