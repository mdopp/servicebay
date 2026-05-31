// Backup-file discovery for the NAS-upload panel: rather than make the operator
// type an exact path, the TUI scans the likely places a Home Assistant backup
// .tar lands (the browser download dir, home, the current dir, removable media)
// and offers them newest-first, flagging the ones that are real Supervisor
// backups. A Supervisor backup is a tar with a root backup.json, so that's the
// cheap validation signal (mirrors ExtractAndFilter's expectations).
package habackup

import (
	"archive/tar"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Candidate is a backup .tar discovered on the local machine.
type Candidate struct {
	Path string
	Size int64
	Mod  time.Time
	IsHA bool // the tar has a root backup.json (a Home Assistant Supervisor backup)
}

const (
	scanMaxDepth = 3   // how deep below each root to descend
	scanMaxFiles = 400 // hard cap on .tar files examined, to bound pathological trees
	scanMaxPeek  = 40  // only validate the newest N as HA backups (peeking opens the tar)
)

// buildDir mirrors probes.BuildDir (kept duplicated to avoid an import cycle):
// SB_BUILD_DIR, else ./build/fcos. It's where ServiceBay stages its own
// artifacts, and a place operators drop backups, so it's an explicit scan root.
func buildDir() string {
	if d := os.Getenv("SB_BUILD_DIR"); d != "" {
		return d
	}
	return filepath.Join("build", "fcos")
}

// candidateRoots is the set of likely places an operator's backup .tar lives:
// the browser's download dir, home, the current dir, the ServiceBay build dir,
// and removable-media mounts.
func candidateRoots() []string {
	var roots []string
	if home, err := os.UserHomeDir(); err == nil {
		roots = append(roots, filepath.Join(home, "Downloads"), home)
	}
	if cwd, err := os.Getwd(); err == nil {
		roots = append(roots, cwd)
	}
	roots = append(roots, buildDir())
	return append(roots, "/media", "/run/media", "/mnt")
}

// FindCandidates scans the likely directories for *.tar files, newest first,
// flagging those that look like Home Assistant Supervisor backups. It is bounded
// (depth + file cap) so it stays fast even on a large home dir.
func FindCandidates() []Candidate { return scanDirs(candidateRoots(), IsHABackup) }

// scanDirs is the testable core of FindCandidates: walk each root (depth-bounded,
// file-capped, hidden dirs skipped), collect *.tar regular files deduped by
// absolute path, sort newest-first, then flag the newest few as HA backups via
// peek.
func scanDirs(roots []string, peek func(string) bool) []Candidate {
	seen := map[string]bool{}
	var out []Candidate
	examined := 0
	for _, root := range roots {
		root = filepath.Clean(root)
		rootDepth := strings.Count(root, string(os.PathSeparator))
		_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err != nil {
				if d != nil && d.IsDir() {
					return filepath.SkipDir // unreadable dir — skip its subtree
				}
				return nil
			}
			if d.IsDir() {
				if p != root {
					name := d.Name()
					if strings.HasPrefix(name, ".") { // skip ~/.cache, ~/.config, … — backups aren't hidden
						return filepath.SkipDir
					}
					if strings.Count(p, string(os.PathSeparator))-rootDepth >= scanMaxDepth {
						return filepath.SkipDir
					}
				}
				return nil
			}
			if examined >= scanMaxFiles {
				return filepath.SkipAll
			}
			if !strings.HasSuffix(strings.ToLower(d.Name()), ".tar") {
				return nil
			}
			examined++
			abs, err := filepath.Abs(p)
			if err != nil || seen[abs] {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return nil
			}
			seen[abs] = true
			out = append(out, Candidate{Path: abs, Size: info.Size(), Mod: info.ModTime()})
			return nil
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Mod.After(out[j].Mod) })
	for i := 0; i < len(out) && i < scanMaxPeek; i++ {
		out[i].IsHA = peek(out[i].Path)
	}
	return out
}

// IsHABackup reports whether the tar at path is a Home Assistant Supervisor
// backup — its root holds a backup.json. Bounded: it scans only the first few
// members (backup.json sits at the front of a Supervisor backup).
func IsHABackup(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	tr := tar.NewReader(f)
	for i := 0; i < 20; i++ {
		h, err := tr.Next()
		if err != nil {
			return false
		}
		if normalize(h.Name) == "backup.json" {
			return true
		}
	}
	return false
}
