package cli

import (
	"fmt"
	"os"
	"strings"

	"sb/internal/rest"
)

// kvFlag accumulates repeated --var KEY=VALUE flags into a map.
type kvFlag map[string]string

func (k kvFlag) String() string { return fmt.Sprintf("%v", map[string]string(k)) }
func (k kvFlag) Set(s string) error {
	i := strings.IndexByte(s, '=')
	if i <= 0 {
		return fmt.Errorf("expected KEY=VALUE, got %q", s)
	}
	k[s[:i]] = s[i+1:]
	return nil
}

// Stacks implements `sb stacks list|install|wipe` — CLI-only (no TUI form).
func Stacks(args []string) int {
	if len(args) == 0 {
		return usageErr(os.Stderr, "usage: sb stacks list | install --stacks a,b [--var K=V] --yes | wipe --name N --yes")
	}
	switch args[0] {
	case "list":
		return stacksList(args[1:])
	case "install":
		return stacksInstall(args[1:])
	case "wipe":
		return stacksWipe(args[1:])
	default:
		return usageErr(os.Stderr, "usage: sb stacks list | install --stacks a,b [--var K=V] --yes | wipe --name N --yes")
	}
}

func stacksList(args []string) int {
	fs := newFlags("stacks list")
	jsonMode := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	client, code := boxClient()
	if client == nil {
		return code
	}
	stacks, err := client.ListStacks(ctx())
	if err != nil {
		return fail(err)
	}
	return emit(*jsonMode, stacks, func() {
		for _, s := range stacks {
			mark := " "
			if s.Installed {
				mark = "✓"
			}
			fmt.Printf("%s %-18s %-12s %s\n", mark, s.Name, s.Tier, s.Description)
		}
	})
}

// stacksInstall expands the requested stacks into their templates (matching the
// install panel's plan()), assembles a manifest with any --var prefills, and
// starts the job. Prints the job id so `sb install progress --job <id>` follows.
func stacksInstall(args []string) int {
	fs := newFlags("stacks install")
	names := fs.String("stacks", "", "comma-separated stack names to install")
	vars := kvFlag{}
	fs.Var(vars, "var", "prefill an install variable as KEY=VALUE (repeatable)")
	yes := fs.Bool("yes", false, "confirm the (destructive) install")
	jsonMode := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *names == "" {
		return usageErr(os.Stderr, "stacks install: --stacks is required")
	}
	if code := requireYes(*yes, "install "+*names); code != 0 {
		return code
	}
	client, code := boxClient()
	if client == nil {
		return code
	}
	templates, err := expandStacks(client, splitCSV(*names))
	if err != nil {
		return fail(err)
	}
	manifest, err := client.AssembleManifest(ctx(), templates, map[string]string(vars))
	if err != nil {
		return fail(err)
	}
	jobID, err := client.StartInstall(ctx(), manifest)
	if err != nil {
		return fail(err)
	}
	return emit(*jsonMode, map[string]any{"jobId": jobID, "templates": templates}, func() {
		fmt.Printf("✓ install started (job %s) — follow with: sb install progress --job %s\n", jobID, jobID)
	})
}

func stacksWipe(args []string) int {
	fs := newFlags("stacks wipe")
	name := fs.String("name", "", "stack to uninstall")
	yes := fs.Bool("yes", false, "confirm the (destructive) wipe")
	jsonMode := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *name == "" {
		return usageErr(os.Stderr, "stacks wipe: --name is required")
	}
	if code := requireYes(*yes, "wipe stack "+*name); code != 0 {
		return code
	}
	client, code := boxClient()
	if client == nil {
		return code
	}
	if err := client.WipeStack(ctx(), *name); err != nil {
		return fail(err)
	}
	return emit(*jsonMode, map[string]string{"stack": *name, "status": "wiped"}, func() {
		fmt.Printf("✓ %s uninstalled\n", *name)
	})
}

// expandStacks resolves stack names to the de-duplicated template list the
// assembler deploys, mirroring InstallModel.plan(): a stack with no catalog
// templates falls back to its own name.
func expandStacks(client *rest.Client, want []string) ([]string, error) {
	catalog, err := client.ListStacks(ctx())
	if err != nil {
		return nil, err
	}
	byName := map[string]rest.Stack{}
	for _, s := range catalog {
		byName[s.Name] = s
	}
	var out []string
	seen := map[string]bool{}
	for _, n := range want {
		s, ok := byName[n]
		if !ok {
			return nil, fmt.Errorf("unknown stack %q (try `sb stacks list`)", n)
		}
		tmpls := s.Templates
		if len(tmpls) == 0 {
			tmpls = []string{s.Name}
		}
		for _, t := range tmpls {
			if !seen[t] {
				seen[t] = true
				out = append(out, t)
			}
		}
	}
	return out, nil
}

func splitCSV(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
