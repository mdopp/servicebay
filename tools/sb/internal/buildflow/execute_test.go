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
)

// execDeps is a minimal Deps for Execute: records the bake inputs + flash, and
// fakes download.
func execDeps(rec *recorder) Deps {
	return Deps{
		Rand:     bytes.NewReader(bytes.Repeat([]byte{7}, 256)),
		HostArch: func() string { return "x86_64" },
		Download: func(_ context.Context, stream, arch, dir string) (string, error) {
			return filepath.Join(dir, "downloaded-"+stream+"-"+arch+".iso"), nil
		},
		Bake: func(in build.ISOBuildInputs, outDir string) (string, error) {
			rec.baked = in
			return filepath.Join(outDir, "servicebay-custom.iso"), nil
		},
		Flash: func(isoPath, device string) error {
			rec.flashed = isoPath
			rec.flashTo = device
			return nil
		},
	}
}

func TestExecuteLocalImageNoFlash(t *testing.T) {
	dir := t.TempDir()
	rec := &recorder{}
	plan := Plan{
		Settings: build.Settings{ServerName: "box", ServicebayPort: "5888", ServicebayAdminUser: "admin"},
		Image:    iso.Choice{Kind: "local", Path: "/isos/fcos.iso"},
	}
	var log strings.Builder
	if err := Execute(plan, Options{BuildDir: dir, Deps: execDeps(rec)}, func(f string, a ...any) {
		log.WriteString(strings.TrimRight(f, "\n"))
	}); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if rec.baked.SourceISO != "/isos/fcos.iso" {
		t.Errorf("baked from %q, want the local path", rec.baked.SourceISO)
	}
	if rec.flashTo != "" {
		t.Errorf("should not flash when FlashTo empty, got %q", rec.flashTo)
	}
	if _, err := os.Stat(filepath.Join(dir, "install-settings.env")); err != nil {
		t.Errorf("settings not saved: %v", err)
	}
}

func TestExecuteRemoteImageDownloadsThenBakes(t *testing.T) {
	dir := t.TempDir()
	rec := &recorder{}
	plan := Plan{
		Settings: build.Settings{ServerName: "box", ServicebayPort: "5888"},
		Image:    iso.Choice{Kind: "remote", Stream: "stable", Arch: "x86_64"},
	}
	if err := Execute(plan, Options{BuildDir: dir, Deps: execDeps(rec)}, func(string, ...any) {}); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !strings.Contains(rec.baked.SourceISO, "downloaded-stable-x86_64.iso") {
		t.Errorf("expected a downloaded source ISO, got %q", rec.baked.SourceISO)
	}
}

func TestExecuteFlashesSelectedDevice(t *testing.T) {
	dir := t.TempDir()
	rec := &recorder{}
	plan := Plan{
		Settings: build.Settings{ServerName: "box", ServicebayPort: "5888"},
		Image:    iso.Choice{Kind: "local", Path: "/isos/fcos.iso"},
		FlashTo:  "/dev/sdz",
	}
	if err := Execute(plan, Options{BuildDir: dir, Deps: execDeps(rec)}, func(string, ...any) {}); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if rec.flashTo != "/dev/sdz" || !strings.HasSuffix(rec.flashed, "servicebay-custom.iso") {
		t.Errorf("flash = %q to %q", rec.flashed, rec.flashTo)
	}
}

func TestExecuteRejectsEmptyLocalImage(t *testing.T) {
	rec := &recorder{}
	plan := Plan{Settings: build.Settings{ServerName: "box"}, Image: iso.Choice{Kind: "local"}}
	if err := Execute(plan, Options{BuildDir: t.TempDir(), Deps: execDeps(rec)}, func(string, ...any) {}); err == nil {
		t.Fatal("expected an error for an empty local image path")
	}
}
