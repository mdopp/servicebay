package buildflow

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// requiredTools are the build-host executables the native ISO build shells out
// to: openssl (password hash), ssh-keygen (container->host key), butane
// (Butane->Ignition), coreos-installer (ISO customise + download).
var requiredTools = []string{"openssl", "ssh-keygen", "butane", "coreos-installer"}

// MissingTools returns the required build-host tools not found on PATH, so the
// caller can offer to install them before starting the wizard.
func MissingTools() []string {
	var missing []string
	for _, t := range requiredTools {
		if _, err := exec.LookPath(t); err != nil {
			missing = append(missing, t)
		}
	}
	return missing
}

// butaneArch maps Go's GOARCH to the arch token in butane's release asset name.
func butaneArch(goarch string) string {
	if goarch == "arm64" {
		return "aarch64"
	}
	return "x86_64" // amd64 (and anything else falls back to the common case)
}

// butaneDownloadURL is the GitHub "latest" static-binary URL for the host arch.
// butane isn't in distro repos, so (like the old install-fedora-coreos.sh) we
// fetch the release binary directly.
func butaneDownloadURL(goarch string) string {
	return fmt.Sprintf(
		"https://github.com/coreos/butane/releases/latest/download/butane-%s-unknown-linux-gnu",
		butaneArch(goarch),
	)
}

// pkgManager is a detected system package manager and how it installs a package.
type pkgManager struct {
	name        string
	installArgs []string          // command prefix, e.g. ["sudo","dnf","install","-y"]
	pkgName     map[string]string // tool -> this distro's package name (when it differs)
}

// detectPkgManager picks the first supported package manager on PATH. look is
// injectable for tests; nil uses exec.LookPath.
func detectPkgManager(look func(string) (string, error)) *pkgManager {
	if look == nil {
		look = exec.LookPath
	}
	has := func(cmd string) bool { _, err := look(cmd); return err == nil }
	switch {
	case has("dnf"):
		return &pkgManager{"dnf", []string{"sudo", "dnf", "install", "-y"}, map[string]string{"ssh-keygen": "openssh-clients"}}
	case has("apt-get"):
		return &pkgManager{"apt-get", []string{"sudo", "apt-get", "install", "-y"}, map[string]string{"ssh-keygen": "openssh-client"}}
	case has("pacman"):
		return &pkgManager{"pacman", []string{"sudo", "pacman", "-S", "--noconfirm"}, map[string]string{"ssh-keygen": "openssh"}}
	case has("zypper"):
		return &pkgManager{"zypper", []string{"sudo", "zypper", "install", "-y"}, map[string]string{"ssh-keygen": "openssh"}}
	}
	return nil
}

// toolPackage returns the distro package name that provides a tool.
func (p *pkgManager) toolPackage(tool string) string {
	if n, ok := p.pkgName[tool]; ok {
		return n
	}
	return tool // openssl, coreos-installer share their tool name as the package
}

// InstallMissingTools installs each missing build-host tool, mirroring the old
// install-fedora-coreos.sh: butane from its GitHub release binary, everything
// else via the detected package manager (coreos-installer falls back to cargo
// on apt, where it has no package). Output streams to stdout/err; the caller is
// expected to have already confirmed with the operator (it runs sudo).
func InstallMissingTools(missing []string, logf func(string, ...any)) error {
	pm := detectPkgManager(nil)
	for _, tool := range missing {
		switch tool {
		case "butane":
			if err := installButane(logf); err != nil {
				return fmt.Errorf("install butane: %w", err)
			}
		case "coreos-installer":
			if err := installCoreosInstaller(pm, logf); err != nil {
				return fmt.Errorf("install coreos-installer: %w", err)
			}
		default: // openssl, ssh-keygen
			if pm == nil {
				return fmt.Errorf("no supported package manager found to install %q — install it manually", tool)
			}
			if err := runCmd(logf, append(append([]string{}, pm.installArgs...), pm.toolPackage(tool))...); err != nil {
				return fmt.Errorf("install %s via %s: %w", tool, pm.name, err)
			}
		}
	}
	return nil
}

func installButane(logf func(string, ...any)) error {
	url := butaneDownloadURL(runtime.GOARCH)
	const dest = "/usr/local/bin/butane"
	logf("Installing butane from %s\n", url)
	switch {
	case hasCmd("curl"):
		if err := runCmd(logf, "sudo", "curl", "-sSL", "-o", dest, url); err != nil {
			return err
		}
	case hasCmd("wget"):
		if err := runCmd(logf, "sudo", "wget", "-qO", dest, url); err != nil {
			return err
		}
	default:
		return fmt.Errorf("neither curl nor wget is available to download butane")
	}
	return runCmd(logf, "sudo", "chmod", "+x", dest)
}

func installCoreosInstaller(pm *pkgManager, logf func(string, ...any)) error {
	// dnf/pacman/zypper ship a coreos-installer package; apt does not.
	if pm != nil && pm.name != "apt-get" {
		return runCmd(logf, append(append([]string{}, pm.installArgs...), "coreos-installer")...)
	}
	if !hasCmd("cargo") {
		return fmt.Errorf("coreos-installer has no package on this distro and cargo isn't installed — " +
			"install Rust (https://rustup.rs), then re-run, or run `cargo install coreos-installer` manually")
	}
	logf("Installing coreos-installer via cargo (no distro package available)…\n")
	return runCmd(logf, "cargo", "install", "coreos-installer")
}

func hasCmd(cmd string) bool { _, err := exec.LookPath(cmd); return err == nil }

func runCmd(logf func(string, ...any), args ...string) error {
	logf("  $ %s\n", strings.Join(args, " "))
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Stdout, cmd.Stderr, cmd.Stdin = os.Stdout, os.Stderr, os.Stdin
	return cmd.Run()
}
