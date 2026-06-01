package probes

import "testing"

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
