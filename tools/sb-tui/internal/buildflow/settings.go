package buildflow

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"servicebay-tui/internal/build"
)

// hostnameRE validates an RFC 952/1123 hostname (lowercase), matching the bash.
var hostnameRE = regexp.MustCompile(`^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`)

// def returns saved if non-empty, else fallback — the bash `prev` helper.
func def(saved, fallback string) string {
	if saved != "" {
		return saved
	}
	return fallback
}

// defaultSSHKey reads the operator's public key for the SSH-key prompt default.
func defaultSSHKey() string {
	home, _ := os.UserHomeDir()
	for _, name := range []string{"id_ed25519.pub", "id_rsa.pub"} {
		if b, err := os.ReadFile(filepath.Join(home, ".ssh", name)); err == nil {
			return strings.TrimSpace(string(b))
		}
	}
	return "ssh-ed25519 YOUR_KEY_HERE"
}

// WithDefaults fills any blank field with the standard seed value, so a fresh
// build form (no saved install-settings.env) starts from sensible defaults
// rather than empty inputs. Mirrors the per-field defaults gatherSettings used.
func WithDefaults(s build.Settings) build.Settings {
	s.ServerName = def(s.ServerName, "servicebay")
	s.HostUser = def(s.HostUser, "core")
	s.SSHAuthorizedKey = def(s.SSHAuthorizedKey, defaultSSHKey())
	s.NetInterface = def(s.NetInterface, "eno1")
	s.StaticIP = def(s.StaticIP, "192.168.178.99")
	s.StaticPrefix = def(s.StaticPrefix, "24")
	s.Gateway = def(s.Gateway, "192.168.178.1")
	s.DNSServers = def(s.DNSServers, "192.168.178.1;8.8.8.8")
	s.ServicebayPort = def(s.ServicebayPort, "5888")
	s.ServicebayChannel = def(s.ServicebayChannel, "stable")
	s.ServicebayAdminUser = def(s.ServicebayAdminUser, "admin")
	s.EnableRegistries = def(s.EnableRegistries, "Y")
	s.EnableOscarRegistry = def(s.EnableOscarRegistry, "N")
	s.EnableEmail = def(s.EnableEmail, "N")
	s.EmailPort = def(s.EmailPort, "587")
	return s
}

// gatherSettings runs the full interactive prompt sequence, seeding each field's
// default from the saved settings (prev). Mirrors the bash interactive block.
func gatherSettings(p Prompter, saved build.Settings) build.Settings {
	s := saved

	for {
		s.ServerName = p.Prompt("Server name (hostname)", def(saved.ServerName, "servicebay"))
		if hostnameRE.MatchString(s.ServerName) {
			break
		}
		p.Printf("  Invalid hostname. Rules: 1-63 chars, lowercase letters/digits/hyphens,\n")
		p.Printf("  must start with a letter, must not end with a hyphen.\n")
	}

	s.HostUser = p.Prompt("Host username", def(saved.HostUser, "core"))
	s.SSHAuthorizedKey = p.Prompt("SSH public key (for "+s.HostUser+")", def(saved.SSHAuthorizedKey, defaultSSHKey()))

	s.NetInterface = p.Prompt("Network interface", def(saved.NetInterface, "eno1"))
	s.StaticIP = p.Prompt("Static IPv4", def(saved.StaticIP, "192.168.178.99"))
	s.StaticPrefix = p.Prompt("IPv4 prefix length", def(saved.StaticPrefix, "24"))
	s.Gateway = p.Prompt("Gateway", def(saved.Gateway, "192.168.178.1"))
	s.DNSServers = p.Prompt("DNS servers (semicolon separated)", def(saved.DNSServers, "192.168.178.1;8.8.8.8"))

	s.ServicebayPort = p.Prompt("ServiceBay port", def(saved.ServicebayPort, "5888"))
	s.ServicebayChannel = p.Prompt("ServiceBay channel (stable/test/dev)", def(saved.ServicebayChannel, "stable"))
	s.ServicebayAdminUser = p.Prompt("ServiceBay admin username", def(saved.ServicebayAdminUser, "admin"))

	s.PublicDomain = p.Prompt("Public domain (optional, blank to skip)", saved.PublicDomain)

	p.Printf("\nFRITZ!Box gateway (optional — enables router automation)\n")
	s.GWHost = p.Prompt("  FRITZ!Box host (blank to skip)", saved.GWHost)
	if s.GWHost != "" {
		s.GWUser = p.Prompt("  FRITZ!Box username", saved.GWUser)
	} else {
		s.GWUser = ""
	}

	p.Printf("\n")
	s.EnableRegistries = p.Prompt("Enable default template registry? (Y/n)", def(saved.EnableRegistries, "Y"))
	s.EnableOscarRegistry = p.Prompt("Enable OSCAR registry? (y/N)", def(saved.EnableOscarRegistry, "N"))

	p.Printf("\n")
	s.EnableEmail = p.Prompt("Enable email notifications? (y/N)", def(saved.EnableEmail, "N"))
	if isYes(s.EnableEmail) {
		s.EmailHost = p.Prompt("  SMTP host", saved.EmailHost)
		s.EmailPort = p.Prompt("  SMTP port", def(saved.EmailPort, "587"))
		s.EmailSecure = p.Prompt("  Use TLS? (y/N)", def(saved.EmailSecure, "N"))
		s.EmailUser = p.Prompt("  SMTP username", saved.EmailUser)
		s.EmailFrom = p.Prompt("  From address", def(saved.EmailFrom, s.EmailUser))
		s.EmailRecipients = p.Prompt("  Recipients (comma separated)", def(saved.EmailRecipients, s.EmailUser))
	}

	return s
}

// isYes mirrors the bash `${VAR^^} =~ ^Y` flag test.
func isYes(v string) bool { return strings.HasPrefix(strings.ToUpper(v), "Y") }

// summarise prints the saved-settings review block (the bash USE_SAVED summary).
func summarise(p Prompter, s build.Settings) {
	key := s.SSHAuthorizedKey
	if len(key) > 60 {
		key = key[:60]
	}
	p.Printf("\n========== Saved Settings ==========\n")
	p.Printf("  Server name:       %s\n", s.ServerName)
	p.Printf("  Host user:         %s\n", s.HostUser)
	p.Printf("  SSH key:           %s...\n", key)
	p.Printf("  Network:           %s/%s via %s\n", s.StaticIP, s.StaticPrefix, s.NetInterface)
	p.Printf("  Gateway (router):  %s\n", s.Gateway)
	p.Printf("  DNS:               %s\n", s.DNSServers)
	p.Printf("  ServiceBay port:   %s\n", s.ServicebayPort)
	p.Printf("  ServiceBay channel: %s\n", s.ServicebayChannel)
	p.Printf("  Admin user:        %s\n", s.ServicebayAdminUser)
	if s.GWUser != "" {
		p.Printf("  FRITZ!Box:         %s@%s\n", s.GWUser, s.GWHost)
	} else {
		p.Printf("  FRITZ!Box:         (not configured)\n")
	}
	p.Printf("  Registries:        %s\n", s.EnableRegistries)
	p.Printf("  OSCAR registry:    %s\n", s.EnableOscarRegistry)
	if isYes(s.EnableEmail) {
		p.Printf("  Email:             %s via %s:%s\n", s.EmailUser, s.EmailHost, s.EmailPort)
	} else {
		p.Printf("  Email:             (not configured)\n")
	}
	p.Printf("====================================\n\n")
}
