#!/usr/bin/env bash
# start-claude — launch one Claude Code session per directory.
#
# Each directory gets its own Claude with Remote Control enabled and named
# after the directory (so it shows up labelled in the Claude mobile app / web),
# running in its own window of a shared tmux session. Because they live in
# tmux, the sessions keep running when you disconnect — reconnect with
# `tmux attach -t claude` or just log back in.
#
# This is launched MANUALLY (it is deliberately not run on login), so logging
# in doesn't auto-start Claude for everyone.
#
# Usage:
#   start-claude [CLAUDE_FLAGS...] DIR [DIR...]
#
# Example:
#   start-claude --allow-dangerously-skip-permissions servicebay solbay
#
# Leading dash-arguments are passed straight through to `claude`; the remaining
# bare names are directories (relative to the current dir, or absolute). Use a
# `--` separator if a directory name would otherwise look like a flag. Flags
# that take a separate value should use the `--flag=value` form. Re-running
# skips any directory that already has a live window.
set -eo pipefail

SESSION="${CLAUDE_TMUX_SESSION:-claude}"

flags=()
dirs=()
seen_dir=0
for arg in "$@"; do
  if [ "$arg" = "--" ]; then seen_dir=1; continue; fi
  if [ "$seen_dir" -eq 0 ] && [ "${arg#-}" != "$arg" ]; then
    flags+=("$arg")
  else
    seen_dir=1
    dirs+=("$arg")
  fi
done

if [ "${#dirs[@]}" -eq 0 ]; then
  echo "usage: start-claude [claude-flags...] DIR [DIR...]" >&2
  echo "  e.g. start-claude --allow-dangerously-skip-permissions servicebay solbay" >&2
  exit 2
fi

command -v tmux   >/dev/null || { echo "start-claude: tmux not found"       >&2; exit 1; }
command -v claude >/dev/null || { echo "start-claude: claude CLI not found" >&2; exit 1; }

# Pre-render the pass-through flags once, safely quoted for the shell command
# tmux runs.
#
# Two renderings, because `--continue` needs a fallback. In a checkout with no
# persisted conversation `claude --continue` does not start a fresh session —
# it exits 1. The command IS the tmux window's process, so the window closed
# instantly and the repo silently ended up with nothing running. Every newly
# cloned checkout hit this: the boot autostart and the 300s rescan both
# "started" it, and it was dead before anyone looked.
#
# `flagstr_fresh` is the same flag list minus `--continue`, used as a `||`
# fallback so a first run starts a session instead of dying.
flagstr=""
flagstr_fresh=""
has_continue=0
for f in "${flags[@]}"; do
  flagstr+="$(printf '%q ' "$f")"
  case "$f" in
    --continue|-c) has_continue=1 ;;
    *)             flagstr_fresh+="$(printf '%q ' "$f")" ;;
  esac
done

started=()
already=()
for d in "${dirs[@]}"; do
  if [ -d "$d" ]; then
    # `cd -- ` so a directory whose name starts with a dash (the boot-time
    # autostart feeds this loop shared-workspace-writable basenames) is a
    # path, not an option to `cd`.
    path="$(cd -- "$d" && pwd)"
  else
    echo "start-claude: skipping '$d' — not a directory (looked under $PWD)" >&2
    continue
  fi
  name="$(basename "$path")"

  # Claude with Remote Control on, named after the directory.
  cmd="claude ${flagstr}--remote-control $(printf '%q' "$name")"
  if [ "$has_continue" -eq 1 ]; then
    # Resume if there is something to resume, otherwise start fresh. The
    # trade-off is deliberate: a `--continue` session that dies for some OTHER
    # reason also gets restarted fresh rather than leaving a dead pane behind.
    # On an unattended box that self-healing is worth more than the corpse,
    # and `remain-on-exit failed` still catches the case where BOTH attempts
    # fail — which is the one that actually needs a human.
    cmd="$cmd || claude ${flagstr_fresh}--remote-control $(printf '%q' "$name")"
  fi

  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux new-session -d -s "$SESSION" -n "$name" -c "$path" "$cmd"
  elif tmux list-windows -t "$SESSION" -F '#W' 2>/dev/null | grep -qx "$name"; then
    echo "start-claude: '$name' already running in tmux session '$SESSION' — skipping." >&2
    already+=("$name")
    continue
  else
    tmux new-window -t "$SESSION" -n "$name" -c "$path" "$cmd"
  fi
  started+=("$name")
done

if [ "${#started[@]}" -eq 0 ]; then
  # "Everything already had a live window" is SUCCESS, not failure: the
  # entrypoint re-runs this on a timer to pick up checkouts that appeared after
  # boot, and a non-zero exit there would log a warning on every quiet pass and
  # train the reader to ignore it (#2612). Only a run that started nothing AND
  # found nothing already running is an error.
  if [ "${#already[@]}" -gt 0 ]; then
    echo "start-claude: nothing to do — ${#already[@]} session(s) already running: ${already[*]}"
    exit 0
  fi
  echo "start-claude: nothing started." >&2
  exit 1
fi

echo "start-claude: started ${#started[@]} session(s): ${started[*]}"
echo "start-claude: windows in tmux '$SESSION': $(tmux list-windows -t "$SESSION" -F '#W' 2>/dev/null | paste -sd' ' -)"

# Land the user in the sessions: attach from outside tmux, or switch to the
# first new window when already inside it. Skipped when CLAUDE_START_NO_ATTACH
# is set — the boot-time autostart (docker-entrypoint.sh) has no terminal to
# attach to and must return so the entrypoint can go on to exec sshd.
if [ -n "${CLAUDE_START_NO_ATTACH:-}" ]; then
  exit 0
fi
if [ -n "${TMUX:-}" ]; then
  tmux select-window -t "$SESSION:${started[0]}" 2>/dev/null || true
else
  exec tmux attach -t "$SESSION"
fi
