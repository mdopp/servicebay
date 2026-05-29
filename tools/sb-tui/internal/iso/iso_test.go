package iso

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestDetectHostArch(t *testing.T) {
	cases := map[string]string{
		"x86_64":  "x86_64",
		"aarch64": "aarch64",
		"arm64":   "aarch64",
		"riscv64": "riscv64", // unknown passes through
	}
	for in, want := range cases {
		if got := DetectHostArch(in); got != want {
			t.Errorf("DetectHostArch(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseStreamImages(t *testing.T) {
	raw := []byte(`{
      "architectures": {
        "x86_64": {"artifacts": {"metal": {"release": "40.1", "formats": {"iso": {"disk": {"location": "https://x/x86.iso"}}}}}},
        "aarch64": {"artifacts": {"metal": {"release": "40.1", "formats": {"iso": {"disk": {"location": "https://x/arm.iso"}}}}}},
        "s390x": {"artifacts": {"metal": {"release": "40.1", "formats": {"iso": {"disk": {}}}}}}
      }
    }`)
	images, err := ParseStreamImages(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// s390x has no location -> skipped; remaining sorted by arch.
	want := []StreamImage{
		{Arch: "aarch64", Release: "40.1", Location: "https://x/arm.iso"},
		{Arch: "x86_64", Release: "40.1", Location: "https://x/x86.iso"},
	}
	if !reflect.DeepEqual(images, want) {
		t.Errorf("ParseStreamImages = %+v, want %+v", images, want)
	}
}

func TestParseStreamImages_Tolerant(t *testing.T) {
	if imgs, err := ParseStreamImages([]byte(`{}`)); err != nil || len(imgs) != 0 {
		t.Errorf("empty doc: got %+v err %v, want []", imgs, err)
	}
	if imgs, err := ParseStreamImages([]byte(`{"architectures": null}`)); err != nil || len(imgs) != 0 {
		t.Errorf("null architectures: got %+v err %v, want []", imgs, err)
	}
	if _, err := ParseStreamImages([]byte(`not json`)); err == nil {
		t.Error("expected error for invalid JSON")
	}
}

func TestBuildChoices(t *testing.T) {
	local := []LocalISO{{Path: "/b/a.iso", Name: "a.iso", Date: "2026-05-01"}}
	remote := []StreamImages{
		{Stream: "stable", Images: []StreamImage{
			{Arch: "x86_64", Release: "40.1", Location: "u1"},
			{Arch: "aarch64", Release: "40.1", Location: "u2"},
		}},
	}
	choices := BuildChoices(local, remote, "x86_64")
	if len(choices) != 3 {
		t.Fatalf("expected 3 choices, got %d", len(choices))
	}
	if choices[0].Kind != "local" || !strings.Contains(choices[0].Label, "a.iso") {
		t.Errorf("first choice should be the local ISO, got %+v", choices[0])
	}
	if !choices[1].IsHostArch || choices[1].Arch != "x86_64" {
		t.Errorf("x86_64 remote should be marked host arch, got %+v", choices[1])
	}
	if !strings.Contains(choices[1].Label, "← host arch") {
		t.Errorf("host-arch label missing marker: %q", choices[1].Label)
	}
	if choices[2].IsHostArch {
		t.Errorf("aarch64 should not be host arch on x86_64, got %+v", choices[2])
	}
}

func TestDefaultChoiceIndex(t *testing.T) {
	if got := DefaultChoiceIndex(nil, "x86_64"); got != -1 {
		t.Errorf("empty -> %d, want -1", got)
	}
	// first local wins
	withLocal := []Choice{
		{Kind: "remote", Stream: "stable", Arch: "x86_64"},
		{Kind: "local"},
	}
	if got := DefaultChoiceIndex(withLocal, "x86_64"); got != 1 {
		t.Errorf("first-local -> %d, want 1", got)
	}
	// no local -> stable host arch
	remoteOnly := []Choice{
		{Kind: "remote", Stream: "testing", Arch: "x86_64"},
		{Kind: "remote", Stream: "stable", Arch: "aarch64"},
		{Kind: "remote", Stream: "stable", Arch: "x86_64"},
	}
	if got := DefaultChoiceIndex(remoteOnly, "x86_64"); got != 2 {
		t.Errorf("stable-host -> %d, want 2", got)
	}
	// no local, no stable host -> 0
	noMatch := []Choice{{Kind: "remote", Stream: "testing", Arch: "aarch64"}}
	if got := DefaultChoiceIndex(noMatch, "x86_64"); got != 0 {
		t.Errorf("fallback -> %d, want 0", got)
	}
}

func TestStreamURLAndDownloadArgs(t *testing.T) {
	if got := StreamURL("stable"); got != "https://builds.coreos.fedoraproject.org/streams/stable.json" {
		t.Errorf("StreamURL = %q", got)
	}
	want := []string{"download", "-s", "next", "-a", "aarch64", "-p", "metal", "-f", "iso", "-C", "/build/fcos"}
	if got := DownloadArgs("next", "aarch64", "/build/fcos"); !reflect.DeepEqual(got, want) {
		t.Errorf("DownloadArgs = %v, want %v", got, want)
	}
}

func TestListLocalISOs(t *testing.T) {
	dir := t.TempDir()
	mustWrite := func(name string, age time.Duration) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		mt := time.Now().Add(-age)
		if err := os.Chtimes(p, mt, mt); err != nil {
			t.Fatal(err)
		}
		return p
	}
	newest := mustWrite("new.iso", 1*time.Hour)
	oldest := mustWrite("old.iso", 48*time.Hour)
	mustWrite(customISO, 0)   // excluded
	mustWrite("notes.txt", 0) // non-iso, ignored
	sub := filepath.Join(dir, "sub")
	_ = os.Mkdir(sub, 0o755) // dirs ignored even if .iso-suffixed elsewhere

	got := ListLocalISOs([]string{dir})
	if len(got) != 2 {
		t.Fatalf("expected 2 ISOs (custom + txt excluded), got %d: %+v", len(got), got)
	}
	if got[0].Path != newest || got[1].Path != oldest {
		t.Errorf("expected newest-first ordering, got %+v", got)
	}
	for _, i := range got {
		if i.Name == customISO {
			t.Error("customised ISO must be excluded")
		}
		if len(i.Date) != 10 {
			t.Errorf("date not YYYY-MM-DD: %q", i.Date)
		}
	}
	// missing dir is tolerated
	if got := ListLocalISOs([]string{filepath.Join(dir, "nope")}); len(got) != 0 {
		t.Errorf("missing dir should yield no ISOs, got %+v", got)
	}
}
