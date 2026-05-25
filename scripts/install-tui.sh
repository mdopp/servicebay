#!/usr/bin/env bash
#
# install-tui.sh — full-screen terminal dashboard for a ServiceBay box's install.
#
# Mirrors what the in-browser splash SPA shows: current stage + description,
# connection status, elapsed-at-stage timer, and a live tail of the
# install log (rpm-ostree progress, nvidia-ctk enumeration, etc.).
# Refreshes every 1 s.
#
# Differences vs scripts/watch-install.sh:
#   - TUI clears + redraws the screen each tick. No scrollback of the
#     log itself — use watch-install.sh if you want a chronological log
#     in the terminal scrollback that you can grep / copy.
#   - Shows the live tail of the splash's /log.txt (the same content
#     the browser sees), not just stage titles.
#   - Higher update frequency (1 s vs 2 s).
#
# Auto-discovers the target from build/fcos/install-settings.env if present,
# or accepts HOST + PORT positional args (or SB_HOST / SB_PORT env vars).
# Exits cleanly when ServiceBay's wizard takes over, or on Ctrl+C.
#
# Bash only, no deps beyond ping / curl / grep / sed / date / tail.

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
  exit 2
fi

# ──────────────── ANSI ────────────────

if [[ -t 1 ]]; then
  C_GREEN=$'\e[32m'; C_RED=$'\e[31m'; C_YELLOW=$'\e[33m'
  C_DIM=$'\e[2m';   C_BOLD=$'\e[1m'; C_RESET=$'\e[0m'
  C_HEAD=$'\e[36m'  # heading rule
else
  C_GREEN=""; C_RED=""; C_YELLOW=""; C_DIM=""; C_BOLD=""; C_RESET=""; C_HEAD=""
fi

CLEAR=$'\033[2J\033[H'

# ──────────────── probes ────────────────

probe_icmp() { ping -c 1 -W 1 "$HOST" >/dev/null 2>&1; }
probe_tcp()  { ( exec 3<>/dev/tcp/"$HOST"/"$PORT" ) >/dev/null 2>&1; }
probe_status() { curl -sk -m 3 "http://$HOST:$PORT/status.txt" 2>/dev/null; }
probe_log()    { curl -sk -m 3 "http://$HOST:$PORT/log.txt"    2>/dev/null; }
probe_root_title() {
  curl -sk -m 3 "http://$HOST:$PORT/" 2>/dev/null \
    | grep -oE '<title>[^<]+</title>' | head -1 \
    | sed -e 's|<title>||' -e 's|</title>||'
}

# ──────────────── state ────────────────

START_TS=$(date +%s)
REBOOTS=0
PREV_ICMP=""
PREV_STAGE=""
STAGE_START_TS=$START_TS

# Track last-good status timestamp from the box (for the "updated Xs ago" line)
LAST_STATUS_TS=""
CONSECUTIVE_FAILS=0

fmt_dur() {
  local s=$1
  if   (( s < 60 ));   then printf '%ds' "$s"
  elif (( s < 3600 )); then printf '%dm%02ds' $((s/60)) $((s%60))
  else                      printf '%dh%02dm' $((s/3600)) $(( (s%3600)/60 ))
  fi
}

# ──────────────── render ────────────────

render() {
  local now=$1 icmp=$2 tcp=$3 stage=$4 stage_desc=$5 log_text=$6 status_ts_iso=$7
  local now_clock; now_clock=$(date +'%H:%M:%S')
  local elapsed=$((now - START_TS))
  local stage_elapsed=$((now - STAGE_START_TS))
  local cols; cols=$(tput cols 2>/dev/null || echo 80)
  local rule
  rule=$(printf '─%.0s' $(seq 1 $((cols-1))))

  # Connection glyph
  local icmp_glyph tcp_glyph badge_text badge_color
  if [[ "$icmp" == yes ]]; then icmp_glyph="${C_GREEN}●${C_RESET} ping"; else icmp_glyph="${C_RED}○${C_RESET} ping"; fi
  if [[ "$tcp"  == yes ]]; then tcp_glyph="${C_GREEN}●${C_RESET} :${PORT}"; else tcp_glyph="${C_RED}○${C_RESET} :${PORT}"; fi
  if (( CONSECUTIVE_FAILS == 0 )) && [[ "$tcp" == yes ]]; then
    badge_text="connected"; badge_color=$C_GREEN
  elif [[ "$icmp" == yes ]]; then
    badge_text="reconnecting…"; badge_color=$C_YELLOW
  else
    badge_text="OFFLINE"; badge_color=$C_RED
  fi

  # Build "updated X ago" from the status.txt timestamp
  local updated_str=""
  if [[ -n "$status_ts_iso" ]]; then
    # Convert ISO ts to epoch (BSD/GNU date both accept -d on linux)
    local status_epoch
    status_epoch=$(date -u -d "$status_ts_iso" +%s 2>/dev/null || echo 0)
    if (( status_epoch > 0 )); then
      updated_str="$(fmt_dur $((now - status_epoch))) ago"
    fi
  fi

  # Emit screen
  printf '%s' "$CLEAR"

  # Title bar
  printf '%sServiceBay install monitor%s — %s%s:%s%s' \
    "$C_BOLD" "$C_RESET" "$C_BOLD" "$HOST" "$PORT" "$C_RESET"
  # Right-align the clock
  local title_left_len=$((30 + ${#HOST} + ${#PORT} + 1))
  local pad=$((cols - title_left_len - ${#now_clock}))
  (( pad < 1 )) && pad=1
  printf '%*s%s%s%s\n' "$pad" '' "$C_DIM" "$now_clock" "$C_RESET"
  printf '%s%s%s\n\n' "$C_DIM" "$rule" "$C_RESET"

  # Stage
  if [[ -n "$stage" ]]; then
    printf '  %sStage%s    %s%s%s\n' "$C_BOLD" "$C_RESET" "$C_GREEN" "$stage" "$C_RESET"
    if [[ -n "$stage_desc" ]]; then
      printf '           %s%s%s\n' "$C_DIM" "$stage_desc" "$C_RESET"
    fi
  elif [[ "$tcp" == yes ]]; then
    printf '  %sStage%s    %s(port open, no status yet)%s\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$C_RESET"
  elif [[ "$icmp" == yes ]]; then
    printf '  %sStage%s    %s(network up, services starting)%s\n' "$C_BOLD" "$C_RESET" "$C_YELLOW" "$C_RESET"
  else
    printf '  %sStage%s    %sREBOOTING…%s\n' "$C_BOLD" "$C_RESET" "$C_YELLOW" "$C_RESET"
  fi
  printf '\n'

  # Connection + meta row
  printf '  %sStatus%s   %s   %s   %s[%s]%s\n' \
    "$C_BOLD" "$C_RESET" "$icmp_glyph" "$tcp_glyph" "$badge_color" "$badge_text" "$C_RESET"
  printf '  %sMeta%s     elapsed %s%s%s' \
    "$C_BOLD" "$C_RESET" "$C_BOLD" "$(fmt_dur "$elapsed")" "$C_RESET"
  if [[ -n "$stage" ]]; then
    printf '   |   at stage %s%s%s' "$C_BOLD" "$(fmt_dur "$stage_elapsed")" "$C_RESET"
  fi
  printf '   |   reboots %s%d%s' "$C_BOLD" "$REBOOTS" "$C_RESET"
  if [[ -n "$updated_str" ]]; then
    printf '   |   updated %s%s%s' "$C_BOLD" "$updated_str" "$C_RESET"
  fi
  printf '\n\n'

  # Recent activity rule + last N log lines
  printf '%s─── Recent install activity %s%s\n\n' "$C_HEAD" "${rule:28}" "$C_RESET"
  if [[ -n "$log_text" ]]; then
    # Last ~18 lines, truncated to terminal width so long lines don't wrap.
    printf '%s' "$log_text" | tail -18 | while IFS= read -r ln; do
      printf '  %s\n' "${ln:0:$((cols-4))}"
    done
  else
    printf '  %s(no log content yet — splash quadlet may still be starting)%s\n' "$C_DIM" "$C_RESET"
  fi
  printf '\n'
  printf '%sCtrl+C to exit%s\n' "$C_DIM" "$C_RESET"
}

# ──────────────── exit handling ────────────────

cleanup() {
  # Restore cursor + scroll the title to the bottom of the screen so the
  # operator can see the goodbye message without it being clobbered by the
  # next shell prompt.
  printf '\n'
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ──────────────── main loop ────────────────

while true; do
  if probe_icmp; then icmp="yes"; else icmp="no"; fi
  if [[ "$icmp" == yes ]] && probe_tcp; then tcp="yes"; else tcp="no"; fi

  stage=""; stage_desc=""; log_text=""; status_ts_iso=""
  if [[ "$tcp" == yes ]]; then
    status_line=$(probe_status); status_line="${status_line%$'\n'}"
    if [[ "$status_line" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z ]]; then
      status_ts_iso="${status_line%%$'\t'*}"
      rest="${status_line#*$'\t'}"
      stage="${rest%%$'\t'*}"
      stage_desc="${rest#*$'\t'}"
      log_text=$(probe_log)
      CONSECUTIVE_FAILS=0
    else
      # status.txt not TSV — check for ServiceBay takeover
      root_title=$(probe_root_title)
      if [[ -n "$root_title" && "$root_title" != "ServiceBay setup"* ]]; then
        printf '%s' "$CLEAR"
        printf '\n\n  %s%s→ ServiceBay wizard is live%s\n\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
        printf '     %sSetup wizard:%s  %shttp://%s:%s/setup%s\n' \
          "$C_BOLD" "$C_RESET" "$C_GREEN" "$HOST" "$PORT" "$C_RESET"
        printf '     %sDashboard:%s     %shttp://%s:%s/%s\n\n' \
          "$C_BOLD" "$C_RESET" "$C_DIM" "$HOST" "$PORT" "$C_RESET"
        local total=$(( $(date +%s) - START_TS ))
        printf '  Total: %s, %d reboots observed.\n\n' "$(fmt_dur "$total")" "$REBOOTS"
        exit 0
      fi
      CONSECUTIVE_FAILS=$((CONSECUTIVE_FAILS+1))
    fi
  else
    CONSECUTIVE_FAILS=$((CONSECUTIVE_FAILS+1))
  fi

  # Stage transition tracking
  if [[ -n "$stage" && "$stage" != "$PREV_STAGE" ]]; then
    PREV_STAGE="$stage"
    STAGE_START_TS=$(date +%s)
  fi

  # Reboot counter (icmp:yes → no edge)
  if [[ "$icmp" == no && "$PREV_ICMP" == yes ]]; then
    REBOOTS=$((REBOOTS+1))
  fi
  PREV_ICMP="$icmp"

  render "$(date +%s)" "$icmp" "$tcp" "$stage" "$stage_desc" "$log_text" "$status_ts_iso"
  sleep 1
done
