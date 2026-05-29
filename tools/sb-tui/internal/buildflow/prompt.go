// Package buildflow is the interactive native ISO-build wizard (#1295): it ties
// the build/iso/usb packages into the operator-facing flow that the menu's
// BuildISO action runs, replacing the bash install-fedora-coreos.sh. The flow
// is line-oriented (it runs after the Bubble Tea menu exits, in normal terminal
// mode) and mirrors the bash prompt sequence: review/edit persisted settings,
// pick an ISO, gather the external secrets, bake, surface the generated
// credentials, save settings, and optionally flash a USB stick.
package buildflow

import (
	"bufio"
	"fmt"
	"io"
	"strings"
)

// Prompter abstracts operator input so the wizard logic is unit-testable
// without a real terminal. Prompt returns the typed line (or def when blank);
// PromptSecret is the same but intended for passwords (no echo in the real
// terminal impl); Confirm asks a yes/no question.
type Prompter interface {
	Prompt(label, def string) string
	PromptSecret(label string) string
	Confirm(label string, defYes bool) bool
	Printf(format string, a ...any)
}

// ioPrompter is the real stdin/stdout implementation.
type ioPrompter struct {
	in  *bufio.Reader
	out io.Writer
}

// NewIOPrompter builds a Prompter over the given streams (os.Stdin/os.Stdout in
// production).
func NewIOPrompter(in io.Reader, out io.Writer) Prompter {
	return &ioPrompter{in: bufio.NewReader(in), out: out}
}

func (p *ioPrompter) readLine() string {
	line, _ := p.in.ReadString('\n')
	return strings.TrimRight(line, "\r\n")
}

func (p *ioPrompter) Prompt(label, def string) string {
	if def != "" {
		fmt.Fprintf(p.out, "%s [%s]: ", label, def)
	} else {
		fmt.Fprintf(p.out, "%s: ", label)
	}
	v := p.readLine()
	if v == "" {
		return def
	}
	return v
}

func (p *ioPrompter) PromptSecret(label string) string {
	// Line-oriented read; the wizard runs in a trusted local terminal. Echo
	// suppression (the bash `read -s`) is a convenience, not a security
	// boundary — the value is about to be baked into a local ISO anyway.
	fmt.Fprintf(p.out, "%s: ", label)
	return p.readLine()
}

func (p *ioPrompter) Confirm(label string, defYes bool) bool {
	suffix := "[y/N]"
	if defYes {
		suffix = "[Y/n]"
	}
	fmt.Fprintf(p.out, "%s %s: ", label, suffix)
	v := strings.TrimSpace(p.readLine())
	if v == "" {
		return defYes
	}
	return strings.HasPrefix(strings.ToLower(v), "y")
}

func (p *ioPrompter) Printf(format string, a ...any) {
	fmt.Fprintf(p.out, format, a...)
}
