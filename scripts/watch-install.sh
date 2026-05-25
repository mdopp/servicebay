#!/usr/bin/env bash
#
# watch-install.sh — terminal-side install monitor for a ServiceBay box.
#
# Prints a line every time the box's state changes:
#   - reboot vs reachable (ICMP)
#   - port :5888 open vs not
#   - current install stage (scraped from the splash page's <title>)
#
# Auto-discovers the target from build/fcos/install-settings.env if present,
# or accepts HOST + PORT positional args (or SB_HOST / SB_PORT env vars).
# Exits cleanly when the real ServiceBay wizard takes over (title is the
# operator's hostname rather than "ServiceBay setup — …") or on Ctrl+C,
# with a one-line summary of reboots seen + total elapsed.
#
# Usage:
#   ./scripts/watch-install.sh                       # auto-discover
#   ./scripts/watch-install.sh 192.168.178.100 5888  # explicit
#   SB_HOST=… SB_PORT=… ./scripts/watch-install.sh   # via env
#
# Bash, no external deps beyond ping / curl / grep / sed / date.

set -u

# ──────────────── settings discovery ────────────────

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SETTINGS_FILE="$REPO_ROOT/build/fcos/install-settings.env"

DEFAULT_HOST=""
DEFAULT_PORT=""
if [[ -f "$SETTINGS_FILE" ]]; then
  DEFAULT_HOST="$(grep -oP '^STATIC_IP=\K.*' "$SETTINGS_FILE" 2>/dev/null || true)"
  DEFAULT_PORT="$(grep -oP '^SERVICEBAY_PORT=\K.*' "$SETTINGS_FILE" 2>/dev/null || true)"
fi

HOST="${1:-${SB_HOST:-$DEFAULT_HOST}}"
PORT="${2:-${SB_PORT:-$DEFAULT_PORT}}"
PORT="${PORT:-5888}"

if [[ -z "$HOST" ]]; then
  echo "error: no target host." >&2
  echo "  usage: $0 <host> [port]" >&2
  echo "  or:    SB_HOST=… SB_PORT=… $0" >&2
  echo "  or:    populate STATIC_IP in $SETTINGS_FILE" >&2
  exit 2
fi

# ──────────────── pretty output ────────────────

if [[ -t 1 ]]; then
  C_GREEN=$'\e[32m'; C_RED=$'\e[31m'; C_YELLOW=$'\e[33m'
  C_DIM=$'\e[2m'; C_BOLD=$'\e[1m'; C_RESET=$'\e[0m'
else
  C_GREEN=""; C_RED=""; C_YELLOW=""; C_DIM=""; C_BOLD=""; C_RESET=""
fi

dot_ok=$'●'   # ●
dot_no=$'○'   # ○

# ──────────────── probes ────────────────

probe_icmp() {
  ping -c 1 -W 1 "$HOST" >/dev/null 2>&1
}

probe_tcp() {
  # Use bash's /dev/tcp — fast, no dep on nc/netcat.
  ( exec 3<>/dev/tcp/"$HOST"/"$PORT" ) >/dev/null 2>&1 && return 0
  return 1
}

probe_title() {
  # Pull the splash <title>. Strip the leading "ServiceBay setup — " prefix
  # so the stage shows cleanly. If the title doesn't have that prefix, the
  # real wizard has taken over.
  local title
  title="$(curl -sk -m 3 "http://$HOST:$PORT/" 2>/dev/null \
           | grep -oE '<title>[^<]+</title>' \
           | head -1 \
           | sed -e 's|<title>||' -e 's|</title>||')"
  printf '%s' "$title"
}

is_wizard_title() {
  # The splash always says "ServiceBay setup — …". Anything else means
  # the real Next.js server has taken over.
  local t="$1"
  [[ -n "$t" && "$t" != "ServiceBay setup"* ]]
}

# ──────────────── state machine ────────────────

START_TS=$(date +%s)
REBOOTS=0
STAGES_SEEN=0
PREV_ICMP=""
PREV_TCP=""
PREV_TITLE=""
LAST_LINE_TS=0

print_line() {
  # $1 icmp_ok ("yes"/"no"), $2 tcp_ok ("yes"/"no"), $3 msg, $4 dim (optional "y")
  local icmp="$1" tcp="$2" msg="$3" dim="${4:-}"
  local time_str
  time_str="$(date +%H:%M:%S)"
  local icmp_glyph tcp_glyph
  if [[ "$icmp" == yes ]]; then icmp_glyph="${C_GREEN}${dot_ok}${C_RESET}"; else icmp_glyph="${C_RED}${dot_no}${C_RESET}"; fi
  if [[ "$tcp"  == yes ]]; then tcp_glyph="${C_GREEN}${dot_ok}${C_RESET}";  else tcp_glyph="${C_RED}${dot_no}${C_RESET}";  fi
  local prefix="${C_DIM}${time_str}${C_RESET}  ${icmp_glyph} icmp  ${tcp_glyph} :${PORT}  "
  if [[ "$dim" == y ]]; then
    printf '%s%s%s\n' "$prefix" "$C_DIM" "$msg" "$C_RESET"
  else
    printf '%s%s\n' "$prefix" "$msg"
  fi
  LAST_LINE_TS=$(date +%s)
}

elapsed_human() {
  # $1 seconds → "1m23s" / "47s" / "1h05m"
  local s="$1"
  if (( s < 60 )); then
    printf '%ds' "$s"
  elif (( s < 3600 )); then
    printf '%dm%02ds' $((s/60)) $((s%60))
  else
    printf '%dh%02dm' $((s/3600)) $(( (s%3600)/60 ))
  fi
}

print_summary() {
  local total=$(( $(date +%s) - START_TS ))
  echo
  printf '%sTotal:%s %s, %s%d reboot%s%s, %d stage%s observed.\n' \
    "$C_BOLD" "$C_RESET" \
    "$(elapsed_human "$total")" \
    "$C_BOLD" "$REBOOTS" "$([ "$REBOOTS" -eq 1 ] && echo "" || echo "s")" "$C_RESET" \
    "$STAGES_SEEN" \
    "$([ "$STAGES_SEEN" -eq 1 ] && echo "" || echo "s")"
}

# Print summary on any exit path.
on_exit() {
  print_summary
}
trap on_exit EXIT
trap 'exit 130' INT TERM

# ──────────────── header ────────────────

printf '%sServiceBay install monitor%s — target: %s%s:%s%s%s\n' \
  "$C_BOLD" "$C_RESET" "$C_BOLD" "$HOST" "$PORT" "$C_RESET" \
  "$([[ -f "$SETTINGS_FILE" && -z "${1:-}" && -z "${SB_HOST:-}" ]] && echo " (from build/fcos/install-settings.env)" || echo "")"
echo

# ──────────────── main loop ────────────────

FIRST_ITER=1
while true; do
  if probe_icmp; then icmp="yes"; else icmp="no"; fi
  if [[ "$icmp" == yes ]] && probe_tcp; then tcp="yes"; else tcp="no"; fi
  if [[ "$tcp"  == yes ]]; then title="$(probe_title)"; else title=""; fi

  # Wizard-takeover check runs before the change-detection so we exit cleanly
  # regardless of what state we started in.
  if [[ -n "$title" ]] && is_wizard_title "$title"; then
    print_line "$icmp" "$tcp" "${C_GREEN}${C_BOLD}→ ServiceBay wizard is live${C_RESET}  ${C_DIM}(title: \"$title\")${C_RESET}"
    echo
    printf '   %sSetup wizard:%s  %shttp://%s:%s/setup%s\n' \
      "$C_BOLD" "$C_RESET" "$C_GREEN" "$HOST" "$PORT" "$C_RESET"
    printf '   %sDashboard:   %s  %shttp://%s:%s/%s\n' \
      "$C_BOLD" "$C_RESET" "$C_DIM" "$HOST" "$PORT" "$C_RESET"
    echo
    exit 0
  fi

  # On the first iteration, print whatever state we found — operator gets
  # immediate context instead of having to wait for a transition.
  state_changed=0
  if (( FIRST_ITER )); then
    if [[ -n "$title" ]]; then
      stage="${title#ServiceBay setup — }"
      print_line "$icmp" "$tcp" "$stage  ${C_DIM}(current)${C_RESET}"
    elif [[ "$tcp" == yes ]]; then
      print_line "$icmp" "$tcp" "${C_DIM}port :$PORT open, no splash content yet${C_RESET}"
    elif [[ "$icmp" == yes ]]; then
      print_line "$icmp" "$tcp" "${C_DIM}network reachable, port :$PORT closed${C_RESET}"
    else
      print_line "$icmp" "$tcp" "${C_YELLOW}no signal — box may be rebooting or off${C_RESET}"
    fi
    FIRST_ITER=0
    state_changed=1
  elif [[ "$icmp" != "$PREV_ICMP" ]]; then
    if [[ "$icmp" == no && "$PREV_ICMP" == yes ]]; then
      REBOOTS=$((REBOOTS+1))
      print_line "$icmp" "$tcp" "${C_YELLOW}REBOOTING…${C_RESET} (reboot #${REBOOTS} since start)"
    elif [[ "$icmp" == no ]]; then
      print_line "$icmp" "$tcp" "${C_YELLOW}REBOOTING…${C_RESET}"
    elif [[ "$icmp" == yes ]]; then
      print_line "$icmp" "$tcp" "${C_DIM}network up, services starting${C_RESET}"
    fi
    state_changed=1
  elif [[ "$tcp" != "$PREV_TCP" ]]; then
    if [[ "$tcp" == yes ]]; then
      print_line "$icmp" "$tcp" "${C_DIM}port :$PORT open${C_RESET}"
    else
      print_line "$icmp" "$tcp" "${C_DIM}port :$PORT closed${C_RESET}"
    fi
    state_changed=1
  elif [[ "$title" != "$PREV_TITLE" && -n "$title" ]]; then
    # Stage update — strip the "ServiceBay setup — " prefix.
    stage="${title#ServiceBay setup — }"
    print_line "$icmp" "$tcp" "$stage"
    STAGES_SEEN=$((STAGES_SEEN+1))
    state_changed=1
  fi

  # Heartbeat: print a dimmed line every 30 s when nothing has changed,
  # so the operator knows the script is alive.
  now=$(date +%s)
  if (( state_changed == 0 )) && (( now - LAST_LINE_TS >= 30 )); then
    if [[ "$tcp" == yes && -n "$title" ]]; then
      stage="${title#ServiceBay setup — }"
      since=$(elapsed_human $(( now - LAST_LINE_TS )))
      print_line "$icmp" "$tcp" "(still: $stage — $since)" "y"
    else
      print_line "$icmp" "$tcp" "(still: rebooting / waiting)" "y"
    fi
  fi

  PREV_ICMP="$icmp"
  PREV_TCP="$tcp"
  PREV_TITLE="$title"
  sleep 2
done
