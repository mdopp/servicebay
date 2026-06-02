package usb

// Platform enumeration + the sudo dd write. These are the thin IO wrappers
// around the pure parsers in usb.go.

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"sort"
)

// ErrUnsupportedOS is returned by Enumerate on platforms without a flash path.
var ErrUnsupportedOS = fmt.Errorf("USB flashing is only supported on Linux and macOS")

// Enumerate lists removable, writable USB devices on the current platform.
// Returns ErrUnsupportedOS on anything other than Linux/macOS.
func Enumerate() ([]Device, error) {
	switch runtime.GOOS {
	case "linux":
		devs, err := scanLinuxSysfs(sysfsBlockDir)
		if err != nil {
			return nil, err
		}
		sortDevices(devs)
		return devs, nil
	case "darwin":
		return enumerateDarwin()
	default:
		return nil, ErrUnsupportedOS
	}
}

func sortDevices(devs []Device) {
	sort.Slice(devs, func(i, j int) bool { return devs[i].Path < devs[j].Path })
}

// enumerateDarwin shells out to diskutil and pairs the external physical disks
// with their size/model.
func enumerateDarwin() ([]Device, error) {
	listOut, err := exec.Command("diskutil", "list", "external", "physical").Output()
	if err != nil {
		return nil, fmt.Errorf("diskutil list: %w", err)
	}
	var devs []Device
	for _, id := range parseDiskutilExternal(string(listOut)) {
		infoOut, err := exec.Command("diskutil", "info", id).Output()
		if err != nil {
			continue
		}
		size, model := parseDiskutilInfo(string(infoOut))
		if size <= 0 {
			continue
		}
		devs = append(devs, Device{Path: id, SizeBytes: size, Model: model})
	}
	sortDevices(devs)
	return devs, nil
}

// Flash writes isoPath to device via `sudo dd …`, streaming dd's progress to
// the process stdio. The caller is responsible for operator confirmation
// (IsConfirmed) before calling this — it performs the destructive write
// unconditionally. Returns an error if the source ISO is missing.
func Flash(isoPath, device string) error {
	if _, err := os.Stat(isoPath); err != nil {
		return fmt.Errorf("source ISO not readable: %w", err)
	}
	args := append([]string{}, FlashArgs(isoPath, device)...)
	cmd := exec.Command("sudo", args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("dd write failed: %w", err)
	}
	return nil
}
