// Package habackup turns a Home Assistant OS (Supervisor) backup into the
// ServiceBay on-NAS config format entirely client-side — so the TUI can FTP the
// result straight to the FritzBox without the box's server ever touching the
// file (the server-side import-ha/upload routes are bypassed by design).
//
// A Supervisor backup is a tar holding backup.json, homeassistant.tar.gz, and
// per-add-on core_*.tar.gz. The dockerized HA only needs the core config under
// the inner archive's data/ dir. We stream the inner archive and keep ONLY the
// manifest include paths (never the 150 MB+ DB or HACS frontend), emitting a
// plain tar of those files at root — byte-for-byte the shape the box's restore
// flow expects at sb-backup/<service>.tar.
package habackup

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"strings"
)

const (
	innerArchive = "homeassistant.tar.gz"
	dataPrefix   = "data/"
)

// HomeAssistantIncludes mirrors the home-assistant manifest in
// packages/backend/src/lib/externalBackup/serviceManifest.ts (the source of
// truth). Keep the two in sync — TestHomeAssistantIncludesMatchManifest guards
// against drift by parsing the TS file.
var HomeAssistantIncludes = []string{
	"automations.yaml", "scripts.yaml", "scenes.yaml", "configuration.yaml",
	".storage/core.config_entries", ".storage/core.device_registry",
	".storage/core.entity_registry", ".storage/core.area_registry",
	".storage/lovelace", ".storage/lovelace_dashboards",
	".storage/zwave_js",
}

// normalize strips a leading "./" and any trailing "/" from a tar member name.
func normalize(name string) string {
	name = strings.TrimPrefix(name, "./")
	return strings.TrimRight(name, "/")
}

// wanted reports whether an inner member (relative to data/) is covered by one
// of the include paths — either the include itself (a file) or anything beneath
// it (a dir include).
func wanted(rel string, includes []string) bool {
	for _, inc := range includes {
		if rel == inc || strings.HasPrefix(rel, inc+"/") {
			return true
		}
	}
	return false
}

// ExtractAndFilter reads the Supervisor backup at haBackupPath and returns a
// plain (uncompressed) tar containing only the include files, at root with the
// data/ prefix stripped. Returns an error if the file isn't an HA backup or has
// none of the include files.
func ExtractAndFilter(haBackupPath string, includes []string) ([]byte, error) {
	f, err := os.Open(haBackupPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	// Locate the inner homeassistant.tar.gz member in the outer tar; tr is then
	// positioned at its content so we can stream it without buffering ~70 MB.
	tr := tar.NewReader(f)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil, fmt.Errorf("not a Home Assistant backup: %s not found", innerArchive)
		}
		if err != nil {
			return nil, err
		}
		if normalize(hdr.Name) == innerArchive {
			break
		}
	}

	gz, err := gzip.NewReader(tr)
	if err != nil {
		return nil, fmt.Errorf("inner %s is not gzip: %w", innerArchive, err)
	}
	defer gz.Close()

	var out bytes.Buffer
	tw := tar.NewWriter(&out)
	kept := 0
	itr := tar.NewReader(gz)
	for {
		ihdr, err := itr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if ihdr.Typeflag != tar.TypeReg { // files only — no dirs/symlinks reach the NAS
			continue
		}
		norm := normalize(ihdr.Name)
		if !strings.HasPrefix(norm, dataPrefix) {
			continue
		}
		rel := strings.TrimPrefix(norm, dataPrefix)
		if !wanted(rel, includes) {
			continue
		}
		if err := tw.WriteHeader(&tar.Header{
			Name:     rel,
			Mode:     0o644,
			Size:     ihdr.Size,
			Typeflag: tar.TypeReg,
		}); err != nil {
			return nil, err
		}
		if _, err := io.Copy(tw, itr); err != nil {
			return nil, err
		}
		kept++
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if kept == 0 {
		return nil, fmt.Errorf("Home Assistant backup has no recognised config files under %s", dataPrefix)
	}
	return out.Bytes(), nil
}
