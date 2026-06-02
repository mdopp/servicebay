package buildflow

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"sb/internal/build"
	"sb/internal/iso"
	"sb/internal/usb"
)

// scriptPrompter replays a fixed list of answers in order.
type scriptPrompter struct {
	answers []string
	i       int
}

func (s *scriptPrompter) next() string {
	if s.i >= len(s.answers) {
		return ""
	}
	v := s.answers[s.i]
	s.i++
	return v
}
func (s *scriptPrompter) Prompt(label, def string) string {
	v := s.next()
	if v == "" {
		return def
	}
	return v
}
func (s *scriptPrompter) PromptSecret(label string) string { return s.next() }
func (s *scriptPrompter) Confirm(label string, defYes bool) bool {
	v := s.next()
	if v == "" {
		return defYes
	}
	return strings.HasPrefix(strings.ToLower(v), "y")
}
func (s *scriptPrompter) Printf(format string, a ...any) {}

type recorder struct {
	baked   build.ISOBuildInputs
	flashed string
	flashTo string
}

func fakeDeps(srcISO string, rec *recorder) Deps {
	return Deps{
		Rand:     bytes.NewReader(bytes.Repeat([]byte{7}, 256)),
		HostArch: func() string { return "x86_64" },
		FetchStreams: func(context.Context) []iso.StreamImages {
			return []iso.StreamImages{{Stream: "stable", Images: []iso.StreamImage{{Arch: "x86_64", Release: "40.1", Location: "u"}}}}
		},
		ListLocal: func(dirs []string) []iso.LocalISO {
			return []iso.LocalISO{{Path: srcISO, Name: "local.iso", Date: "2026-05-29"}}
		},
		Download: func(ctx context.Context, stream, arch, buildDir string) (string, error) {
			return "/downloaded.iso", nil
		},
		Bake: func(in build.ISOBuildInputs, outDir string) (string, error) {
			rec.baked = in
			return filepath.Join(outDir, "fedora-coreos-custom.iso"), nil
		},
		Enumerate: func() ([]usb.Device, error) {
			return []usb.Device{{Path: "/dev/sdf", SizeBytes: 60 << 30, Model: "Stick"}}, nil
		},
		Flash: func(isoPath, device string) error { rec.flashed = isoPath; rec.flashTo = device; return nil },
	}
}

func TestRun_FreshSettings_PicksLocal_Flashes(t *testing.T) {
	dir := t.TempDir()
	srcISO := filepath.Join(dir, "local.iso")
	if err := os.WriteFile(srcISO, []byte("iso"), 0o644); err != nil {
		t.Fatal(err)
	}
	var rec recorder
	d := fakeDeps(srcISO, &rec)

	// No saved settings -> gatherSettings runs. Answers in prompt order:
	a := []string{
		"oscar",             // server name
		"core",              // host user
		"ssh-ed25519 KEY x", // ssh key
		"eth0",              // net interface
		"192.168.178.50",    // static ip
		"24",                // prefix
		"192.168.178.1",     // gateway
		"192.168.178.1",     // dns
		"5888",              // port
		"stable",            // channel
		"admin",             // admin user
		"",                  // public domain (skip)
		"",                  // fritzbox host (skip)
		"Y",                 // registries
		"N",                 // oscar registry
		"N",                 // email
		"1",                 // pick local ISO
		"1",                 // pick /dev/sdf
		"YES",               // confirm flash
	}
	p := &scriptPrompter{answers: a}
	if err := Run(p, Options{BuildDir: dir, Deps: d}); err != nil {
		t.Fatalf("Run: %v", err)
	}

	saved, err := build.Load(filepath.Join(dir, "install-settings.env"))
	if err != nil || saved.ServerName != "oscar" || saved.StaticIP != "192.168.178.50" {
		t.Fatalf("settings not saved correctly: %+v err=%v", saved, err)
	}
	if rec.baked.SourceISO != srcISO {
		t.Errorf("baked source = %q, want %q", rec.baked.SourceISO, srcISO)
	}
	if !rec.baked.Secrets.AdminGenerated || rec.baked.Secrets.AdminPassword == "" {
		t.Error("admin secret should have been generated")
	}
	if rec.flashTo != "/dev/sdf" || !strings.HasSuffix(rec.flashed, "fedora-coreos-custom.iso") {
		t.Errorf("flash call wrong: to=%q iso=%q", rec.flashTo, rec.flashed)
	}
}

func TestRun_AcceptsSavedSettings_SkipsFlash(t *testing.T) {
	dir := t.TempDir()
	srcISO := filepath.Join(dir, "local.iso")
	if err := os.WriteFile(srcISO, []byte("iso"), 0o644); err != nil {
		t.Fatal(err)
	}
	saved := build.Settings{ServerName: "box", HostUser: "core", StaticIP: "10.0.0.2", ServicebayPort: "5888", ServicebayAdminUser: "admin", ServicebayChannel: "stable"}
	if err := saved.Save(filepath.Join(dir, "install-settings.env")); err != nil {
		t.Fatal(err)
	}
	var rec recorder
	d := fakeDeps(srcISO, &rec)

	p := &scriptPrompter{answers: []string{"y", "1", "0"}} // accept saved, pick local, skip flash
	if err := Run(p, Options{BuildDir: dir, Deps: d}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if rec.baked.Settings.ServerName != "box" {
		t.Errorf("should have used saved settings, got %q", rec.baked.Settings.ServerName)
	}
	if rec.flashTo != "" {
		t.Errorf("flash should have been skipped, got %q", rec.flashTo)
	}
}

func TestRun_NoISOChoices_Errors(t *testing.T) {
	dir := t.TempDir()
	var rec recorder
	d := fakeDeps("", &rec)
	d.ListLocal = func(dirs []string) []iso.LocalISO { return nil }
	d.FetchStreams = func(context.Context) []iso.StreamImages { return nil }

	saved := build.Settings{ServerName: "box", ServicebayAdminUser: "admin", ServicebayChannel: "stable"}
	if err := saved.Save(filepath.Join(dir, "install-settings.env")); err != nil {
		t.Fatal(err)
	}
	p := &scriptPrompter{answers: []string{"y"}}
	err := Run(p, Options{BuildDir: dir, Deps: d})
	if err == nil || !strings.Contains(err.Error(), "no local ISOs") {
		t.Fatalf("expected no-ISO error, got %v", err)
	}
}

func TestExternalSecret_PipelineUnsafePreseed(t *testing.T) {
	t.Setenv("GW_PASS", "bad\"quote")
	p := &scriptPrompter{}
	if _, err := externalSecret(p, "GW_PASS", "Gateway password", true); err == nil {
		t.Error("expected pipeline-unsafe pre-seed to error")
	}
}

func TestExternalSecret_NotNeeded(t *testing.T) {
	p := &scriptPrompter{}
	v, err := externalSecret(p, "GW_PASS", "x", false)
	if err != nil || v != "" {
		t.Errorf("not-needed secret should be empty, got %q err=%v", v, err)
	}
}
