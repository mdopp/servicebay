package iso

// Concrete IO for the ISO picker (#1292): host-arch detection, fetching
// upstream FCoS stream metadata over HTTP, enumerating on-disk ISOs, and
// invoking coreos-installer to download a remote build. Kept apart from iso.go
// so the picker model stays pure. Mirrors packages/tui/src/isoProbes.ts.

import (
	"context"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"time"
)

const (
	streamFetchTimeout = 15 * time.Second
	customISO          = "fedora-coreos-custom.iso"
	maxStreamBody      = 8 << 20 // 8 MiB — stream JSON is tiny; cap defensively
)

// HostArch returns the FCoS arch label for the running host.
func HostArch() string {
	machine := runtime.GOARCH
	switch machine {
	case "amd64":
		machine = "x86_64"
	case "arm64":
		machine = "aarch64"
	}
	return DetectHostArch(machine)
}

// FetchStreamImages fetches the metal-ISO builds for one stream. Returns nil on
// any network/parse failure so the picker degrades to whatever else is
// reachable (matching the bash silent-failure contract).
func FetchStreamImages(ctx context.Context, stream string) []StreamImage {
	reqCtx, cancel := context.WithTimeout(ctx, streamFetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, StreamURL(stream), nil)
	if err != nil {
		return nil
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxStreamBody))
	if err != nil {
		return nil
	}
	images, err := ParseStreamImages(body)
	if err != nil {
		return nil
	}
	return images
}

// FetchAllStreams fetches every stream's builds in parallel, dropping the empty
// ones, preserving the Streams order.
func FetchAllStreams(ctx context.Context) []StreamImages {
	results := make([][]StreamImage, len(Streams))
	done := make(chan int, len(Streams))
	for i, stream := range Streams {
		go func(i int, stream string) {
			results[i] = FetchStreamImages(ctx, stream)
			done <- i
		}(i, stream)
	}
	for range Streams {
		<-done
	}
	out := make([]StreamImages, 0, len(Streams))
	for i, stream := range Streams {
		if len(results[i]) > 0 {
			out = append(out, StreamImages{Stream: stream, Images: results[i]})
		}
	}
	return out
}

// ListLocalISOs enumerates ISOs across the given dirs, newest first, excluding
// the customised install ISO and de-duplicating by absolute path.
func ListLocalISOs(dirs []string) []LocalISO {
	type dated struct {
		LocalISO
		mtime time.Time
	}
	byPath := map[string]dated{}
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			name := e.Name()
			if e.IsDir() || filepath.Ext(name) != ".iso" || name == customISO {
				continue
			}
			full := filepath.Join(dir, name)
			info, err := e.Info()
			if err != nil {
				continue
			}
			byPath[full] = dated{
				LocalISO: LocalISO{Path: full, Name: name, Date: info.ModTime().UTC().Format("2006-01-02")},
				mtime:    info.ModTime(),
			}
		}
	}
	all := make([]dated, 0, len(byPath))
	for _, d := range byPath {
		all = append(all, d)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].mtime.After(all[j].mtime) })
	out := make([]LocalISO, len(all))
	for i, d := range all {
		out[i] = d.LocalISO
	}
	return out
}

// Download fetches the chosen remote build into buildDir via coreos-installer,
// streaming the installer's progress to stdout/stderr, and returns the path of
// the downloaded ISO. Mirrors the remote branch of select_fedora_coreos_iso.
func Download(ctx context.Context, stream, arch, buildDir string) (string, error) {
	before := isoSet(buildDir)
	cmd := exec.CommandContext(ctx, "coreos-installer", DownloadArgs(stream, arch, buildDir)...)
	cmd.Dir = buildDir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return "", err
	}
	// Prefer the ISO that appeared during this run; fall back to newest.
	isos := ListLocalISOs([]string{buildDir})
	for _, i := range isos {
		if !before[i.Path] {
			return i.Path, nil
		}
	}
	if len(isos) > 0 {
		return isos[0].Path, nil
	}
	return "", &os.PathError{Op: "download", Path: buildDir, Err: os.ErrNotExist}
}

func isoSet(dir string) map[string]bool {
	set := map[string]bool{}
	for _, i := range ListLocalISOs([]string{dir}) {
		set[i.Path] = true
	}
	return set
}
