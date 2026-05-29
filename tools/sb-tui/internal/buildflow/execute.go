package buildflow

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"servicebay-tui/internal/build"
	"servicebay-tui/internal/iso"
)

// Plan is everything the operator chose up front — the result of the build
// wizard's questions. Separating it from execution lets a Bubble Tea form
// gather it with no terminal prompts, then hand a complete Plan to Execute,
// which runs the operations (download / bake / flash) without asking anything.
type Plan struct {
	Settings  build.Settings
	Image     iso.Choice // chosen source image (local path, or a remote stream to download)
	GWPass    string     // FRITZ!Box password, "" when not configured
	EmailPass string     // SMTP password, "" when email disabled
	FlashTo   string     // target device path to write the ISO to; "" = skip flashing
}

// Logf is the progress sink Execute writes to — printf-style. The terminal
// runner passes fmt.Printf; a future in-app view can capture lines instead.
type Logf func(format string, a ...any)

// Execute runs a fully-decided build Plan: persist settings, resolve the source
// ISO (downloading a remote choice), generate ServiceBay secrets, bake the
// installer, surface credentials, and optionally flash a USB. It asks nothing —
// every decision is already in the Plan — so it works behind a form or a script.
func Execute(plan Plan, opts Options, logf Logf) error {
	d := opts.Deps
	buildDir := opts.BuildDir
	if err := os.MkdirAll(buildDir, 0o755); err != nil {
		return err
	}

	settingsPath := filepath.Join(buildDir, "install-settings.env")
	if err := plan.Settings.Save(settingsPath); err != nil {
		return fmt.Errorf("save settings: %w", err)
	}
	logf("Settings saved to %s\n", settingsPath)

	sourceISO, err := resolveImage(plan.Image, d, buildDir, logf)
	if err != nil {
		return err
	}

	secrets, err := build.GenerateSecrets(build.SecretInputs{
		AdminPassword:    os.Getenv("SERVICEBAY_ADMIN_PASSWORD"),
		HostPassword:     os.Getenv("HOST_PASSWORD"),
		BootstrapToken:   os.Getenv("SERVICEBAY_BOOTSTRAP_TOKEN"),
		NoBootstrapToken: os.Getenv("SB_NO_BOOTSTRAP_TOKEN") == "1",
	}, d.Rand)
	if err != nil {
		return err
	}

	logf("\nBaking installer ISO (this runs butane + coreos-installer)…\n")
	customISO, err := d.Bake(build.ISOBuildInputs{
		Settings: plan.Settings, Secrets: secrets,
		GatewayPass: plan.GWPass, EmailPass: plan.EmailPass, SourceISO: sourceISO,
	}, buildDir)
	if err != nil {
		return fmt.Errorf("ISO bake failed: %w", err)
	}
	logf("Done! Ready-to-boot ISO:\n  %s\n", customISO)

	emitCredentialsLog(plan.Settings, secrets, buildDir, logf)

	if plan.FlashTo != "" {
		logf("\nWriting ISO to %s (this will ERASE it)…\n", plan.FlashTo)
		if err := d.Flash(customISO, plan.FlashTo); err != nil {
			return fmt.Errorf("USB write failed: %w", err)
		}
		logf("Done! USB drive is ready.\n")
	}

	printBootHelpLog(plan.Settings, logf)
	return nil
}

// resolveImage turns a chosen image into a local ISO path, downloading a remote
// stream selection into buildDir.
func resolveImage(choice iso.Choice, d Deps, buildDir string, logf Logf) (string, error) {
	if choice.Kind == "local" {
		if choice.Path == "" {
			return "", fmt.Errorf("no source image selected")
		}
		return choice.Path, nil
	}
	logf("Downloading Fedora CoreOS %s/%s (this may take a few minutes)…\n", choice.Stream, choice.Arch)
	path, err := d.Download(context.Background(), choice.Stream, choice.Arch, buildDir)
	if err != nil {
		return "", fmt.Errorf("download failed: %w", err)
	}
	logf("Downloaded: %s\n", path)
	return path, nil
}

// emitCredentialsLog mirrors emitCredentials but writes via Logf (no Prompter).
func emitCredentialsLog(s build.Settings, secrets build.Secrets, buildDir string, logf Logf) {
	if !secrets.AnyGenerated() {
		return
	}
	ctx := build.CredentialContext{
		ServerName: s.ServerName, AdminUser: s.ServicebayAdminUser, HostUser: s.HostUser,
		IP: s.StaticIP, Port: s.ServicebayPort,
	}
	logf("\n%s\n", secrets.Summary(ctx))
	csvPath := filepath.Join(buildDir, "servicebay-install-credentials.csv")
	if err := os.WriteFile(csvPath, []byte(secrets.BitwardenCSV(ctx)), 0o600); err == nil {
		logf("  Bitwarden/Vaultwarden CSV: %s\n", csvPath)
		logf("  Import via Vaultwarden → Tools → Import → Bitwarden (csv), then delete the file.\n\n")
	}
}

func printBootHelpLog(s build.Settings, logf Logf) {
	logf("\nBoot the target machine from this USB. It will:\n")
	logf("  1. Auto-detect the smallest disk and install CoreOS there\n")
	logf("  2. On first boot, auto-detect the largest disk and create a degraded RAID1\n")
	logf("  3. Mount RAID at /mnt/data, start ServiceBay on port %s\n\n", s.ServicebayPort)
}
