package usb

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// writeFakeBlock creates a /sys/block-style device dir under root.
func writeFakeBlock(t *testing.T, root, name, removable, size, model string) {
	t.Helper()
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Join(dir, "device"), 0o755); err != nil {
		t.Fatal(err)
	}
	mustW := func(p, v string) {
		if err := os.WriteFile(p, []byte(v+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mustW(filepath.Join(dir, "removable"), removable)
	mustW(filepath.Join(dir, "size"), size)
	if model != "" {
		mustW(filepath.Join(dir, "device", "model"), model)
	}
}

func TestScanLinuxSysfs_ExcludesRootDiskAndEmptyReader(t *testing.T) {
	root := t.TempDir()
	// Mirrors the real WSL layout this was developed against:
	writeFakeBlock(t, root, "sdd", "0", "2000409264", "Virtual Disk")   // 1TB root disk, NOT removable
	writeFakeBlock(t, root, "sde", "1", "0", "SD/MMC")                  // empty card-reader slot, size 0
	writeFakeBlock(t, root, "sdf", "1", "124735488", "SD/MMC/MS/MSPRO") // the USB stick (~59.5GiB)

	devs, err := scanLinuxSysfs(root)
	if err != nil {
		t.Fatalf("scan failed: %v", err)
	}
	if len(devs) != 1 {
		t.Fatalf("expected exactly the USB stick, got %d: %+v", len(devs), devs)
	}
	d := devs[0]
	if d.Path != "/dev/sdf" {
		t.Errorf("wrong device selected: %q (must never be the non-removable root disk)", d.Path)
	}
	if d.SizeGiB() != 59 {
		t.Errorf("size = %d GiB, want 59", d.SizeGiB())
	}
	if d.Model != "SD/MMC/MS/MSPRO" {
		t.Errorf("model = %q", d.Model)
	}
}

func TestScanLinuxSysfs_SortedAndLabeled(t *testing.T) {
	root := t.TempDir()
	writeFakeBlock(t, root, "sdg", "1", "2097152", "Zee") // 1GiB
	writeFakeBlock(t, root, "sdb", "1", "2097152", "")    // 1GiB, no model
	devs, _ := scanLinuxSysfs(root)
	sortDevices(devs)
	if len(devs) != 2 || devs[0].Path != "/dev/sdb" || devs[1].Path != "/dev/sdg" {
		t.Fatalf("expected sorted [sdb, sdg], got %+v", devs)
	}
	if got := devs[0].Label(); got != "/dev/sdb 1GiB Unknown" {
		t.Errorf("label = %q, want /dev/sdb 1GiB Unknown", got)
	}
}

func TestFlashArgs(t *testing.T) {
	want := []string{"dd", "if=/tmp/x.iso", "of=/dev/sdf", "bs=4M", "status=progress", "oflag=sync"}
	if got := FlashArgs("/tmp/x.iso", "/dev/sdf"); !reflect.DeepEqual(got, want) {
		t.Errorf("FlashArgs = %v, want %v", got, want)
	}
}

func TestIsConfirmed(t *testing.T) {
	for in, want := range map[string]bool{"YES": true, "yes": false, "Y": false, "": false, " YES": false} {
		if got := IsConfirmed(in); got != want {
			t.Errorf("IsConfirmed(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestParseDiskutilExternal(t *testing.T) {
	out := `/dev/disk0 (internal, physical):
/dev/disk4 (external, physical):
   #:                       TYPE NAME                    SIZE       IDENTIFIER
/dev/disk5 (external, physical):`
	got := parseDiskutilExternal(out)
	want := []string{"/dev/disk4", "/dev/disk5"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("parseDiskutilExternal = %v, want %v", got, want)
	}
}

func TestParseDiskutilInfo(t *testing.T) {
	out := `   Device Identifier:        disk4
   Device / Media Name:      SanDisk Ultra USB
   Disk Size:                61.9 GB (61865984000 Bytes) (exactly 120832000 512-Byte-Units)`
	size, model := parseDiskutilInfo(out)
	if size != 61865984000 {
		t.Errorf("size = %d, want 61865984000", size)
	}
	if model != "SanDisk Ultra USB" {
		t.Errorf("model = %q, want SanDisk Ultra USB", model)
	}
}
