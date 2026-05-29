// Package build is the native ISO-build leg of the launcher (#1278), porting
// install-fedora-coreos.sh to Go in dependency-ordered pieces. This first
// module is the settings model: the non-secret install configuration that
// persists across runs in build/fcos/install-settings.env.
//
// Secrets (the host console password, the ServiceBay admin password, the MCP
// bootstrap token) are deliberately NOT modelled here — they're generated
// fresh on every run (#1284, ported in #1290) so they never touch this file.
// Mirrors the bash PERSISTED_SETTINGS list + load_setting/save_settings.
package build

import (
	"bufio"
	"os"
	"strings"
)

// Settings is the persisted, non-secret install-build configuration. Field
// order in fieldBindings mirrors the bash PERSISTED_SETTINGS array so the
// saved file round-trips byte-stably.
type Settings struct {
	ServerName          string
	HostUser            string
	SSHAuthorizedKey    string
	NetInterface        string
	StaticIP            string
	StaticPrefix        string
	Gateway             string
	DNSServers          string
	ServicebayPort      string
	ServicebayChannel   string
	ServicebayAdminUser string
	PublicDomain        string
	GWHost              string
	GWUser              string
	EnableRegistries    string
	EnableOscarRegistry string
	EnableEmail         string
	EmailHost           string
	EmailPort           string
	EmailSecure         string
	EmailUser           string
	EmailFrom           string
	EmailRecipients     string
	AuthSecret          string
}

// DefaultPort is the ServiceBay HTTP port baked into a build when the operator
// doesn't override it. Matches probes.ResolveTarget's fallback.
const DefaultPort = "5888"

// DefaultHostUser is the FCoS host/console account name.
const DefaultHostUser = "core"

// fieldBindings is the single source of truth pairing each env-file key with
// its struct field, in PERSISTED_SETTINGS order. Add/remove a setting here and
// the parse + render + the saved round-trip all pick it up — exactly the
// "touch one place" property the bash schema array had.
func (s *Settings) fieldBindings() []struct {
	key string
	ptr *string
} {
	return []struct {
		key string
		ptr *string
	}{
		{"SERVER_NAME", &s.ServerName},
		{"HOST_USER", &s.HostUser},
		{"SSH_AUTHORIZED_KEY", &s.SSHAuthorizedKey},
		{"NET_INTERFACE", &s.NetInterface},
		{"STATIC_IP", &s.StaticIP},
		{"STATIC_PREFIX", &s.StaticPrefix},
		{"GATEWAY", &s.Gateway},
		{"DNS_SERVERS", &s.DNSServers},
		{"SERVICEBAY_PORT", &s.ServicebayPort},
		{"SERVICEBAY_CHANNEL", &s.ServicebayChannel},
		{"SERVICEBAY_ADMIN_USER", &s.ServicebayAdminUser},
		{"PUBLIC_DOMAIN", &s.PublicDomain},
		{"GW_HOST", &s.GWHost},
		{"GW_USER", &s.GWUser},
		{"ENABLE_REGISTRIES", &s.EnableRegistries},
		{"ENABLE_OSCAR_REGISTRY", &s.EnableOscarRegistry},
		{"ENABLE_EMAIL", &s.EnableEmail},
		{"EMAIL_HOST", &s.EmailHost},
		{"EMAIL_PORT", &s.EmailPort},
		{"EMAIL_SECURE", &s.EmailSecure},
		{"EMAIL_USER", &s.EmailUser},
		{"EMAIL_FROM", &s.EmailFrom},
		{"EMAIL_RECIPIENTS", &s.EmailRecipients},
		{"AUTH_SECRET", &s.AuthSecret},
	}
}

// ParseSettings reads KEY=value lines into a Settings. Unknown keys are
// ignored (so a key dropped from the schema is silently forgotten on the next
// save, matching the bash behaviour); blank lines and `#` comments are
// skipped. The value is everything after the first `=`, verbatim (no trim) so
// base64 AUTH_SECRETs and space-bearing SSH keys survive intact.
func ParseSettings(raw string) Settings {
	var s Settings
	index := map[string]*string{}
	for _, b := range s.fieldBindings() {
		index[b.key] = b.ptr
	}
	sc := bufio.NewScanner(strings.NewReader(raw))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024) // SSH keys / certs can be long
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			continue
		}
		if ptr, ok := index[line[:eq]]; ok {
			*ptr = line[eq+1:]
		}
	}
	return s
}

// Render serialises the settings as KEY=value lines in PERSISTED_SETTINGS
// order — an empty field renders `KEY=` (not `KEY`), matching save_settings.
func (s Settings) Render() string {
	var b strings.Builder
	for _, fb := range s.fieldBindings() {
		b.WriteString(fb.key)
		b.WriteByte('=')
		b.WriteString(*fb.ptr)
		b.WriteByte('\n')
	}
	return b.String()
}

// Load reads settings from path. A missing file is not an error — it yields a
// zero Settings (the "no saved settings yet" first-run case); the caller layers
// defaults/prompts on top.
func Load(path string) (Settings, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Settings{}, nil
		}
		return Settings{}, err
	}
	return ParseSettings(string(raw)), nil
}

// Save writes the settings to path (0600 — it can carry the LAN topology and
// admin username, and lives next to generated secrets/ISOs in the gitignored
// build dir).
func (s Settings) Save(path string) error {
	return os.WriteFile(path, []byte(s.Render()), 0o600)
}

// WithDefaults returns a copy with the two stable non-empty defaults applied to
// any empty field: the host account name and the ServiceBay port. The rest of
// the settings are gathered interactively (a later #1278 child owns the Go
// prompt flow), so they have no fixed default here.
func (s Settings) WithDefaults() Settings {
	if s.HostUser == "" {
		s.HostUser = DefaultHostUser
	}
	if s.ServicebayPort == "" {
		s.ServicebayPort = DefaultPort
	}
	return s
}

// Target returns the box address these settings describe: the static IP and
// the ServiceBay port (falling back to DefaultPort). Host is "" when no static
// IP is set. This is the file-derived half of probes.ResolveTarget.
func (s Settings) Target() (host, port string) {
	port = s.ServicebayPort
	if port == "" {
		port = DefaultPort
	}
	return s.StaticIP, port
}
