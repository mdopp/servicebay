#!/usr/bin/env bash
# Boot the bundled ServiceBay server for the Playwright e2e gate (#2744).
#
# The three specs under tests/e2e/ have existed since #1473 but ran nowhere in
# CI — the only browser gate was the out-of-band Box-Verify. This script is the
# half that CI was missing: it starts the SAME artifact the dev image runs
# (`node dist-server/server.cjs`, see Dockerfile.dev's CMD) against a throwaway
# data dir with no SSH key, so every agent call fails fast instead of hanging.
# That is the "agent stubbed, no box" shape: the UI, the API and the auth path
# are real, the box is simply absent.
#
# It lives in a script rather than inline in ci.yml so the red-probe can be
# reproduced locally with the exact same boot (CLAUDE.md § "Deterministic
# execution → scripts").
#
# Usage (from the repo root, after `npm run build`):
#   scripts/e2e-ci-server.sh start     # boot + wait for HTTP, then return
#   scripts/e2e-ci-server.sh stop      # kill it, print the log on request
#
# Env:
#   SB_E2E_PORT   port to bind          (default 5899)
#   SB_E2E_DIR    state dir for the run (default "$TMPDIR/servicebay-e2e")
#
# `start` writes the credentials + base URL it booted with to
# "$SB_E2E_DIR/env.sh" (and to $GITHUB_ENV when running under Actions), so the
# caller can export them for `npm run test:e2e` without re-deriving them.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
REPO_ROOT=$(dirname "$SCRIPT_DIR")
cd "$REPO_ROOT"

PORT="${SB_E2E_PORT:-5899}"
STATE_DIR="${SB_E2E_DIR:-${TMPDIR:-/tmp}/servicebay-e2e}"
DATA_DIR="$STATE_DIR/data"
PID_FILE="$STATE_DIR/server.pid"
LOG_FILE="$STATE_DIR/server.log"
ENV_FILE="$STATE_DIR/env.sh"
READY_TIMEOUT="${SB_E2E_READY_TIMEOUT:-90}"

log() { printf '▶ %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

stop_server() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if [ -n "$pid" ] && kill -0 "$pid" 2> /dev/null; then
      kill "$pid" 2> /dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2> /dev/null || break
        sleep 0.5
      done
      kill -9 "$pid" 2> /dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
}

case "${1:-start}" in
  start)
    [ -f dist-server/server.cjs ] || die "dist-server/server.cjs is missing — run 'npm run build' first"
    stop_server

    # The port MUST be free before we start. Without this the readiness probe
    # below happily answers from somebody else's server (a leftover run, a dev
    # container) while ours dies of EADDRINUSE — and the specs then fail against
    # a host whose credentials we never set, which reads as a product regression
    # rather than as the setup mistake it is.
    if curl -s -o /dev/null --connect-timeout 2 "http://127.0.0.1:$PORT/" 2> /dev/null; then
      die "something is already listening on :$PORT — stop it (scripts/e2e-ci-server.sh stop) or set SB_E2E_PORT"
    fi

    rm -rf "$STATE_DIR"
    mkdir -p "$DATA_DIR/ssh"

    # How the agent is stubbed: the data dir is fresh and `ssh/` is EMPTY. On
    # boot ServiceBay seeds a default `Local` node pointing at
    # ssh://dev@127.0.0.1 with Identity /app/data/ssh/id_rsa — a path that does
    # not exist here — so every agent attempt fails on the key read before it
    # opens a socket. Fast, loud in the log, and never a hang. Do NOT drop a
    # key in here: a reachable sshd would make the run depend on the host.

    # Bootstrap credentials. ServiceBay hashes SERVICEBAY_PASSWORD into
    # config.json on first login, so this is a per-run throwaway that never
    # reaches a committed file (CLAUDE.md § "Secret hygiene").
    E2E_USER="e2e-admin"
    E2E_PASS=$(openssl rand -hex 16)
    E2E_SECRET=$(openssl rand -hex 32)
    BASE_URL="http://127.0.0.1:$PORT"

    log "booting dist-server/server.cjs on $BASE_URL (data dir $DATA_DIR)"
    DATA_DIR="$DATA_DIR" \
      PORT="$PORT" \
      HOSTNAME=127.0.0.1 \
      NODE_ENV=production \
      AUTH_SECRET="$E2E_SECRET" \
      SERVICEBAY_USERNAME="$E2E_USER" \
      SERVICEBAY_PASSWORD="$E2E_PASS" \
      ASSIST_CATALOG_DIR="$REPO_ROOT/assists" \
      nohup node dist-server/server.cjs > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"

    # Ready when the login page answers. A 5xx is NOT ready — the handler must
    # actually be reached, or the specs would race a half-started server.
    deadline=$(($(date +%s) + READY_TIMEOUT))
    until code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 "$BASE_URL/login" 2> /dev/null || echo 000); [ "$code" = 200 ]; do
      if ! kill -0 "$(cat "$PID_FILE")" 2> /dev/null; then
        cat "$LOG_FILE" >&2
        die "server exited before binding :$PORT"
      fi
      if [ "$(date +%s)" -ge "$deadline" ]; then
        cat "$LOG_FILE" >&2
        die "server did not answer GET /login within ${READY_TIMEOUT}s (last status $code)"
      fi
      sleep 1
    done
    # Belt to the preflight's braces: the server catches uncaughtException and
    # keeps the process alive, so a bind failure is visible only in the log.
    if grep -q 'EADDRINUSE' "$LOG_FILE"; then
      cat "$LOG_FILE" >&2
      die "the server could not bind :$PORT — the probe above answered from a foreign process"
    fi
    log "server ready (GET /login → $code)"

    {
      printf 'export SB_BOX_URL=%s\n' "$BASE_URL"
      printf 'export SB_USERNAME=%s\n' "$E2E_USER"
      printf 'export SB_PASSWORD=%s\n' "$E2E_PASS"
    } > "$ENV_FILE"
    if [ -n "${GITHUB_ENV:-}" ]; then
      {
        printf 'SB_BOX_URL=%s\n' "$BASE_URL"
        printf 'SB_USERNAME=%s\n' "$E2E_USER"
        printf 'SB_PASSWORD=%s\n' "$E2E_PASS"
      } >> "$GITHUB_ENV"
    fi
    log "credentials written to $ENV_FILE"
    ;;

  stop)
    stop_server
    if [ -s "$LOG_FILE" ] && [ -n "${SB_E2E_PRINT_LOG:-}" ]; then
      echo "=== last 80 server log lines ==="
      tail -80 "$LOG_FILE"
    fi
    ;;

  *)
    die "usage: $0 start|stop"
    ;;
esac
