package build

// Butane template rendering for the native ISO-build leg (#1293, child of
// #1278). Ports the envsubst render in install-fedora-coreos.sh: substitute the
// build-time template variables into the embedded Butane template (and the
// pre-install script's hostname header), while leaving every other
// $-reference — the runtime shell vars in embedded units/scripts like
// ${RAID_DISK}, ${API_WAIT}, $$SECRET — verbatim. The transpile/bake that
// consumes this output lives in bake.go.

import (
	_ "embed"
	"strings"
)

//go:embed assets/fedora-coreos.bu
var butaneTemplate string

//go:embed assets/pre-install.sh
var preInstallTemplate string

//go:embed assets/post-install.sh
var postInstallScript string

// yamlInlineIndent is the 10-space prefix the bash applied (sed 's/^/.../') to
// every line of the multi-line values (config.json, SSH private key) so they
// nest correctly under their Butane inline-block keys.
const yamlInlineIndent = "          "

// butaneVars is the envsubst allowlist: only these build-time variables are
// substituted; any other $-reference is left literal. Mirrors the envsubst
// SHELL-FORMAT in install-fedora-coreos.sh. AUTH_SECRET is listed for fidelity
// but the template has no live reference — it self-generates on first boot — so
// its substitution is a no-op.
var butaneVars = []string{
	"SERVER_NAME", "HOST_USER", "SSH_AUTHORIZED_KEY", "PASSWORD_HASH", "NET_INTERFACE",
	"STATIC_IP", "STATIC_PREFIX", "GATEWAY", "DNS_SERVERS", "DATA_ROOT", "SERVICEBAY_PORT",
	"SERVICEBAY_VERSION", "SERVICEBAY_CONFIG_JSON", "SERVICEBAY_SSH_PUB", "SERVICEBAY_SSH_PRIV",
	"AUTH_SECRET", "SERVICEBAY_ADMIN_USER", "SERVICEBAY_ADMIN_PASSWORD",
}

func butaneVarSet() map[string]bool {
	m := make(map[string]bool, len(butaneVars))
	for _, v := range butaneVars {
		m[v] = true
	}
	return m
}

func isIdentStart(b byte) bool {
	return b == '_' || (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z')
}

func isIdentChar(b byte) bool {
	return isIdentStart(b) || (b >= '0' && b <= '9')
}

// parseVarRef inspects a $-reference starting at s[i] (which must be '$'). It
// returns the variable name and the full matched text ("$VAR" or "${VAR}") when
// s[i:] is a well-formed reference, or ok=false otherwise. Matches the forms
// GNU envsubst recognises.
func parseVarRef(s string, i int) (name, raw string, ok bool) {
	if i+1 >= len(s) {
		return "", "", false
	}
	if s[i+1] == '{' {
		j := i + 2
		for j < len(s) && isIdentChar(s[j]) {
			j++
		}
		if j < len(s) && s[j] == '}' && j > i+2 {
			return s[i+2 : j], s[i : j+1], true
		}
		return "", "", false
	}
	if isIdentStart(s[i+1]) {
		j := i + 1
		for j < len(s) && isIdentChar(s[j]) {
			j++
		}
		return s[i+1 : j], s[i:j], true
	}
	return "", "", false
}

// substituteAllowed replaces $VAR and ${VAR} for names in `allow` with their
// value from `vals` (empty when the name is unset), leaving every other
// $-reference verbatim. Matches GNU envsubst invoked with a SHELL-FORMAT
// allowlist.
func substituteAllowed(s string, allow map[string]bool, vals map[string]string) string {
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		if s[i] != '$' {
			b.WriteByte(s[i])
			i++
			continue
		}
		name, raw, ok := parseVarRef(s, i)
		if ok && allow[name] {
			b.WriteString(vals[name])
			i += len(raw)
			continue
		}
		// Not a substitutable reference: emit the '$' and rescan the rest, so a
		// non-allowlisted ${RAID_DISK} / $$SECRET survives unchanged.
		b.WriteByte('$')
		i++
	}
	return b.String()
}

// indentLines prefixes every line of s with prefix, matching `sed 's/^/prefix/'`
// — including empty lines, but not a phantom line after a trailing newline.
func indentLines(s, prefix string) string {
	if s == "" {
		return ""
	}
	var b strings.Builder
	b.Grow(len(s) + len(prefix))
	b.WriteString(prefix)
	for i := 0; i < len(s); i++ {
		b.WriteByte(s[i])
		if s[i] == '\n' && i != len(s)-1 {
			b.WriteString(prefix)
		}
	}
	return b.String()
}

// VersionFromChannel maps a release channel to the ghcr.io image tag baked into
// the template (SERVICEBAY_VERSION). Mirrors the bash case statement.
func VersionFromChannel(channel string) string {
	switch channel {
	case "test":
		return "test"
	case "dev":
		return "dev"
	default:
		return "latest"
	}
}

// RenderInputs is everything needed to render the Butane template: the persisted
// settings, the per-run secrets, the host password hash, the generated SSH
// keypair, and the rendered config.json. The bake leg (bake.go) produces the
// PasswordHash / SSH keys and supplies the config.json.
type RenderInputs struct {
	Settings     Settings
	Secrets      Secrets
	PasswordHash string // `openssl passwd -6` of the host console password
	SSHPublic    string // ServiceBay->host public key (single line)
	SSHPrivate   string // ServiceBay->host private key (multi-line PEM)
	ConfigJSON   string // ConfigBuild.JSON() output
	DataRoot     string // defaults to DefaultDataRoot
}

func (in RenderInputs) vars() map[string]string {
	s := in.Settings
	dataRoot := in.DataRoot
	if dataRoot == "" {
		dataRoot = DefaultDataRoot
	}
	return map[string]string{
		"SERVER_NAME":               s.ServerName,
		"HOST_USER":                 s.HostUser,
		"SSH_AUTHORIZED_KEY":        s.SSHAuthorizedKey,
		"PASSWORD_HASH":             in.PasswordHash,
		"NET_INTERFACE":             s.NetInterface,
		"STATIC_IP":                 s.StaticIP,
		"STATIC_PREFIX":             s.StaticPrefix,
		"GATEWAY":                   s.Gateway,
		"DNS_SERVERS":               s.DNSServers,
		"DATA_ROOT":                 dataRoot,
		"SERVICEBAY_PORT":           s.ServicebayPort,
		"SERVICEBAY_VERSION":        VersionFromChannel(s.ServicebayChannel),
		"SERVICEBAY_CONFIG_JSON":    indentLines(in.ConfigJSON, yamlInlineIndent),
		"SERVICEBAY_SSH_PUB":        strings.TrimRight(in.SSHPublic, "\n"),
		"SERVICEBAY_SSH_PRIV":       indentLines(strings.TrimRight(in.SSHPrivate, "\n"), yamlInlineIndent),
		"AUTH_SECRET":               "", // no-op (template self-generates on first boot)
		"SERVICEBAY_ADMIN_USER":     s.ServicebayAdminUser,
		"SERVICEBAY_ADMIN_PASSWORD": in.Secrets.AdminPassword,
	}
}

// Butane renders the Butane config with the build-time variables substituted.
func (in RenderInputs) Butane() string {
	return substituteAllowed(butaneTemplate, butaneVarSet(), in.vars())
}

// PreInstall renders the pre-install script (the smallest-non-removable-disk
// selector), substituting only SERVER_NAME into its hostname header. Every other
// $-reference is runtime shell and stays literal.
func (in RenderInputs) PreInstall() string {
	return substituteAllowed(preInstallTemplate,
		map[string]bool{"SERVER_NAME": true},
		map[string]string{"SERVER_NAME": in.Settings.ServerName})
}

// PostInstall returns the post-install script verbatim (no build-time
// substitution — it is a fully static, quoted heredoc in the bash).
func PostInstall() string { return postInstallScript }
