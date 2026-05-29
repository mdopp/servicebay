package build

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseSettings(t *testing.T) {
	raw := strings.Join([]string{
		"# a comment",
		"",
		"SERVER_NAME=oscar",
		"HOST_USER=core",
		"STATIC_IP=192.168.178.100",
		"SERVICEBAY_PORT=5888",
		"PUBLIC_DOMAIN=home.example.com",
		"UNKNOWN_KEY=ignored",      // unknown → dropped
		"AUTH_SECRET=ab=cd+ef/gh=", // value with '=' and base64 chars survives
		"SSH_AUTHORIZED_KEY=ssh-ed25519 AAAA bob@host", // spaces survive
	}, "\n")

	s := ParseSettings(raw)
	if s.ServerName != "oscar" || s.HostUser != "core" || s.StaticIP != "192.168.178.100" {
		t.Fatalf("core fields wrong: %+v", s)
	}
	if s.AuthSecret != "ab=cd+ef/gh=" {
		t.Errorf("value with = not preserved verbatim: %q", s.AuthSecret)
	}
	if s.SSHAuthorizedKey != "ssh-ed25519 AAAA bob@host" {
		t.Errorf("ssh key with spaces not preserved: %q", s.SSHAuthorizedKey)
	}
}

func TestRoundTrip(t *testing.T) {
	s := Settings{
		ServerName:     "oscar",
		HostUser:       "core",
		StaticIP:       "10.0.0.5",
		ServicebayPort: "5888",
		DNSServers:     "1.1.1.1,8.8.8.8",
	}
	got := ParseSettings(s.Render())
	if got != s {
		t.Fatalf("round-trip mismatch:\n in:  %+v\n out: %+v", s, got)
	}
}

func TestRenderOrderAndEmpties(t *testing.T) {
	out := Settings{ServerName: "x"}.Render()
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 24 {
		t.Fatalf("expected 24 keys, got %d", len(lines))
	}
	if lines[0] != "SERVER_NAME=x" {
		t.Errorf("first line should be SERVER_NAME: %q", lines[0])
	}
	if lines[len(lines)-1] != "AUTH_SECRET=" {
		t.Errorf("last line should be empty AUTH_SECRET=: %q", lines[len(lines)-1])
	}
	if !strings.Contains(out, "HOST_USER=\n") {
		t.Error("empty field should render KEY= (not bare KEY)")
	}
}

func TestLoadMissingFileIsZero(t *testing.T) {
	s, err := Load(filepath.Join(t.TempDir(), "does-not-exist.env"))
	if err != nil {
		t.Fatalf("missing file should not error: %v", err)
	}
	if s != (Settings{}) {
		t.Errorf("missing file should yield zero Settings, got %+v", s)
	}
}

func TestSaveLoadFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install-settings.env")
	want := Settings{ServerName: "oscar", HostUser: "core", StaticIP: "10.0.0.9", ServicebayPort: "5888"}
	if err := want.Save(path); err != nil {
		t.Fatalf("save: %v", err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("settings file should be 0600, got %v", fi.Mode().Perm())
	}
	got, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got != want {
		t.Errorf("load mismatch:\n want %+v\n got  %+v", want, got)
	}
}

func TestWithDefaults(t *testing.T) {
	d := Settings{}.WithDefaults()
	if d.HostUser != DefaultHostUser || d.ServicebayPort != DefaultPort {
		t.Fatalf("defaults not applied: %+v", d)
	}
	// Non-empty values are preserved.
	keep := Settings{HostUser: "admin", ServicebayPort: "9999"}.WithDefaults()
	if keep.HostUser != "admin" || keep.ServicebayPort != "9999" {
		t.Errorf("defaults overrode set values: %+v", keep)
	}
}

func TestTarget(t *testing.T) {
	h, p := Settings{StaticIP: "10.0.0.5", ServicebayPort: "8080"}.Target()
	if h != "10.0.0.5" || p != "8080" {
		t.Errorf("target wrong: %s:%s", h, p)
	}
	// Empty port falls back to default; empty IP stays empty.
	h, p = Settings{}.Target()
	if h != "" || p != DefaultPort {
		t.Errorf("target fallback wrong: %q:%q", h, p)
	}
}
