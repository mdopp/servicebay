package cli

import (
	"fmt"
	"os"
	"strings"
	"time"

	"sb/internal/rest"
)

// Channel implements `sb channel [latest|dev|test]`: bare prints the running
// channel; a channel name flips it (gated by --yes) and polls until the box is
// back on the new channel. Scriptable — no TTY.
func Channel(args []string) int {
	fs := newFlags("channel")
	jsonMode := fs.Bool("json", false, "machine-readable output")
	yes := fs.Bool("yes", false, "confirm the (destructive) channel flip")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	// Flip path first so its --yes guard short-circuits before any network.
	if rest := fs.Args(); len(rest) > 0 {
		return setChannel(rest[0], *yes, *jsonMode)
	}
	client, code := boxClient()
	if client == nil {
		return code
	}
	ch, err := client.GetChannel(ctx())
	if err != nil {
		return fail(err)
	}
	return emit(*jsonMode, map[string]string{"channel": ch}, func() {
		fmt.Printf("ServiceBay channel: %s\n", ch)
		fmt.Printf("Flip with: sb channel <%s> --yes\n", strings.Join(rest.Channels, "|"))
	})
}

func validChannel(target string) bool {
	for _, c := range rest.Channels {
		if c == target {
			return true
		}
	}
	return false
}

// setChannel flips the channel (after the --yes guard) and polls for the box to
// come back, since the restart drops the API we're talking to.
func setChannel(target string, yes, jsonMode bool) int {
	if !validChannel(target) {
		fmt.Fprintf(os.Stderr, "unknown channel %q — use one of: %s\n", target, strings.Join(rest.Channels, ", "))
		return 2
	}
	if code := requireYes(yes, "flip the channel to "+target); code != 0 {
		return code
	}
	client, code := boxClient()
	if client == nil {
		return code
	}
	if err := client.SetChannel(ctx(), target); err != nil {
		return fail(err)
	}
	confirmed := pollChannel(target)
	return emit(jsonMode, map[string]any{"channel": target, "confirmed": confirmed}, func() {
		if confirmed {
			fmt.Printf("✓ ServiceBay is now on '%s'.\n", target)
		} else {
			fmt.Printf("Switching to '%s' — run `sb channel` shortly to confirm.\n", target)
		}
	})
}

// pollChannel waits (up to ~2 min) for the box to report the target channel
// after the pull+restart. Returns true once confirmed.
func pollChannel(target string) bool {
	for i := 0; i < 30; i++ {
		time.Sleep(4 * time.Second)
		if client, code := boxClient(); code == 0 {
			if ch, err := client.GetChannel(ctx()); err == nil && ch == target {
				return true
			}
		}
	}
	return false
}
