package habackup

import (
	"archive/tar"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writeTar creates a tar at path containing one empty entry per name.
func writeTar(t *testing.T, path string, names ...string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	tw := tar.NewWriter(f)
	for _, n := range names {
		if err := tw.WriteHeader(&tar.Header{Name: n, Mode: 0o644, Size: 0, Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestIsHABackup(t *testing.T) {
	dir := t.TempDir()
	ha := filepath.Join(dir, "ha.tar")
	writeTar(t, ha, "./backup.json", "homeassistant.tar.gz")
	other := filepath.Join(dir, "other.tar")
	writeTar(t, other, "some/file.txt")

	if !IsHABackup(ha) {
		t.Error("a tar with a root backup.json should be detected as an HA backup")
	}
	if IsHABackup(other) {
		t.Error("a tar without backup.json should not be an HA backup")
	}
	if IsHABackup(filepath.Join(dir, "missing.tar")) {
		t.Error("a missing file should not be an HA backup")
	}
}

func TestCandidateRootsIncludesBuildDir(t *testing.T) {
	t.Setenv("SB_BUILD_DIR", "/tmp/sb-build-xyz")
	found := false
	for _, r := range candidateRoots() {
		if r == "/tmp/sb-build-xyz" {
			found = true
		}
	}
	if !found {
		t.Errorf("candidateRoots should include SB_BUILD_DIR, got %v", candidateRoots())
	}
}

func TestScanDirsNewestFirstAndFlagsHA(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	deep := filepath.Join(sub, "deeper", "tooDeep")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	hidden := filepath.Join(root, ".cache")
	if err := os.Mkdir(hidden, 0o755); err != nil {
		t.Fatal(err)
	}

	old := filepath.Join(sub, "old.tar")
	newHA := filepath.Join(root, "new.tar")
	writeTar(t, old, "x.txt")
	writeTar(t, newHA, "backup.json")
	writeTar(t, filepath.Join(root, "note.txt.gz")) // not a .tar — ignored
	writeTar(t, filepath.Join(deep, "buried.tar"), "y")
	writeTar(t, filepath.Join(hidden, "cached.tar"), "z")

	// Make newHA strictly newer than old so order is deterministic.
	now := time.Now()
	_ = os.Chtimes(old, now.Add(-time.Hour), now.Add(-time.Hour))
	_ = os.Chtimes(newHA, now, now)

	got := scanDirs([]string{root}, IsHABackup)
	if len(got) != 2 {
		t.Fatalf("want 2 candidates (depth-bounded, hidden + non-tar skipped), got %d: %+v", len(got), got)
	}
	if filepath.Base(got[0].Path) != "new.tar" {
		t.Errorf("newest-first broken: got[0] = %s", got[0].Path)
	}
	if !got[0].IsHA {
		t.Error("new.tar has backup.json — should be flagged IsHA")
	}
	if got[1].IsHA {
		t.Error("old.tar has no backup.json — should not be flagged IsHA")
	}
}
