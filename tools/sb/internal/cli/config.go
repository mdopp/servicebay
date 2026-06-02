package cli

import (
	"fmt"
	"os"
	"sort"
)

// Config implements `sb config get|set`. (Bare `sb config` opens the TUI panel —
// handled in main, not here.)
func Config(args []string) int {
	if len(args) == 0 {
		return usageErr(os.Stderr, "usage: sb config get [--json] | sb config set --key K --value V")
	}
	switch args[0] {
	case "get":
		return configGet(args[1:])
	case "set":
		return configSet(args[1:])
	default:
		return usageErr(os.Stderr, "usage: sb config get [--json] | sb config set --key K --value V")
	}
}

func configGet(args []string) int {
	fs := newFlags("config get")
	jsonMode := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	client, code := boxClient()
	if client == nil {
		return code
	}
	cfg, err := client.GetConfig(ctx())
	if err != nil {
		return fail(err)
	}
	return emit(*jsonMode, cfg.Values, func() {
		keys := make([]string, 0, len(cfg.Values))
		for k := range cfg.Values {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			v := cfg.Values[k]
			if v == "" {
				v = "(unset)"
			}
			fmt.Printf("%-12s %s\n", k, v)
		}
	})
}

func configSet(args []string) int {
	fs := newFlags("config set")
	key := fs.String("key", "", "config field to write (e.g. serverName, domain, logLevel)")
	value := fs.String("value", "", "new value")
	jsonMode := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *key == "" {
		return usageErr(os.Stderr, "config set: --key is required")
	}
	client, code := boxClient()
	if client == nil {
		return code
	}
	if err := client.UpdateConfig(ctx(), *key, *value); err != nil {
		return fail(err)
	}
	return emit(*jsonMode, map[string]string{"key": *key, "value": *value, "status": "updated"}, func() {
		fmt.Printf("✓ %s = %q\n", *key, *value)
	})
}
