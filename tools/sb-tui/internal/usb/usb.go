// Package usb is the USB-flash leg of the native installer (#1294, child of
// #1278): enumerate removable block devices, let the operator confirm a target,
// and write the baked ISO to it. Linux (sysfs) and macOS (diskutil) are
// supported; other platforms get a clear "not supported" message. The
// BootOrder / "Reinstall from USB" GRUB management is target-side and already
// lives in the embedded post-install script + first-boot units (#1293) — this
// package is only the build-host write path.
//
// The pure parts (sysfs/diskutil parsing, dd argv) are unit-tested; the actual
// enumeration syscalls and the sudo dd write are thin wrappers around them.
package usb

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Device is a removable block device the ISO can be flashed to.
type Device struct {
	Path      string // /dev/sdX (Linux) or /dev/diskN (macOS)
	SizeBytes int64
	Model     string
}

// SizeGiB is the device size rounded down to whole GiB, as shown to the operator.
func (d Device) SizeGiB() int64 { return d.SizeBytes / (1 << 30) }

// Label is the operator-facing one-line description, matching the bash listing.
func (d Device) Label() string {
	model := d.Model
	if model == "" {
		model = "Unknown"
	}
	return fmt.Sprintf("%s %dGiB %s", d.Path, d.SizeGiB(), model)
}

// sysfsBlockDir is overridable in tests; defaults to the real /sys/block.
var sysfsBlockDir = "/sys/block"

// sectorBytes — /sys/block/*/size is always in 512-byte units regardless of the
// physical block size (Documentation/ABI/stable/sysfs-block).
const sectorBytes = 512

// readTrimmed reads a sysfs file and trims surrounding whitespace; "" on error.
func readTrimmed(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// scanLinuxSysfs enumerates removable, non-empty block devices under blockDir,
// mirroring the bash sysfs loop: removable == "1" and size > 0. The non-removable
// root/data disks are excluded by construction. Sorted by device path.
func scanLinuxSysfs(blockDir string) ([]Device, error) {
	entries, err := os.ReadDir(blockDir)
	if err != nil {
		return nil, err
	}
	var devs []Device
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, "sd") {
			continue
		}
		base := filepath.Join(blockDir, name)
		if readTrimmed(filepath.Join(base, "removable")) != "1" {
			continue
		}
		sectors, err := strconv.ParseInt(readTrimmed(filepath.Join(base, "size")), 10, 64)
		if err != nil || sectors <= 0 {
			continue
		}
		devs = append(devs, Device{
			Path:      "/dev/" + name,
			SizeBytes: sectors * sectorBytes,
			Model:     readTrimmed(filepath.Join(base, "device", "model")),
		})
	}
	return devs, nil
}

// parseDiskutilList parses `diskutil list -plist external physical` is overkill;
// instead we parse the plain `diskutil list external physical` identifiers and
// pair them with `diskutil info`. To keep this unit-testable without a Mac, the
// macOS enumeration is built from two pure parsers: parseDiskutilExternal for
// the device identifiers and parseDiskutilInfo for size+model of one device.

// parseDiskutilExternal extracts /dev/diskN identifiers from the output of
// `diskutil list external physical`.
func parseDiskutilExternal(out string) []string {
	var ids []string
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		// Lines like: "/dev/disk4 (external, physical):" — require "external"
		// so an internal disk is never offered as a flash target even if the
		// caller's filter slips.
		if strings.HasPrefix(line, "/dev/disk") && strings.Contains(line, "external") {
			id := strings.Fields(line)[0]
			ids = append(ids, strings.TrimSuffix(id, ":"))
		}
	}
	return ids
}

// parseDiskutilInfo pulls "Disk Size" bytes and "Device / Media Name" from the
// output of `diskutil info <id>`.
func parseDiskutilInfo(out string) (sizeBytes int64, model string) {
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		val = strings.TrimSpace(val)
		switch key {
		case "Disk Size":
			// "Disk Size: 61.9 GB (61865984000 Bytes) (...)"
			if i := strings.Index(val, "("); i >= 0 {
				inner := val[i+1:]
				if j := strings.Index(inner, "Bytes"); j >= 0 {
					n, err := strconv.ParseInt(strings.TrimSpace(inner[:j]), 10, 64)
					if err == nil {
						sizeBytes = n
					}
				}
			}
		case "Device / Media Name":
			if model == "" {
				model = val
			}
		}
	}
	return sizeBytes, model
}

// FlashArgs builds the `dd` argv that writes isoPath to device. Always invoked
// under sudo by the caller. Mirrors the bash `dd if=ISO of=DEV bs=4M
// status=progress oflag=sync`.
func FlashArgs(isoPath, device string) []string {
	return []string{
		"dd",
		"if=" + isoPath,
		"of=" + device,
		"bs=4M",
		"status=progress",
		"oflag=sync",
	}
}

// confirmPhrase is the exact text the operator must type to authorise a write.
const confirmPhrase = "YES"

// IsConfirmed reports whether the operator's typed input authorises the
// destructive write (exact, case-sensitive "YES", matching the bash).
func IsConfirmed(input string) bool {
	return input == confirmPhrase
}
