package build

// ISO bake for the native build leg (#1293, child of #1278): generate the
// ServiceBay->host SSH keypair and host password hash, render the Butane
// config (render.go), transpile it to Ignition with butane, and customise a
// copy of the chosen FCoS ISO with the Ignition + pre/post-install scripts via
// coreos-installer, then patch the GRUB label. Ports the transpile/bake/label
// tail of install-fedora-coreos.sh. Wiring this into the menu's BuildISO action
// (and deleting the bash) is the follow-up child #1295.

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// CustomISOName is the filename of the baked, ready-to-flash installer ISO.
const CustomISOName = "fedora-coreos-custom.iso"

// liveLabel / installerLabel are the GRUB menu strings swapped in the baked ISO.
const (
	liveLabel      = "Fedora CoreOS (Live)"
	installerLabel = "ServiceBay Installer"
)

// HostPasswordHash returns the SHA-512 crypt hash of the host console password
// (`openssl passwd -6`), as baked into the Butane password_hash field. Mirrors
// `printf '%s' "$HOST_PASSWORD" | openssl passwd -6 -stdin`.
func HostPasswordHash(password string) (string, error) {
	cmd := exec.Command("openssl", "passwd", "-6", "-stdin")
	cmd.Stdin = strings.NewReader(password)
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("openssl passwd: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}

// GenerateSSHKeypair creates an RSA-4096 ServiceBay->host keypair under dir via
// ssh-keygen and returns the public key (authorized_keys line) and private key
// (PEM). The host disables password auth, so this key is baked into the
// Ignition for container->host SSH. Mirrors the ssh-keygen call in the bash.
func GenerateSSHKeypair(dir string) (pub, priv string, err error) {
	keyPath := filepath.Join(dir, "id_rsa")
	cmd := exec.Command("ssh-keygen", "-t", "rsa", "-b", "4096", "-f", keyPath, "-N", "", "-q")
	if out, err := cmd.CombinedOutput(); err != nil {
		return "", "", fmt.Errorf("ssh-keygen: %w: %s", err, out)
	}
	pubB, err := os.ReadFile(keyPath + ".pub")
	if err != nil {
		return "", "", err
	}
	privB, err := os.ReadFile(keyPath)
	if err != nil {
		return "", "", err
	}
	return string(pubB), string(privB), nil
}

// Transpile converts a Butane document to Ignition JSON via `butane --pretty
// --strict`, surfacing butane's diagnostics on failure.
func Transpile(butaneDoc string) ([]byte, error) {
	cmd := exec.Command("butane", "--pretty", "--strict")
	cmd.Stdin = strings.NewReader(butaneDoc)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("butane transpile: %w: %s", err, stderr.String())
	}
	return out, nil
}

// PatchISOLabel replaces an ASCII label inside the ISO in place, padding the
// replacement with trailing spaces so the byte length is preserved (the strings
// are stored inline in the image). The replacement must be no longer than the
// original. Mirrors patch_iso_label.
func PatchISOLabel(isoPath, oldLabel, newLabel string) error {
	if len(newLabel) > len(oldLabel) {
		return fmt.Errorf("label %q is longer than %q", newLabel, oldLabel)
	}
	padded := newLabel + strings.Repeat(" ", len(oldLabel)-len(newLabel))
	data, err := os.ReadFile(isoPath)
	if err != nil {
		return err
	}
	return os.WriteFile(isoPath, bytes.ReplaceAll(data, []byte(oldLabel), []byte(padded)), 0o644)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// bakeISO copies srcISO to destISO and customises it with the Ignition + the
// pre/post-install scripts. Mirrors the `coreos-installer iso customize` call.
func bakeISO(srcISO, destISO, ignitionPath, preInstallPath, postInstallPath string) error {
	if err := copyFile(srcISO, destISO); err != nil {
		return fmt.Errorf("copy source ISO: %w", err)
	}
	cmd := exec.Command("coreos-installer", "iso", "customize",
		"--dest-ignition", ignitionPath,
		"--pre-install", preInstallPath,
		"--post-install", postInstallPath,
		destISO)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("coreos-installer iso customize: %w: %s", err, out)
	}
	return nil
}

// ISOBuildInputs is everything BuildISO needs that isn't in Settings/Secrets:
// the two externally-prompted account passwords and the chosen source ISO.
type ISOBuildInputs struct {
	Settings    Settings
	Secrets     Secrets
	GatewayPass string
	EmailPass   string
	SourceISO   string // the picked FCoS live ISO (iso.Choice / iso.Download)
}

// BuildISO renders the Butane config from the inputs, transpiles it to
// Ignition, and bakes it (plus the pre/post-install scripts) into a copy of the
// source ISO at outDir/fedora-coreos-custom.iso, then patches the GRUB label.
// Returns the path of the baked ISO. The build-host tools (openssl, ssh-keygen,
// butane, coreos-installer) must be on PATH — checked by the caller (#1295).
func BuildISO(in ISOBuildInputs, outDir string) (string, error) {
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return "", err
	}

	passwordHash, err := HostPasswordHash(in.Secrets.HostPassword)
	if err != nil {
		return "", err
	}

	sshDir := filepath.Join(outDir, "servicebay-ssh")
	if err := os.MkdirAll(sshDir, 0o700); err != nil {
		return "", err
	}
	pub, priv, err := GenerateSSHKeypair(sshDir)
	if err != nil {
		return "", err
	}

	configJSON, err := ConfigBuild{
		Settings: in.Settings, Secrets: in.Secrets,
		GatewayPass: in.GatewayPass, EmailPass: in.EmailPass,
	}.JSON()
	if err != nil {
		return "", fmt.Errorf("build config.json: %w", err)
	}

	render := RenderInputs{
		Settings: in.Settings, Secrets: in.Secrets,
		PasswordHash: passwordHash, SSHPublic: pub, SSHPrivate: priv,
		ConfigJSON: string(configJSON),
	}

	ignition, err := Transpile(render.Butane())
	if err != nil {
		return "", err
	}

	ignitionPath := filepath.Join(outDir, "install.ign")
	preInstallPath := filepath.Join(outDir, "pre-install.sh")
	postInstallPath := filepath.Join(outDir, "post-install.sh")
	if err := os.WriteFile(ignitionPath, ignition, 0o600); err != nil {
		return "", err
	}
	if err := os.WriteFile(preInstallPath, []byte(render.PreInstall()), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(postInstallPath, []byte(PostInstall()), 0o755); err != nil {
		return "", err
	}

	customISO := filepath.Join(outDir, CustomISOName)
	_ = os.Remove(customISO)
	if err := bakeISO(in.SourceISO, customISO, ignitionPath, preInstallPath, postInstallPath); err != nil {
		return "", err
	}
	if err := PatchISOLabel(customISO, liveLabel, installerLabel); err != nil {
		return "", fmt.Errorf("patch ISO label: %w", err)
	}
	return customISO, nil
}
