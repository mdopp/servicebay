package build

// Bootstrap-secret generation, ported from install-fedora-coreos.sh (#1284,
// child #1290 of the native ISO-build leg #1278). ServiceBay owns three
// secrets per build: the ServiceBay admin password, the host console password,
// and the optional MCP bootstrap token. They are generated fresh on every run
// (so they never persist into install-settings.env — see settings.go), unless
// the operator pre-seeds a memorable value via env. Only the token's SHA-256
// hash lands in config.json; the cleartext is surfaced once via the credentials
// summary + a Bitwarden/Vaultwarden CSV so the operator can save it.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"strings"
)

const (
	// secretHexBytes mirrors `openssl rand -hex 24` for the admin + host
	// passwords (48 hex chars). Hex is login-safe and never contains the
	// characters the install pipeline rejects.
	secretHexBytes = 24
	// tokenHexBytes mirrors `openssl rand -hex 32` for the MCP bootstrap
	// token (64 hex chars).
	tokenHexBytes = 32
)

// SecretInputs is the operator-controlled input to secret resolution: values
// pre-seeded via env / install-settings.env (empty means "generate"), plus the
// SB_NO_BOOTSTRAP_TOKEN opt-out.
type SecretInputs struct {
	AdminPassword    string // pre-seeded SERVICEBAY_ADMIN_PASSWORD
	HostPassword     string // pre-seeded HOST_PASSWORD
	BootstrapToken   string // pre-seeded SERVICEBAY_BOOTSTRAP_TOKEN
	NoBootstrapToken bool   // SB_NO_BOOTSTRAP_TOKEN=1
}

// Secrets is the resolved set of bootstrap secrets for one build run. The
// *Generated flags record which values were freshly generated (vs pre-seeded),
// so the caller surfaces only the ones the operator hasn't already seen — a
// pre-seeded password is never echoed back. BootstrapTokenHash is the only
// value that goes into config.json; the cleartext token stays local.
type Secrets struct {
	AdminPassword      string
	AdminGenerated     bool
	HostPassword       string
	HostGenerated      bool
	BootstrapToken     string // cleartext; "" when skipped via SB_NO_BOOTSTRAP_TOKEN
	BootstrapTokenHash string // SHA-256 hex; "" when there is no token
	BootstrapGenerated bool
}

// pipelineUnsafe reports whether a pre-seeded secret contains a character the
// install pipeline rejects (newline, double-quote, backslash, $, backtick).
// Mirrors the guard in secret_or_generate.
func pipelineUnsafe(s string) bool {
	return strings.ContainsAny(s, "\n\"\\$`")
}

// randHex reads n random bytes from rnd and returns their hex encoding.
func randHex(rnd io.Reader, n int) (string, error) {
	buf := make([]byte, n)
	if _, err := io.ReadFull(rnd, buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// resolveSecret returns the pre-seeded value (validated) when present, else a
// freshly generated hex secret flagged as generated. Ports secret_or_generate.
func resolveSecret(preseed, name string, rnd io.Reader) (value string, generated bool, err error) {
	if preseed != "" {
		if pipelineUnsafe(preseed) {
			return "", false, fmt.Errorf("pre-seeded %s contains characters that break the install pipeline (newline, quote, backslash, $ or backtick)", name)
		}
		return preseed, false, nil
	}
	v, err := randHex(rnd, secretHexBytes)
	if err != nil {
		return "", false, err
	}
	return v, true, nil
}

// GenerateSecrets resolves the three ServiceBay-owned bootstrap secrets for one
// build run, reading randomness from rnd (callers pass crypto/rand.Reader;
// tests pass a deterministic reader). Pre-seeded admin/host passwords win and
// are validated; the bootstrap token honours SB_NO_BOOTSTRAP_TOKEN (opt-out)
// then a pre-seeded value, else mints a fresh token. Ports secret_or_generate +
// mint_bootstrap_token.
func GenerateSecrets(in SecretInputs, rnd io.Reader) (Secrets, error) {
	var s Secrets
	var err error

	if s.AdminPassword, s.AdminGenerated, err = resolveSecret(in.AdminPassword, "SERVICEBAY_ADMIN_PASSWORD", rnd); err != nil {
		return Secrets{}, err
	}
	if s.HostPassword, s.HostGenerated, err = resolveSecret(in.HostPassword, "HOST_PASSWORD", rnd); err != nil {
		return Secrets{}, err
	}

	// Bootstrap token: opt-out wins over pre-seed wins over generate. The
	// bash mint_bootstrap_token does not validate a pre-seeded token (the
	// cleartext only ever flows through sha256 + CSV quoting), so neither do
	// we — kept faithful to the source.
	switch {
	case in.NoBootstrapToken:
		// leave the token empty — no bootstrapToken block in config.json
	case in.BootstrapToken != "":
		s.BootstrapToken = in.BootstrapToken
	default:
		if s.BootstrapToken, err = randHex(rnd, tokenHexBytes); err != nil {
			return Secrets{}, err
		}
		s.BootstrapGenerated = true
	}
	if s.BootstrapToken != "" {
		sum := sha256.Sum256([]byte(s.BootstrapToken))
		s.BootstrapTokenHash = hex.EncodeToString(sum[:])
	}
	return s, nil
}

// CredentialContext is the non-secret context for rendering the credentials
// summary + CSV: where the box lives and the account names.
type CredentialContext struct {
	ServerName string
	AdminUser  string
	HostUser   string
	IP         string
	Port       string
}

// withDefaults fills the placeholders the bash summary used for empty fields.
func (c CredentialContext) withDefaults() CredentialContext {
	if c.ServerName == "" {
		c.ServerName = "ServiceBay"
	}
	if c.AdminUser == "" {
		c.AdminUser = "admin"
	}
	if c.HostUser == "" {
		c.HostUser = DefaultHostUser
	}
	if c.IP == "" {
		c.IP = "<server-ip>"
	}
	if c.Port == "" {
		c.Port = DefaultPort
	}
	return c
}

func (c CredentialContext) url() string { return fmt.Sprintf("http://%s:%s", c.IP, c.Port) }

// AnyGenerated reports whether any secret was freshly generated this run. When
// false, there is nothing to surface — everything was pre-seeded or skipped.
func (s Secrets) AnyGenerated() bool {
	return s.AdminGenerated || s.HostGenerated || s.BootstrapGenerated
}

// csvField RFC4180-quotes a CSV value (always wrapped, internal quotes
// doubled). Mirrors the bash csv_field helper.
func csvField(v string) string {
	return `"` + strings.ReplaceAll(v, `"`, `""`) + `"`
}

const bitwardenHeader = "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp"

// BitwardenCSV renders a Bitwarden/Vaultwarden-importable CSV containing only
// the secrets GENERATED this run — pre-seeded values are omitted because the
// operator already holds them. Returns "" when nothing was generated. Ports the
// CSV half of emit_generated_credentials.
func (s Secrets) BitwardenCSV(ctx CredentialContext) string {
	if !s.AnyGenerated() {
		return ""
	}
	c := ctx.withDefaults()
	var b strings.Builder
	b.WriteString(bitwardenHeader)
	b.WriteByte('\n')
	row := func(name, notes, uri, user, pass string) {
		fmt.Fprintf(&b, ",,login,%s,%s,,0,%s,%s,%s,\n",
			csvField(name), csvField(notes), csvField(uri), csvField(user), csvField(pass))
	}
	if s.AdminGenerated {
		row("ServiceBay Admin — "+c.ServerName, "ServiceBay web admin login.", c.url(), c.AdminUser, s.AdminPassword)
	}
	if s.HostGenerated {
		row("ServiceBay Host console — "+c.ServerName, "Console / SSH login for the Fedora CoreOS host user.", "ssh://"+c.IP, c.HostUser, s.HostPassword)
	}
	if s.BootstrapGenerated {
		row("ServiceBay MCP bootstrap token — "+c.ServerName, "Read-only, LAN-only, 30 minutes from first boot.", c.url(), "", s.BootstrapToken)
	}
	return b.String()
}

// Summary renders the human-readable "save these now" block for the secrets
// generated this run. Returns "" when nothing was generated. Ports the terminal
// half of emit_generated_credentials.
func (s Secrets) Summary(ctx CredentialContext) string {
	if !s.AnyGenerated() {
		return ""
	}
	c := ctx.withDefaults()
	var b strings.Builder
	b.WriteString("================ SAVE THESE CREDENTIALS NOW ================\n")
	b.WriteString("ServiceBay generated these secrets for this build. They are NOT stored\n")
	b.WriteString("anywhere else — save them to your password manager now.\n\n")
	if s.AdminGenerated {
		fmt.Fprintf(&b, "  ServiceBay admin   %s / %s\n                     %s\n", c.AdminUser, s.AdminPassword, c.url())
	}
	if s.HostGenerated {
		fmt.Fprintf(&b, "  Host console       %s / %s\n                     ssh %s@%s\n", c.HostUser, s.HostPassword, c.HostUser, c.IP)
	}
	if s.BootstrapGenerated {
		fmt.Fprintf(&b, "  MCP bootstrap      %s\n                     read-only, LAN-only, 30 min from first boot\n", s.BootstrapToken)
	}
	b.WriteString("===========================================================\n")
	return b.String()
}
