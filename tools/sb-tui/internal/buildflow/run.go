package buildflow

import (
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"servicebay-tui/internal/build"
	"servicebay-tui/internal/iso"
	"servicebay-tui/internal/usb"
)

// Deps are the IO/exec seams the wizard depends on, injected so the whole flow
// is unit-testable without a network, butane/coreos-installer, or a real USB.
type Deps struct {
	Rand         io.Reader
	HostArch     func() string
	FetchStreams func(context.Context) []iso.StreamImages
	ListLocal    func(dirs []string) []iso.LocalISO
	Download     func(ctx context.Context, stream, arch, buildDir string) (string, error)
	Bake         func(in build.ISOBuildInputs, outDir string) (string, error)
	Enumerate    func() ([]usb.Device, error)
	Flash        func(isoPath, device string) error
}

// DefaultDeps wires the real implementations.
func DefaultDeps() Deps {
	return Deps{
		Rand:         rand.Reader,
		HostArch:     iso.HostArch,
		FetchStreams: iso.FetchAllStreams,
		ListLocal:    iso.ListLocalISOs,
		Download:     iso.Download,
		Bake:         build.BuildISO,
		Enumerate:    usb.Enumerate,
		Flash:        usb.Flash,
	}
}

// Options configures a wizard run.
type Options struct {
	BuildDir string // where the ISO, settings, secrets, and CSV live (build/fcos)
	Deps     Deps
}

// pipelineUnsafe rejects characters that break the install pipeline (newline,
// quote, backslash, $, backtick) — matches the bash prompt_secret guard.
func pipelineUnsafe(s string) bool { return strings.ContainsAny(s, "\n\"\\$`") }

// Run executes the interactive native ISO build (+ optional USB flash). It is
// the body of the menu's BuildISO action.
func Run(p Prompter, opts Options) error {
	d := opts.Deps
	buildDir := opts.BuildDir
	if err := os.MkdirAll(buildDir, 0o755); err != nil {
		return err
	}
	settingsPath := filepath.Join(buildDir, "install-settings.env")

	saved, _ := build.Load(settingsPath)

	// Review saved settings, or gather fresh ones.
	s := saved
	useSaved := false
	if saved.ServerName != "" {
		summarise(p, saved)
		useSaved = p.Confirm("Accept these settings? (ServiceBay secrets are auto-generated; only FRITZ!Box / SMTP passwords are prompted)", true)
	}
	if !useSaved {
		s = gatherSettings(p, saved)
	}

	// Persist the non-secret settings before the long bake (the bash saves too).
	if err := s.Save(settingsPath); err != nil {
		return fmt.Errorf("save settings: %w", err)
	}
	p.Printf("Settings saved to %s\n", settingsPath)

	// Pick the source ISO.
	sourceISO, err := pickISO(p, d, buildDir)
	if err != nil {
		return err
	}

	// External account passwords ServiceBay can't own (prompted or pre-seeded).
	gwPass, err := externalSecret(p, "GW_PASS", "Gateway password ("+s.GWUser+"@"+s.GWHost+")", s.GWUser != "")
	if err != nil {
		return err
	}
	emailPass, err := externalSecret(p, "EMAIL_PASS", "SMTP password ("+s.EmailUser+")", isYes(s.EnableEmail))
	if err != nil {
		return err
	}

	// ServiceBay-owned secrets: generated fresh (env pre-seed still wins).
	secrets, err := build.GenerateSecrets(build.SecretInputs{
		AdminPassword:    os.Getenv("SERVICEBAY_ADMIN_PASSWORD"),
		HostPassword:     os.Getenv("HOST_PASSWORD"),
		BootstrapToken:   os.Getenv("SERVICEBAY_BOOTSTRAP_TOKEN"),
		NoBootstrapToken: os.Getenv("SB_NO_BOOTSTRAP_TOKEN") == "1",
	}, d.Rand)
	if err != nil {
		return err
	}

	// Bake.
	p.Printf("\nBaking installer ISO (this runs butane + coreos-installer)…\n")
	customISO, err := d.Bake(build.ISOBuildInputs{
		Settings: s, Secrets: secrets, GatewayPass: gwPass, EmailPass: emailPass, SourceISO: sourceISO,
	}, buildDir)
	if err != nil {
		return fmt.Errorf("ISO bake failed: %w", err)
	}
	p.Printf("Done! Ready-to-boot ISO:\n  %s\n", customISO)

	// Surface the generated credentials (terminal + Bitwarden/Vaultwarden CSV).
	emitCredentials(p, s, secrets, buildDir)

	// Optional USB flash.
	if err := flashStep(p, d, customISO); err != nil {
		return err
	}

	printBootHelp(p, s)
	return nil
}

// externalSecret returns a prompted/pre-seeded external password when needed.
// Env pre-seed wins (validated); when not needed, returns "".
func externalSecret(p Prompter, envKey, label string, needed bool) (string, error) {
	if !needed {
		return "", nil
	}
	if v := os.Getenv(envKey); v != "" {
		if pipelineUnsafe(v) {
			return "", fmt.Errorf("pre-seeded %s contains characters that break the install pipeline", envKey)
		}
		p.Printf("Using pre-seeded %s from environment.\n", envKey)
		return v, nil
	}
	for {
		v := p.PromptSecret(label)
		if v == "" {
			p.Printf("  Password is empty. Try again.\n")
			continue
		}
		if pipelineUnsafe(v) {
			p.Printf("  Password contains characters that break the install pipeline (newline, quote, backslash, $ or backtick). Pick a different one.\n")
			continue
		}
		return v, nil
	}
}

// pickISO presents the local+remote ISO picker and returns the chosen ISO path,
// downloading a remote selection.
func pickISO(p Prompter, d Deps, buildDir string) (string, error) {
	hostArch := d.HostArch()
	local := d.ListLocal(isoSearchDirs(buildDir))
	remote := d.FetchStreams(context.Background())
	choices := iso.BuildChoices(local, remote, hostArch)
	if len(choices) == 0 {
		return "", fmt.Errorf("no local ISOs found and no remote stream metadata reachable (check curl/network)")
	}

	p.Printf("\nAvailable Fedora CoreOS images:\n")
	for i, c := range choices {
		p.Printf("  %2d) %s\n", i+1, c.Label)
	}
	defIdx := iso.DefaultChoiceIndex(choices, hostArch)

	var chosen iso.Choice
	for {
		ans := p.Prompt("Select image", strconv.Itoa(defIdx+1))
		n, err := strconv.Atoi(strings.TrimSpace(ans))
		if err != nil || n < 1 || n > len(choices) {
			p.Printf("  Invalid selection.\n")
			continue
		}
		chosen = choices[n-1]
		break
	}

	if chosen.Kind == "local" {
		return chosen.Path, nil
	}
	p.Printf("Downloading Fedora CoreOS %s/%s (this may take a few minutes)…\n", chosen.Stream, chosen.Arch)
	path, err := d.Download(context.Background(), chosen.Stream, chosen.Arch, buildDir)
	if err != nil {
		return "", fmt.Errorf("download failed: %w", err)
	}
	p.Printf("Downloaded: %s\n", path)
	return path, nil
}

// isoSearchDirs mirrors the bash search set: repo root, build/, build/fcos.
func isoSearchDirs(buildDir string) []string {
	parent := filepath.Dir(buildDir) // build/
	root := filepath.Dir(parent)     // repo root
	return []string{root, parent, buildDir}
}

// emitCredentials prints the "save these now" summary and writes the
// Bitwarden/Vaultwarden CSV for anything generated this run.
func emitCredentials(p Prompter, s build.Settings, secrets build.Secrets, buildDir string) {
	if !secrets.AnyGenerated() {
		return
	}
	ctx := build.CredentialContext{
		ServerName: s.ServerName, AdminUser: s.ServicebayAdminUser, HostUser: s.HostUser,
		IP: s.StaticIP, Port: s.ServicebayPort,
	}
	p.Printf("\n%s\n", secrets.Summary(ctx))
	csvPath := filepath.Join(buildDir, "servicebay-install-credentials.csv")
	if err := os.WriteFile(csvPath, []byte(secrets.BitwardenCSV(ctx)), 0o600); err == nil {
		p.Printf("  Bitwarden/Vaultwarden CSV: %s\n", csvPath)
		p.Printf("  Import via Vaultwarden → Tools → Import → Bitwarden (csv), then delete the file.\n\n")
	}
}

// flashStep enumerates removable devices and optionally writes the ISO.
func flashStep(p Prompter, d Deps, customISO string) error {
	devs, err := d.Enumerate()
	if err != nil {
		p.Printf("\nUSB enumeration unavailable (%v). Write manually with:\n", err)
		p.Printf("  sudo dd if=%s of=/dev/sdX bs=4M status=progress oflag=sync\n", customISO)
		return nil
	}
	if len(devs) == 0 {
		p.Printf("\nNo USB drives detected. You can write manually with:\n")
		p.Printf("  sudo dd if=%s of=/dev/sdX bs=4M status=progress oflag=sync\n", customISO)
		return nil
	}
	p.Printf("\nAvailable USB drives:\n")
	for i, dev := range devs {
		p.Printf("  %d) %s\n", i+1, dev.Label())
	}
	p.Printf("  0) Skip (don't write to USB)\n\n")

	ans := p.Prompt("Select drive to write ISO to", "0")
	n, err := strconv.Atoi(strings.TrimSpace(ans))
	if err != nil || n < 1 || n > len(devs) {
		p.Printf("Skipped.\n")
		return nil
	}
	target := devs[n-1]
	p.Printf("\nWARNING: This will ERASE ALL DATA on %s\n", target.Label())
	if !usb.IsConfirmed(p.Prompt("Are you sure? Type YES to confirm", "")) {
		p.Printf("Skipped.\n")
		return nil
	}
	p.Printf("Writing ISO to %s…\n", target.Path)
	if err := d.Flash(customISO, target.Path); err != nil {
		return fmt.Errorf("USB write failed: %w", err)
	}
	p.Printf("Done! USB drive is ready.\n")
	return nil
}

func printBootHelp(p Prompter, s build.Settings) {
	p.Printf("\nBoot the target machine from this USB. It will:\n")
	p.Printf("  1. Auto-detect the smallest disk and install CoreOS there\n")
	p.Printf("  2. On first boot, auto-detect the largest disk and create a degraded RAID1\n")
	p.Printf("  3. Mount RAID at /mnt/data, start ServiceBay on port %s\n\n", s.ServicebayPort)
}
