// The Bubble Tea build wizard (#1233/#1272 UX): a real full-screen form — fields
// with labels, help text, and choices — that replaces the line-oriented stdin
// Q&A for building an installer ISO. It gathers everything into a
// buildflow.Plan (no terminal prompts), then the entrypoint hands that to
// buildflow.Execute, which runs the operations and the sudo USB flash after the
// form exits (the flash needs a real TTY).
package ui

import (
	"regexp"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"servicebay-tui/internal/build"
	"servicebay-tui/internal/buildflow"
	"servicebay-tui/internal/iso"
	"servicebay-tui/internal/usb"
)

var (
	helpStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("245")).MarginLeft(2)
	stepStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("63")).Bold(true)
)

// RFC 1123 hostname: letters (either case), digits, hyphens; 1–63 chars; starts
// with a letter, no trailing hyphen. Case-insensitive per the RFC — mixed case
// like "atHome-Server" is valid (and is what real boxes run).
var formHostnameRE = regexp.MustCompile(`^[A-Za-z]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)

type buildStep int

const (
	stepSettings buildStep = iota
	stepImage
	stepSecrets
	stepFlash
	stepReview
)

type fieldKind int

const (
	fText   fieldKind = iota
	fChoice           // cycle among Options (enum / Y-N toggle)
)

// sfield describes one editable settings field.
type sfield struct {
	label   string
	help    string
	kind    fieldKind
	options []string // for fChoice
	secret  bool     // mask in the value display (none today, kept for symmetry)
	get     func(*build.Settings) string
	set     func(*build.Settings, string)
	visible func(build.Settings) bool // nil → always
	valid   func(string) string       // "" → ok, else error message
	genSSH  bool                      // offer Ctrl+G to generate an SSH keypair
}

// settingsFields is the ordered, documented field set — the "real config
// screen" the operator asked for. Conditionals hide irrelevant fields.
var settingsFields = []sfield{
	{label: "Server name", help: "Hostname for the box. Letters/digits/hyphens, 1–63 chars, must start with a letter.",
		get: func(s *build.Settings) string { return s.ServerName }, set: func(s *build.Settings, v string) { s.ServerName = v },
		valid: func(v string) string {
			if !formHostnameRE.MatchString(v) {
				return "must start with a letter; only letters, digits, hyphens; no trailing hyphen"
			}
			return ""
		}},
	{label: "Host username", help: "Linux account created on the box for SSH/console login.",
		get: func(s *build.Settings) string { return s.HostUser }, set: func(s *build.Settings, v string) { s.HostUser = v }},
	{label: "SSH public key", genSSH: true,
		help: "Public key for SSH login to the box (ssh user@ip). Auto-filled from ~/.ssh/*.pub. No key? Press Ctrl+G to generate an ed25519 keypair into ~/.ssh/id_ed25519.",
		get:  func(s *build.Settings) string { return s.SSHAuthorizedKey }, set: func(s *build.Settings, v string) { s.SSHAuthorizedKey = v }},
	{label: "Network interface", help: "NIC the static IP binds to (e.g. eno1, enp1s0).",
		get: func(s *build.Settings) string { return s.NetInterface }, set: func(s *build.Settings, v string) { s.NetInterface = v }},
	{label: "Static IPv4", help: "The box's fixed LAN address.",
		get: func(s *build.Settings) string { return s.StaticIP }, set: func(s *build.Settings, v string) { s.StaticIP = v }},
	{label: "IPv4 prefix length", help: "Subnet size in CIDR bits. 24 = a normal 255.255.255.0 home network.",
		get: func(s *build.Settings) string { return s.StaticPrefix }, set: func(s *build.Settings, v string) { s.StaticPrefix = v }},
	{label: "Gateway (router)", help: "Your router's LAN IP — the box's default route.",
		get: func(s *build.Settings) string { return s.Gateway }, set: func(s *build.Settings, v string) { s.Gateway = v }},
	{label: "DNS servers", help: "Semicolon-separated resolvers, e.g. 192.168.178.1;8.8.8.8.",
		get: func(s *build.Settings) string { return s.DNSServers }, set: func(s *build.Settings, v string) { s.DNSServers = v }},
	{label: "ServiceBay port", help: "TCP port the ServiceBay dashboard listens on.",
		get: func(s *build.Settings) string { return s.ServicebayPort }, set: func(s *build.Settings, v string) { s.ServicebayPort = v }},
	{label: "ServiceBay channel", help: "Release channel → image tag. stable = :latest (recommended), test = :test, dev = :dev.",
		kind: fChoice, options: []string{"stable", "test", "dev"},
		get: func(s *build.Settings) string { return s.ServicebayChannel }, set: func(s *build.Settings, v string) { s.ServicebayChannel = v }},
	{label: "Admin username", help: "Login for the ServiceBay web dashboard (and the in-TUI sign-in).",
		get: func(s *build.Settings) string { return s.ServicebayAdminUser }, set: func(s *build.Settings, v string) { s.ServicebayAdminUser = v }},
	{label: "Public domain", help: "Optional external domain for reverse-proxy/TLS. Blank to skip.",
		get: func(s *build.Settings) string { return s.PublicDomain }, set: func(s *build.Settings, v string) { s.PublicDomain = v }},
	{label: "FRITZ!Box host", help: "Optional. Router IP/hostname to enable FRITZ!Box automation. Blank to skip.",
		get: func(s *build.Settings) string { return s.GWHost }, set: func(s *build.Settings, v string) { s.GWHost = v }},
	{label: "FRITZ!Box username", help: "Router login user (a password is asked on the Secrets step).",
		get: func(s *build.Settings) string { return s.GWUser }, set: func(s *build.Settings, v string) { s.GWUser = v },
		visible: func(s build.Settings) bool { return strings.TrimSpace(s.GWHost) != "" }},
	{label: "Default template registry", help: "Enable the built-in template catalog.",
		kind: fChoice, options: []string{"Y", "N"},
		get: func(s *build.Settings) string { return yn(s.EnableRegistries) }, set: func(s *build.Settings, v string) { s.EnableRegistries = v }},
	{label: "OSCAR registry", help: "Enable the OSCAR (voice assistant) template registry.",
		kind: fChoice, options: []string{"Y", "N"},
		get: func(s *build.Settings) string { return yn(s.EnableOscarRegistry) }, set: func(s *build.Settings, v string) { s.EnableOscarRegistry = v }},
	{label: "Email notifications", help: "Send install/health emails via SMTP.",
		kind: fChoice, options: []string{"Y", "N"},
		get: func(s *build.Settings) string { return yn(s.EnableEmail) }, set: func(s *build.Settings, v string) { s.EnableEmail = v }},
	{label: "SMTP host", help: "Mail server hostname, e.g. smtp.gmail.com.", visible: emailOn,
		get: func(s *build.Settings) string { return s.EmailHost }, set: func(s *build.Settings, v string) { s.EmailHost = v }},
	{label: "SMTP port", help: "Usually 587 (STARTTLS) or 465 (TLS).", visible: emailOn,
		get: func(s *build.Settings) string { return s.EmailPort }, set: func(s *build.Settings, v string) { s.EmailPort = v }},
	{label: "SMTP TLS", help: "Use implicit TLS (port 465). Most providers on 587 use STARTTLS → N.", visible: emailOn,
		kind: fChoice, options: []string{"Y", "N"},
		get: func(s *build.Settings) string { return yn(s.EmailSecure) }, set: func(s *build.Settings, v string) { s.EmailSecure = v }},
	{label: "SMTP username", help: "Mailbox login (often the full address).", visible: emailOn,
		get: func(s *build.Settings) string { return s.EmailUser }, set: func(s *build.Settings, v string) { s.EmailUser = v }},
	{label: "From address", help: "Envelope From for sent mail.", visible: emailOn,
		get: func(s *build.Settings) string { return s.EmailFrom }, set: func(s *build.Settings, v string) { s.EmailFrom = v }},
	{label: "Recipients", help: "Comma-separated notification recipients.", visible: emailOn,
		get: func(s *build.Settings) string { return s.EmailRecipients }, set: func(s *build.Settings, v string) { s.EmailRecipients = v }},
}

func emailOn(s build.Settings) bool { return strings.HasPrefix(strings.ToUpper(s.EnableEmail), "Y") }

// yn normalizes a stored flag to "Y"/"N" for the toggle display.
func yn(v string) string {
	if strings.HasPrefix(strings.ToUpper(v), "Y") {
		return "Y"
	}
	return "N"
}

// BuildDeps injects the IO the form needs (so it's testable without network/USB).
type BuildDeps struct {
	Images func() ([]iso.Choice, int) // available images + default index
	USB    func() ([]usb.Device, error)
	// GenerateSSHKey ensures a local SSH keypair exists and returns the public
	// key (Ctrl+G on the SSH field). nil disables the generate option.
	GenerateSSHKey func() (string, error)
}

// BuildConfig is what the App needs to open the build form in-app: the IO deps
// plus the seeded settings (saved install-settings.env merged with defaults).
type BuildConfig struct {
	Deps  BuildDeps
	Saved build.Settings
}

// BuildFormModel is the multi-step build wizard.
type BuildFormModel struct {
	deps          BuildDeps
	width, height int

	step     buildStep
	settings build.Settings

	// settings step. The focused field is edited live — no separate edit mode:
	// text fields take typed runes, choice fields cycle with ←/→.
	visible []sfield
	sCursor int
	tCursor int // caret position (rune index) within the focused text field
	sErr    string

	// image step
	images  []iso.Choice
	iCursor int
	imgErr  string

	// secrets step
	secrets   []secretRow
	secCursor int

	// flash step
	devices []usb.Device
	fCursor int // 0 = skip; 1..len = devices[fCursor-1]
	devErr  string

	// result — read by the entrypoint after the program exits.
	Confirmed bool
}

// secretRow is one external password the build needs.
type secretRow struct {
	envLabel string // GW_PASS / EMAIL_PASS — display label
	value    string
	target   *string // where to store into the model on edit
}

type imagesLoadedMsg struct {
	images []iso.Choice
	defIdx int
}
type devicesLoadedMsg struct {
	devices []usb.Device
	err     error
}

// sshKeyGeneratedMsg carries the result of a Ctrl+G SSH-key generation.
type sshKeyGeneratedMsg struct {
	pub string
	err error
}

// buildConfirmedMsg is emitted when the operator confirms the Review step. It
// carries the assembled Plan so the App (in-app hosting) can run the build, or
// the standalone `sb-tui build` program can quit and read it back.
type buildConfirmedMsg struct{ plan buildflow.Plan }

// NewBuildForm builds the wizard seeded from saved settings.
func NewBuildForm(saved build.Settings, deps BuildDeps) BuildFormModel {
	m := BuildFormModel{deps: deps, settings: saved, step: stepSettings}
	m.recomputeVisible()
	m.tCursor = m.focusedRuneLen() // caret at end of the first field
	return m
}

// focusedRuneLen is the rune length of the currently-focused editable value
// (settings text field or secret), used to place/clamp the edit caret.
func (m BuildFormModel) focusedRuneLen() int {
	switch m.step {
	case stepSettings:
		if m.sCursor < len(m.visible) {
			return len([]rune(m.visible[m.sCursor].get(&m.settings)))
		}
	case stepSecrets:
		if m.secCursor < len(m.secrets) {
			return len([]rune(m.secrets[m.secCursor].value))
		}
	}
	return 0
}

func (m *BuildFormModel) recomputeVisible() {
	m.visible = m.visible[:0]
	for _, f := range settingsFields {
		if f.visible == nil || f.visible(m.settings) {
			m.visible = append(m.visible, f)
		}
	}
	if m.sCursor >= len(m.visible) {
		m.sCursor = 0
	}
}

// Init loads the image choices in the background.
func (m BuildFormModel) Init() tea.Cmd {
	deps := m.deps
	if deps.Images == nil {
		return nil
	}
	return func() tea.Msg {
		imgs, def := deps.Images()
		return imagesLoadedMsg{images: imgs, defIdx: def}
	}
}

// Plan assembles the gathered choices into a buildflow.Plan.
func (m BuildFormModel) Plan() buildflow.Plan {
	p := buildflow.Plan{Settings: m.settings}
	if m.iCursor < len(m.images) {
		p.Image = m.images[m.iCursor]
	}
	for _, sr := range m.secrets {
		switch sr.envLabel {
		case "FRITZ!Box password":
			p.GWPass = sr.value
		case "SMTP password":
			p.EmailPass = sr.value
		}
	}
	if m.fCursor >= 1 && m.fCursor-1 < len(m.devices) {
		p.FlashTo = m.devices[m.fCursor-1].Path
	}
	return p
}

// rebuildSecrets recomputes which external passwords are needed from settings.
func (m *BuildFormModel) rebuildSecrets() {
	old := map[string]string{}
	for _, s := range m.secrets {
		old[s.envLabel] = s.value
	}
	m.secrets = m.secrets[:0]
	if strings.TrimSpace(m.settings.GWHost) != "" {
		m.secrets = append(m.secrets, secretRow{envLabel: "FRITZ!Box password", value: old["FRITZ!Box password"]})
	}
	if emailOn(m.settings) {
		m.secrets = append(m.secrets, secretRow{envLabel: "SMTP password", value: old["SMTP password"]})
	}
	if m.secCursor >= len(m.secrets) {
		m.secCursor = 0
	}
}
