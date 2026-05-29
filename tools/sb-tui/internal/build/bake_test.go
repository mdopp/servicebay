package build

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestPatchISOLabel(t *testing.T) {
	dir := t.TempDir()
	iso := filepath.Join(dir, "x.iso")
	content := []byte("....Fedora CoreOS (Live)....Fedora CoreOS (Live)....")
	if err := os.WriteFile(iso, content, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := PatchISOLabel(iso, liveLabel, installerLabel); err != nil {
		t.Fatalf("patch failed: %v", err)
	}
	got, _ := os.ReadFile(iso)
	if len(got) != len(content) {
		t.Errorf("byte length changed: %d -> %d", len(content), len(got))
	}
	if bytes.Contains(got, []byte(liveLabel)) {
		t.Error("old label still present")
	}
	// Both labels are 20 chars, so the swap is in-place with no padding.
	if bytes.Count(got, []byte(installerLabel)) != 2 {
		t.Errorf("expected two replaced labels, got %q", got)
	}
}

func TestPatchISOLabel_RejectsLonger(t *testing.T) {
	dir := t.TempDir()
	iso := filepath.Join(dir, "x.iso")
	_ = os.WriteFile(iso, []byte("short"), 0o644)
	if err := PatchISOLabel(iso, "short", "much longer label"); err == nil {
		t.Error("expected error when replacement is longer than original")
	}
}

func TestCopyFile(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	dst := filepath.Join(dir, "sub", "dst")
	_ = os.MkdirAll(filepath.Join(dir, "sub"), 0o755)
	want := []byte("payload\x00binary\xff")
	if err := os.WriteFile(src, want, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := copyFile(src, dst); err != nil {
		t.Fatalf("copyFile: %v", err)
	}
	got, _ := os.ReadFile(dst)
	if !bytes.Equal(got, want) {
		t.Errorf("copy mismatch: %q vs %q", got, want)
	}
}
