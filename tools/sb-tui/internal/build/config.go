package build

// ServiceBay config.json builder, ported from install-fedora-coreos.sh (#1291,
// child of #1278). Turns the persisted install Settings plus the per-run
// Secrets (bootstrap-token hash) into the config.json that gets baked into the
// Ignition. Pure — the Butane render / Ignition transpile that embeds the
// output is a later child (#1293). Mirrors the SERVICEBAY_CONFIG assembly:
// auth (+ optional bootstrapToken), autoUpdate, templateSettings, and the
// optional reverseProxy / gateway / registries / notifications sections.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// DefaultDataRoot is the FCoS host data volume; templateSettings.DATA_DIR is
// "<DataRoot>/stacks". Matches DATA_ROOT in install-fedora-coreos.sh.
const DefaultDataRoot = "/mnt/data"

// ConfigBuild is the input to the config.json builder: the persisted settings,
// the resolved secrets (only the bootstrap-token hash lands in config.json),
// the data root, and the two externally-prompted account passwords ServiceBay
// can't own (FRITZ!Box gateway + SMTP).
type ConfigBuild struct {
	Settings    Settings
	Secrets     Secrets
	DataRoot    string // defaults to DefaultDataRoot when empty
	GatewayPass string // prompted GW_PASS
	EmailPass   string // prompted EMAIL_PASS
}

type sbConfig struct {
	ServerName        string           `json:"serverName"`
	Auth              authBlock        `json:"auth"`
	AutoUpdate        autoUpdateBlock  `json:"autoUpdate"`
	TemplateSettings  templateSettings `json:"templateSettings"`
	ReverseProxy      *reverseProxy    `json:"reverseProxy,omitempty"`
	Gateway           *gatewayBlock    `json:"gateway,omitempty"`
	Registries        *registriesBlock `json:"registries,omitempty"`
	Notifications     *notifications   `json:"notifications,omitempty"`
	SetupCompleted    bool             `json:"setupCompleted"`
	StackSetupPending bool             `json:"stackSetupPending"`
}

type authBlock struct {
	Username       string          `json:"username"`
	BootstrapToken *bootstrapToken `json:"bootstrapToken,omitempty"`
}

type bootstrapToken struct {
	Hash  string `json:"hash"`
	Scope string `json:"scope"`
}

type autoUpdateBlock struct {
	Enabled  bool   `json:"enabled"`
	Schedule string `json:"schedule"`
}

type templateSettings struct {
	DataDir string `json:"DATA_DIR"`
}

type reverseProxy struct {
	PublicDomain string `json:"publicDomain"`
}

type gatewayBlock struct {
	Type     string `json:"type"`
	Host     string `json:"host"`
	Username string `json:"username"`
	Password string `json:"password"`
}

type registriesBlock struct {
	Enabled bool           `json:"enabled"`
	Items   []registryItem `json:"items"`
}

type registryItem struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

type notifications struct {
	Email emailConfig `json:"email"`
}

type emailConfig struct {
	Enabled bool     `json:"enabled"`
	Host    string   `json:"host"`
	Port    int      `json:"port"`
	Secure  bool     `json:"secure"`
	User    string   `json:"user"`
	Pass    string   `json:"pass"`
	From    string   `json:"from"`
	To      []string `json:"to"`
}

// isYesFlag mirrors the bash `${VAR^^} =~ ^Y` test: a value whose uppercased
// form starts with Y (y/yes/Y/...). Anything else is off.
func isYesFlag(v string) bool {
	return strings.HasPrefix(strings.ToUpper(v), "Y")
}

// splitRecipients splits a comma-separated recipient list, trimming each entry
// and dropping empties (mirrors the python recipient parse).
func splitRecipients(raw string) []string {
	out := []string{}
	for _, part := range strings.Split(raw, ",") {
		if s := strings.TrimSpace(part); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// JSON renders the config.json bytes (2-space indent, no HTML escaping, no
// trailing newline) deterministically. Returns an error only when email is
// enabled with a non-numeric port.
func (c ConfigBuild) JSON() ([]byte, error) {
	s := c.Settings
	dataRoot := c.DataRoot
	if dataRoot == "" {
		dataRoot = DefaultDataRoot
	}

	cfg := sbConfig{
		ServerName:        s.ServerName,
		Auth:              authBlock{Username: s.ServicebayAdminUser},
		AutoUpdate:        autoUpdateBlock{Enabled: true, Schedule: "0 0 * * *"},
		TemplateSettings:  templateSettings{DataDir: dataRoot + "/stacks"},
		SetupCompleted:    true,
		StackSetupPending: true,
	}

	// Bootstrap token: only the SHA-256 hash + read scope land in config.json.
	if s := c.Secrets.BootstrapTokenHash; s != "" {
		cfg.Auth.BootstrapToken = &bootstrapToken{Hash: s, Scope: "read"}
	}

	if s.PublicDomain != "" {
		cfg.ReverseProxy = &reverseProxy{PublicDomain: s.PublicDomain}
	}

	if s.GWUser != "" {
		cfg.Gateway = &gatewayBlock{Type: "fritzbox", Host: s.GWHost, Username: s.GWUser, Password: c.GatewayPass}
	}

	items := []registryItem{}
	if isYesFlag(s.EnableRegistries) {
		items = append(items, registryItem{Name: "ServiceBay Templates", URL: "https://github.com/mdopp/servicebay-templates"})
	}
	if isYesFlag(s.EnableOscarRegistry) {
		items = append(items, registryItem{Name: "oscar", URL: "https://github.com/mdopp/oscar"})
	}
	if len(items) > 0 {
		cfg.Registries = &registriesBlock{Enabled: true, Items: items}
	}

	if isYesFlag(s.EnableEmail) {
		port, err := strconv.Atoi(strings.TrimSpace(s.EmailPort))
		if err != nil {
			return nil, fmt.Errorf("email enabled but EMAIL_PORT %q is not a number: %w", s.EmailPort, err)
		}
		cfg.Notifications = &notifications{Email: emailConfig{
			Enabled: true,
			Host:    s.EmailHost,
			Port:    port,
			Secure:  isYesFlag(s.EmailSecure),
			User:    s.EmailUser,
			Pass:    c.EmailPass,
			From:    s.EmailFrom,
			To:      splitRecipients(s.EmailRecipients),
		}}
	}

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(cfg); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}
