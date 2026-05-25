#!/usr/bin/env bash
#
# install-tui.sh — full-screen terminal dashboard for a ServiceBay box's install.
#
# Mirrors what the in-browser splash SPA shows: current stage + description,
# connection status, elapsed-at-stage timer, and a live tail of the
# install log (rpm-ostree progress, nvidia-ctk enumeration, etc.).
# Refreshes every 1 s, redraws via alt-screen buffer + per-line clear
# so there's no full-screen-clear flicker between ticks.
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

# Anti-flicker: instead of `\033[2J\033[H` (clear-entire-screen + home),
# which causes a visible "blank then redraw" on each tick, we use the
# alternate screen buffer + hide cursor + per-line clear (\033[K) so the
# only visible change between ticks is the actual content that changed.
#
#   \033[?1049h    enter alternate screen buffer (preserves scrollback)
#   \033[?1049l    leave alternate screen buffer
#   \033[?25l      hide cursor
#   \033[?25h      show cursor
#   \033[H         move cursor to home (top-left), without clearing
#   \033[K         clear from cursor to end of line
#   \033[J         clear from cursor to end of screen
ALT_ENTER=$'\033[?1049h\033[?25l'   # enter alt screen + hide cursor
ALT_LEAVE=$'\033[?25h\033[?1049l'   # show cursor + leave alt screen
HOME=$'\033[H'
ELINE=$'\033[K'
EREST=$'\033[J'

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
    local status_epoch
    status_epoch=$(date -u -d "$status_ts_iso" +%s 2>/dev/null || echo 0)
    if (( status_epoch > 0 )); then
      updated_str="$(fmt_dur $((now - status_epoch))) ago"
    fi
  fi

  # Build the full frame in a buffer so we can flush it in one printf —
  # any extra cursor moves caused by printf inside a loop create flicker.
  # Each line ends with `\033[K` to wipe leftover chars from the previous
  # render (in case the new line is shorter). The whole frame is preceded
  # by `\033[H` (home) — no clear-screen, that's the flicker source.
  local buf=""

  # Title bar
  local title_left
  title_left=$(printf '%sServiceBay install monitor%s — %s%s:%s%s' \
    "$C_BOLD" "$C_RESET" "$C_BOLD" "$HOST" "$PORT" "$C_RESET")
  local visible_left_len=$((30 + ${#HOST} + ${#PORT} + 1))
  local pad=$((cols - visible_left_len - ${#now_clock}))
  (( pad < 1 )) && pad=1
  buf+="${title_left}$(printf '%*s' "$pad" '')${C_DIM}${now_clock}${C_RESET}${ELINE}"$'\n'
  buf+="${C_DIM}${rule}${C_RESET}${ELINE}"$'\n'
  buf+="${ELINE}"$'\n'

  # Stage block
  if [[ -n "$stage" ]]; then
    buf+="  ${C_BOLD}Stage${C_RESET}    ${C_GREEN}${stage}${C_RESET}${ELINE}"$'\n'
    if [[ -n "$stage_desc" ]]; then
      # Truncate desc to terminal width so it doesn't wrap (which would
      # bump the rest of the frame down and cause visible jitter).
      local desc_max=$((cols - 13))
      local desc_trunc="${stage_desc:0:$desc_max}"
      buf+="           ${C_DIM}${desc_trunc}${C_RESET}${ELINE}"$'\n'
    else
      buf+="${ELINE}"$'\n'
    fi
  elif [[ "$tcp" == yes ]]; then
    buf+="  ${C_BOLD}Stage${C_RESET}    ${C_DIM}(port open, no status yet)${C_RESET}${ELINE}"$'\n'
    buf+="${ELINE}"$'\n'
  elif [[ "$icmp" == yes ]]; then
    buf+="  ${C_BOLD}Stage${C_RESET}    ${C_YELLOW}(network up, services starting)${C_RESET}${ELINE}"$'\n'
    buf+="${ELINE}"$'\n'
  else
    buf+="  ${C_BOLD}Stage${C_RESET}    ${C_YELLOW}REBOOTING…${C_RESET}${ELINE}"$'\n'
    buf+="${ELINE}"$'\n'
  fi
  buf+="${ELINE}"$'\n'

  # Status + meta rows
  buf+="  ${C_BOLD}Status${C_RESET}   ${icmp_glyph}   ${tcp_glyph}   ${badge_color}[${badge_text}]${C_RESET}${ELINE}"$'\n'
  local meta="  ${C_BOLD}Meta${C_RESET}     elapsed ${C_BOLD}$(fmt_dur "$elapsed")${C_RESET}"
  if [[ -n "$stage" ]]; then
    meta+="   |   at stage ${C_BOLD}$(fmt_dur "$stage_elapsed")${C_RESET}"
  fi
  meta+="   |   reboots ${C_BOLD}${REBOOTS}${C_RESET}"
  if [[ -n "$updated_str" ]]; then
    meta+="   |   updated ${C_BOLD}${updated_str}${C_RESET}"
  fi
  buf+="${meta}${ELINE}"$'\n'
  buf+="${ELINE}"$'\n'

  # Recent activity heading + log
  buf+="${C_HEAD}─── Recent install activity ${rule:28}${C_RESET}${ELINE}"$'\n'
  buf+="${ELINE}"$'\n'
  if [[ -n "$log_text" ]]; then
    # last ~18 lines, truncated to terminal width
    while IFS= read -r ln; do
      buf+="  ${ln:0:$((cols-4))}${ELINE}"$'\n'
    done < <(printf '%s' "$log_text" | tail -18)
  else
    buf+="  ${C_DIM}(no log content yet — splash quadlet may still be starting)${C_RESET}${ELINE}"$'\n'
  fi
  buf+="${ELINE}"$'\n'
  buf+="${C_DIM}Ctrl+C to exit${C_RESET}${ELINE}"$'\n'

  # Single atomic write: home, then the whole frame, then wipe anything
  # below (e.g. if the log shrank between ticks).
  printf '%s%s%s' "$HOME" "$buf" "$EREST"
}

# ──────────────── alt-screen lifecycle ────────────────

# Enter the alternate screen buffer + hide the cursor. The terminal
# preserves the operator's previous content (prompt, scrollback) so when
# the script exits, everything looks like nothing happened.
if [[ -t 1 ]]; then
  printf '%s' "$ALT_ENTER"
fi

cleanup() {
  if [[ -t 1 ]]; then
    printf '%s' "$ALT_LEAVE"
  fi
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
        # Leave alt screen first so the goodbye banner lands in the
        # operator's normal scrollback (and survives terminal close).
        if [[ -t 1 ]]; then printf '%s' "$ALT_LEAVE"; fi
        printf '\n%s%s→ ServiceBay wizard is live%s\n\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
        printf '   %sSetup wizard:%s  %shttp://%s:%s/setup%s\n' \
          "$C_BOLD" "$C_RESET" "$C_GREEN" "$HOST" "$PORT" "$C_RESET"
        printf '   %sDashboard:%s     %shttp://%s:%s/%s\n\n' \
          "$C_BOLD" "$C_RESET" "$C_DIM" "$HOST" "$PORT" "$C_RESET"
        total=$(( $(date +%s) - START_TS ))
        printf '   Total: %s, %d reboots observed.\n\n' "$(fmt_dur "$total")" "$REBOOTS"
        # Re-arm cleanup so it doesn't try to leave alt screen twice.
        trap - EXIT
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
