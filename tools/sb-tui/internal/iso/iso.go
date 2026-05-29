// Package iso is the Fedora CoreOS ISO version-picker for the native build leg
// (#1292, child of #1278). It mirrors the bash select_fedora_coreos_iso /
// fetch_fcos_stream_images / detect_host_arch in install-fedora-coreos.sh (and
// the Ink port in packages/tui/src/isoPicker.ts): parse upstream stream
// metadata, merge it with on-disk ISOs, mark the host arch, pick a sensible
// default, and build the coreos-installer download argv. This file is the pure
// decision model; the network/fs/exec IO lives in probes.go so the picker stays
// unit-testable.
package iso

import (
	"encoding/json"
	"fmt"
	"sort"
)

// Streams are the FCoS streams the picker offers, newest-cadence last.
var Streams = []string{"stable", "testing", "next"}

// DetectHostArch maps a `uname -m` value to the arch label FCoS uses.
func DetectHostArch(machine string) string {
	switch machine {
	case "x86_64":
		return "x86_64"
	case "aarch64", "arm64":
		return "aarch64"
	default:
		return machine
	}
}

// StreamImage is one metal-ISO build advertised for a stream, per architecture.
type StreamImage struct {
	Arch     string
	Release  string
	Location string
}

// StreamImages pairs a stream name with its available builds.
type StreamImages struct {
	Stream string
	Images []StreamImage
}

// ParseStreamImages parses a streams/<stream>.json body into its per-arch metal
// ISO builds. Tolerant of missing keys: an arch without a metal ISO artifact is
// skipped rather than failing, so a partial/old stream degrades gracefully.
// Results are sorted by arch for deterministic ordering (Go map iteration is
// randomised, unlike jq's to_entries).
func ParseStreamImages(raw []byte) ([]StreamImage, error) {
	var doc struct {
		Architectures map[string]struct {
			Artifacts struct {
				Metal struct {
					Release string `json:"release"`
					Formats struct {
						ISO struct {
							Disk struct {
								Location string `json:"location"`
							} `json:"disk"`
						} `json:"iso"`
					} `json:"formats"`
				} `json:"metal"`
			} `json:"artifacts"`
		} `json:"architectures"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	images := make([]StreamImage, 0, len(doc.Architectures))
	for arch, v := range doc.Architectures {
		release := v.Artifacts.Metal.Release
		location := v.Artifacts.Metal.Formats.ISO.Disk.Location
		if release != "" && location != "" {
			images = append(images, StreamImage{Arch: arch, Release: release, Location: location})
		}
	}
	sort.Slice(images, func(i, j int) bool { return images[i].Arch < images[j].Arch })
	return images, nil
}

// LocalISO is an ISO already on disk. Date is the mtime as YYYY-MM-DD ("" when
// unknown).
type LocalISO struct {
	Path string
	Name string
	Date string
}

// Choice is a selectable image in the picker — either an on-disk ISO (Path set)
// or a remote build to download (Stream/Arch/Location set).
type Choice struct {
	Kind       string // "local" | "remote"
	Label      string
	Path       string
	Stream     string
	Arch       string
	Location   string
	IsHostArch bool
}

func localLabel(iso LocalISO) string {
	date := iso.Date
	if date == "" {
		date = "?"
	}
	return fmt.Sprintf("%s  (local, %s)", iso.Name, date)
}

func remoteLabel(stream string, img StreamImage, isHostArch bool) string {
	marker := ""
	if isHostArch {
		marker = "  ← host arch"
	}
	return fmt.Sprintf("%-8s %-8s %s%s", stream, img.Arch, img.Release, marker)
}

// BuildChoices combines local ISOs (first, in the order given) with the remote
// builds for each stream, marking the host arch.
func BuildChoices(local []LocalISO, remote []StreamImages, hostArch string) []Choice {
	choices := make([]Choice, 0, len(local)+len(remote)*2)
	for _, iso := range local {
		choices = append(choices, Choice{Kind: "local", Label: localLabel(iso), Path: iso.Path})
	}
	for _, si := range remote {
		for _, img := range si.Images {
			isHost := img.Arch == hostArch
			choices = append(choices, Choice{
				Kind:       "remote",
				Label:      remoteLabel(si.Stream, img, isHost),
				Stream:     si.Stream,
				Arch:       img.Arch,
				Location:   img.Location,
				IsHostArch: isHost,
			})
		}
	}
	return choices
}

// DefaultChoiceIndex returns the index to pre-select: the first local ISO, else
// the stable build for the host arch, else the first choice. Returns -1 when
// there are no choices at all.
func DefaultChoiceIndex(choices []Choice, hostArch string) int {
	if len(choices) == 0 {
		return -1
	}
	for i, c := range choices {
		if c.Kind == "local" {
			return i
		}
	}
	for i, c := range choices {
		if c.Kind == "remote" && c.Stream == "stable" && c.Arch == hostArch {
			return i
		}
	}
	return 0
}

// StreamURL is the upstream metadata URL for one stream.
func StreamURL(stream string) string {
	return fmt.Sprintf("https://builds.coreos.fedoraproject.org/streams/%s.json", stream)
}

// DownloadArgs builds the `coreos-installer download` argv that fetches the
// chosen remote build's metal ISO into buildDir.
func DownloadArgs(stream, arch, buildDir string) []string {
	return []string{"download", "-s", stream, "-a", arch, "-p", "metal", "-f", "iso", "-C", buildDir}
}
