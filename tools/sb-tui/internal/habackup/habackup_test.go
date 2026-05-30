package habackup

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// buildFakeHaBackup writes a minimal Supervisor backup tar: an outer tar with
// backup.json + homeassistant.tar.gz, whose inner archive has files under data/.
func buildFakeHaBackup(t *testing.T, innerFiles map[string]string) string {
	t.Helper()

	// inner tar.gz (data/ layout)
	var innerTar bytes.Buffer
	itw := tar.NewWriter(&innerTar)
	for name, content := range innerFiles {
		if err := itw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := itw.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := itw.Close(); err != nil {
		t.Fatal(err)
	}
	var innerGz bytes.Buffer
	gw := gzip.NewWriter(&innerGz)
	if _, err := gw.Write(innerTar.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := gw.Close(); err != nil {
		t.Fatal(err)
	}

	// outer tar
	path := filepath.Join(t.TempDir(), "ha-backup.tar")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	otw := tar.NewWriter(f)
	writeMember := func(name string, data []byte) {
		if err := otw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(data)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := otw.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	writeMember("backup.json", []byte(`{"version":2}`))
	writeMember(innerArchive, innerGz.Bytes())
	if err := otw.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

// readTar returns the regular-file entries of a tar as name->content.
func readTar(t *testing.T, data []byte) map[string]string {
	t.Helper()
	out := map[string]string{}
	tr := tar.NewReader(bytes.NewReader(data))
	for {
		hdr, err := tr.Next()
		if err != nil {
			break
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		var buf bytes.Buffer
		if _, err := buf.ReadFrom(tr); err != nil {
			t.Fatal(err)
		}
		out[hdr.Name] = buf.String()
	}
	return out
}

func TestExtractAndFilter_KeepsIncludesDropsBulk(t *testing.T) {
	backup := buildFakeHaBackup(t, map[string]string{
		"data/configuration.yaml":            "default_config:",
		"data/.storage/zwave_js":             `{"keys":"MESH"}`,
		"data/.storage/core.entity_registry": "{}",
		"data/home-assistant_v2.db":          "BIGDB",          // not an include
		"data/custom_components/hacs/x.js":   "frontend-bloat", // not an include
		"data/home-assistant.log":            "noise",          // not an include
	})

	out, err := ExtractAndFilter(backup, HomeAssistantIncludes)
	if err != nil {
		t.Fatal(err)
	}
	files := readTar(t, out)

	if files["configuration.yaml"] != "default_config:" {
		t.Errorf("configuration.yaml missing/wrong: %q", files["configuration.yaml"])
	}
	if files[".storage/zwave_js"] != `{"keys":"MESH"}` {
		t.Errorf(".storage/zwave_js missing/wrong: %q", files[".storage/zwave_js"])
	}
	for _, gone := range []string{"home-assistant_v2.db", "custom_components/hacs/x.js", "home-assistant.log"} {
		if _, present := files[gone]; present {
			t.Errorf("bulk file %q should not be in the filtered tar", gone)
		}
	}
}

func TestExtractAndFilter_RejectsNonHaBackup(t *testing.T) {
	// An outer tar with no homeassistant.tar.gz member.
	path := filepath.Join(t.TempDir(), "not-ha.tar")
	f, _ := os.Create(path)
	tw := tar.NewWriter(f)
	_ = tw.WriteHeader(&tar.Header{Name: "random.txt", Mode: 0o644, Size: 1, Typeflag: tar.TypeReg})
	_, _ = tw.Write([]byte("x"))
	_ = tw.Close()
	_ = f.Close()

	if _, err := ExtractAndFilter(path, HomeAssistantIncludes); err == nil {
		t.Fatal("expected an error for a non-HA backup")
	}
}

func TestExtractAndFilter_RejectsNoConfigFiles(t *testing.T) {
	backup := buildFakeHaBackup(t, map[string]string{
		"data/home-assistant_v2.db": "BIGDB", // present but not an include
	})
	if _, err := ExtractAndFilter(backup, HomeAssistantIncludes); err == nil {
		t.Fatal("expected an error when no include files are present")
	}
}

// TestHomeAssistantIncludesMatchManifest guards against the Go include list
// drifting from the TS manifest (the source of truth). Skips if the repo file
// isn't reachable from the test's working dir.
func TestHomeAssistantIncludesMatchManifest(t *testing.T) {
	manifestPath := filepath.Join("..", "..", "..", "..", "packages", "backend", "src", "lib", "externalBackup", "serviceManifest.ts")
	src, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Skipf("manifest not reachable (%v) — skipping drift guard", err)
	}
	// Grab the home-assistant block's include: [ ... ] and pull single-quoted strings.
	block := regexp.MustCompile(`(?s)service:\s*'home-assistant'.*?include:\s*\[(.*?)\]`).FindSubmatch(src)
	if block == nil {
		t.Fatal("could not locate home-assistant include block in serviceManifest.ts")
	}
	tsIncludes := regexp.MustCompile(`'([^']+)'`).FindAllStringSubmatch(string(block[1]), -1)
	got := map[string]bool{}
	for _, m := range tsIncludes {
		got[m[1]] = true
	}
	for _, inc := range HomeAssistantIncludes {
		if !got[inc] {
			t.Errorf("Go include %q is not in the TS manifest — drift", inc)
		}
		delete(got, inc)
	}
	for leftover := range got {
		t.Errorf("TS manifest include %q is missing from the Go list — drift", leftover)
	}
}
