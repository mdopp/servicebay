package build

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

// seqReader yields bytes 0,1,2,... so generated secrets are deterministic and
// the three draws (admin/host/token) differ from each other.
func seqBytes(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i)
	}
	return b
}

func TestGenerateSecrets_AllGenerated(t *testing.T) {
	const passphraseBytes = 5 // Passphrase consumes 4 word bytes + 1 number byte
	seq := seqBytes(secretHexBytes + passphraseBytes + tokenHexBytes)
	s, err := GenerateSecrets(SecretInputs{}, bytes.NewReader(seq))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Admin = strong hex; host = memorable passphrase; token = hex after both.
	wantAdmin := hex.EncodeToString(seq[:secretHexBytes])
	wantHost, _ := Passphrase(bytes.NewReader(seq[secretHexBytes : secretHexBytes+passphraseBytes]))
	wantToken := hex.EncodeToString(seq[secretHexBytes+passphraseBytes:])
	if s.AdminPassword != wantAdmin || !s.AdminGenerated {
		t.Errorf("admin = %q gen=%v, want %q gen=true", s.AdminPassword, s.AdminGenerated, wantAdmin)
	}
	if s.HostPassword != wantHost || !s.HostGenerated {
		t.Errorf("host = %q gen=%v, want %q gen=true", s.HostPassword, s.HostGenerated, wantHost)
	}
	if !strings.Contains(s.HostPassword, "-") || strings.ToLower(s.HostPassword) != s.HostPassword {
		t.Errorf("host password %q is not a memorable lowercase passphrase", s.HostPassword)
	}
	if s.BootstrapToken != wantToken || !s.BootstrapGenerated {
		t.Errorf("token = %q gen=%v, want %q gen=true", s.BootstrapToken, s.BootstrapGenerated, wantToken)
	}
	if len(s.AdminPassword) != secretHexBytes*2 || len(s.BootstrapToken) != tokenHexBytes*2 {
		t.Errorf("unexpected hex lengths: admin=%d token=%d", len(s.AdminPassword), len(s.BootstrapToken))
	}
	sum := sha256.Sum256([]byte(wantToken))
	if s.BootstrapTokenHash != hex.EncodeToString(sum[:]) {
		t.Errorf("token hash = %q, want sha256 of token", s.BootstrapTokenHash)
	}
}

func TestGenerateSecrets_PreseedWins(t *testing.T) {
	in := SecretInputs{AdminPassword: "pinned-admin", HostPassword: "pinned-host"}
	s, err := GenerateSecrets(in, bytes.NewReader(seqBytes(tokenHexBytes)))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.AdminPassword != "pinned-admin" || s.AdminGenerated {
		t.Errorf("admin = %q gen=%v, want pinned not generated", s.AdminPassword, s.AdminGenerated)
	}
	if s.HostPassword != "pinned-host" || s.HostGenerated {
		t.Errorf("host = %q gen=%v, want pinned not generated", s.HostPassword, s.HostGenerated)
	}
	// token still minted from the reader (no pre-seed)
	if !s.BootstrapGenerated || s.BootstrapToken == "" {
		t.Errorf("token should still be generated when only passwords pre-seeded")
	}
}

func TestGenerateSecrets_PreseedPipelineUnsafe(t *testing.T) {
	for _, bad := range []string{"has\nnewline", `has"quote`, `back\slash`, "dollar$", "tick`"} {
		_, err := GenerateSecrets(SecretInputs{AdminPassword: bad}, bytes.NewReader(seqBytes(64)))
		if err == nil {
			t.Errorf("expected error for unsafe pre-seed %q", bad)
		}
	}
}

func TestGenerateSecrets_NoBootstrapToken(t *testing.T) {
	s, err := GenerateSecrets(SecretInputs{NoBootstrapToken: true}, bytes.NewReader(seqBytes(secretHexBytes*2)))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.BootstrapToken != "" || s.BootstrapTokenHash != "" || s.BootstrapGenerated {
		t.Errorf("SB_NO_BOOTSTRAP_TOKEN should leave the token empty, got %q/%q gen=%v",
			s.BootstrapToken, s.BootstrapTokenHash, s.BootstrapGenerated)
	}
}

func TestGenerateSecrets_PreseedBootstrapToken(t *testing.T) {
	s, err := GenerateSecrets(SecretInputs{BootstrapToken: "pinned-token"}, bytes.NewReader(seqBytes(secretHexBytes*2)))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.BootstrapToken != "pinned-token" || s.BootstrapGenerated {
		t.Errorf("token = %q gen=%v, want pinned not generated", s.BootstrapToken, s.BootstrapGenerated)
	}
	sum := sha256.Sum256([]byte("pinned-token"))
	if s.BootstrapTokenHash != hex.EncodeToString(sum[:]) {
		t.Errorf("hash mismatch for pre-seeded token")
	}
}

func TestGenerateSecrets_ShortReader(t *testing.T) {
	_, err := GenerateSecrets(SecretInputs{}, bytes.NewReader(seqBytes(10)))
	if err == nil {
		t.Error("expected error when the random source is exhausted")
	}
}

func TestSecrets_BitwardenCSV_Golden(t *testing.T) {
	s := Secrets{
		AdminPassword: "adminpw", AdminGenerated: true,
		HostPassword: "hostpw", HostGenerated: true,
		BootstrapToken: "tok123", BootstrapGenerated: true,
	}
	ctx := CredentialContext{ServerName: "OSCAR", AdminUser: "admin", HostUser: "core", IP: "192.168.178.100", Port: "5888"}
	got := s.BitwardenCSV(ctx)
	want := strings.Join([]string{
		bitwardenHeader,
		`,,login,"ServiceBay Admin — OSCAR","ServiceBay web admin login.",,0,"http://192.168.178.100:5888","admin","adminpw",`,
		`,,login,"ServiceBay Host console — OSCAR","Console / SSH login for the Fedora CoreOS host user.",,0,"ssh://192.168.178.100","core","hostpw",`,
		`,,login,"ServiceBay MCP bootstrap token — OSCAR","Read-only, LAN-only, 30 minutes from first boot.",,0,"http://192.168.178.100:5888","","tok123",`,
		"",
	}, "\n")
	if got != want {
		t.Errorf("CSV mismatch:\n got: %q\nwant: %q", got, want)
	}
}

func TestSecrets_BitwardenCSV_OmitsPreseeded(t *testing.T) {
	// admin pre-seeded (not generated) → must not appear; only host generated.
	s := Secrets{
		AdminPassword: "preadmin", AdminGenerated: false,
		HostPassword: "hostpw", HostGenerated: true,
	}
	got := s.BitwardenCSV(CredentialContext{})
	if strings.Contains(got, "preadmin") || strings.Contains(got, "ServiceBay Admin") {
		t.Errorf("pre-seeded admin leaked into CSV:\n%s", got)
	}
	if !strings.Contains(got, "Host console") || !strings.Contains(got, "hostpw") {
		t.Errorf("generated host missing from CSV:\n%s", got)
	}
}

func TestSecrets_BitwardenCSV_EmptyWhenNothingGenerated(t *testing.T) {
	s := Secrets{AdminPassword: "pre", HostPassword: "pre", BootstrapToken: "pre"} // all pre-seeded
	if got := s.BitwardenCSV(CredentialContext{}); got != "" {
		t.Errorf("expected empty CSV when nothing generated, got %q", got)
	}
	if s.AnyGenerated() {
		t.Error("AnyGenerated should be false when all pre-seeded")
	}
}

func TestCSVField_QuotesEmbeddedQuotes(t *testing.T) {
	if got := csvField(`a"b`); got != `"a""b"` {
		t.Errorf("csvField = %q, want %q", got, `"a""b"`)
	}
}

func TestSecrets_Summary(t *testing.T) {
	none := Secrets{AdminPassword: "pre"} // pre-seeded, nothing generated
	if none.Summary(CredentialContext{}) != "" {
		t.Error("summary should be empty when nothing generated")
	}
	s := Secrets{AdminPassword: "adminpw", AdminGenerated: true}
	out := s.Summary(CredentialContext{AdminUser: "admin", IP: "10.0.0.1", Port: "5888"})
	if !strings.Contains(out, "adminpw") || !strings.Contains(out, "SAVE THESE CREDENTIALS NOW") {
		t.Errorf("summary missing content:\n%s", out)
	}
}
