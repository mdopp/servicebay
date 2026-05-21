#!/usr/bin/env bash
# Run the ServiceBay container locally and exercise the backend API end-to-
# end, the same way the wizard would — minus the browser. This is the test
# loop that should have caught #757, the ssh2-missing crash, and the
# `Argument list too long` agent regression long before they hit a real
# install. Fully scripted, ~60 s round-trip from "podman build" to verdict.
#
# Usage:
#   scripts/test-container-e2e.sh                  # uses servicebay-test:fix
#   scripts/test-container-e2e.sh <image>          # explicit tag
#   scripts/test-container-e2e.sh ghcr.io/...:latest
#
# Exit codes:
#   0  — every probe passed
#   1  — image won't start / port never binds
#   2  — auth / contract endpoints regress
#   3  — runtime errors that should never appear in healthy logs
set -uo pipefail

IMAGE="${1:-servicebay-test:fix}"
CONTAINER="sb-e2e-$$"
PORT=5891
ADMIN_USER=admin
ADMIN_PASS=admin
DATA_DIR="$(mktemp -d -t sb-e2e-XXXXXX)"
COOKIE_JAR="$(mktemp -t sb-e2e-cookies-XXXXXX)"
LOG_FILE="$(mktemp -t sb-e2e-logs-XXXXXX)"
cleanup() {
  podman logs "$CONTAINER" > "$LOG_FILE" 2>&1 || true
  podman stop "$CONTAINER" > /dev/null 2>&1 || true
  podman rm "$CONTAINER" > /dev/null 2>&1 || true
  rm -rf "$DATA_DIR" "$COOKIE_JAR" 2>/dev/null || true
  if [[ "${VERDICT:-1}" -ne 0 ]] && [[ -s "$LOG_FILE" ]]; then
    echo
    echo "=== last 60 container log lines ==="
    tail -60 "$LOG_FILE"
  fi
  rm -f "$LOG_FILE"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; VERDICT="${2:-1}"; exit "$VERDICT"; }
ok()   { echo "  ✓ $*"; }

# -----------------------------------------------------------------------------
# 1. Pre-seed a minimal data volume so the agent's SSH-key load doesn't
#    drown the logs with the only "expected" startup error.
# -----------------------------------------------------------------------------
echo "→ preparing data volume at $DATA_DIR"
mkdir -p "$DATA_DIR/ssh"
ssh-keygen -t rsa -b 2048 -f "$DATA_DIR/ssh/id_rsa" -N "" -q
chmod 600 "$DATA_DIR/ssh/id_rsa"
cat > "$DATA_DIR/nodes.json" <<EOF
[
  {"Name": "Local", "URI": "ssh://core@127.0.0.1", "Identity": "/app/data/ssh/id_rsa", "Default": true}
]
EOF
ok "data volume seeded"

# -----------------------------------------------------------------------------
# 2. Start container
# -----------------------------------------------------------------------------
echo "→ starting container from $IMAGE"
podman stop "$CONTAINER" 2>/dev/null; podman rm "$CONTAINER" 2>/dev/null
CID=$(podman run -d --name "$CONTAINER" --network host \
  -e PORT="$PORT" \
  -e AUTH_SECRET="$(openssl rand -hex 32)" \
  -e SERVICEBAY_USERNAME="$ADMIN_USER" \
  -e SERVICEBAY_PASSWORD="$ADMIN_PASS" \
  -v "$DATA_DIR:/app/data:Z" \
  "$IMAGE")
[[ -z "$CID" ]] && fail "container failed to start"
ok "container $CID"

# -----------------------------------------------------------------------------
# 3. Wait for HTTP — 60 s budget. We DON'T accept "any 5xx" as ready; we
#    want either a 200 (page) or a 401/redirect (handler reached).
# -----------------------------------------------------------------------------
echo "→ waiting for HTTP on :$PORT"
DEADLINE=$(( $(date +%s) + 60 ))
while true; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 1 "http://localhost:$PORT/" 2>/dev/null || echo 000)
  case "$code" in
    200|301|302|307|308|401|403) ok "HTTP ready (/ → $code)"; break ;;
  esac
  if ! podman ps -q --filter "name=$CONTAINER" | grep -q .; then
    fail "container exited before binding $PORT"
  fi
  [[ $(date +%s) -ge $DEADLINE ]] && fail "timeout waiting for HTTP on $PORT"
  sleep 1
done

# -----------------------------------------------------------------------------
# 3b. Agent-script size guard. The SSH bootstrap command inlines the
#     gzip+base64-encoded agent.py + scripts directly in the argv to
#     `python3 -u -c '...'` on the remote host. Linux's MAX_ARG_STRLEN
#     caps a single argv string at PAGE_SIZE * 32 = 131072 B. Going
#     over kills the remote bash with "Argument list too long" — but
#     only when an actual SSH route exists, which the standalone test
#     container can't reach. Compute the wire payload directly so this
#     class of regression is caught here instead of waiting for a real
#     install. Threshold is the encoded payload alone; the wrapper
#     command around it adds ~120 B which leaves plenty of headroom.
# -----------------------------------------------------------------------------
echo "→ checking agent bootstrap payload size"
# Detect which encoding the bundle uses by grepping the minified
# server.cjs. The fix added `zlib.gzipSync` to the encoder path; older
# bundles only have `.toString("base64")`.
if podman exec "$CONTAINER" grep -q 'gzipSync' /app/dist-server/server.cjs 2>/dev/null; then
  USES_GZIP=1
  ENCODING="gzip+base64"
else
  USES_GZIP=0
  ENCODING="base64-only"
fi
# Extract the inlined agent script from the container and compute the
# wire payload on the host — embedding a node one-liner inside
# `podman exec sh -c "..."` is a quoting minefield with embedded
# `$` and quotes. Stream the bytes out, compute locally.
AGENT_TMP="$(mktemp)"
podman exec "$CONTAINER" cat /app/src/lib/agent/v4/agent.py /app/src/lib/agent/v4/scripts/nginx_inspector.sh > "$AGENT_TMP" 2>/dev/null
if [[ ! -s "$AGENT_TMP" ]]; then
  rm -f "$AGENT_TMP"
  fail "could not read agent script from container" 3
fi
if [[ "$USES_GZIP" -eq 1 ]]; then
  PAYLOAD_BYTES=$(gzip -c "$AGENT_TMP" | base64 -w0 | wc -c)
else
  PAYLOAD_BYTES=$(base64 -w0 < "$AGENT_TMP" | wc -c)
fi
rm -f "$AGENT_TMP"
MAX_ARG_STRLEN=131072
if [[ "$PAYLOAD_BYTES" -ge "$MAX_ARG_STRLEN" ]]; then
  fail "agent bootstrap payload is $PAYLOAD_BYTES B ($ENCODING) >= MAX_ARG_STRLEN=$MAX_ARG_STRLEN. Remote bash will reject with 'Argument list too long' as soon as the agent SSH route comes up." 3
fi
ok "agent payload $PAYLOAD_BYTES B ($ENCODING, under $MAX_ARG_STRLEN MAX_ARG_STRLEN)"

# -----------------------------------------------------------------------------
# 4. Crash-signature scan — these never appear on a healthy boot.
# -----------------------------------------------------------------------------
echo "→ scanning early logs for crash signatures"
SIGS='Cannot find module|MODULE_NOT_FOUND|Argument list too long|Error: ENOENT|forceStatic|cannot start service|crashed'
if podman logs "$CONTAINER" 2>&1 | head -200 | grep -qE "$SIGS"; then
  podman logs "$CONTAINER" 2>&1 | grep -E "$SIGS" | head -10
  fail "container booted with crash signatures (see above)" 3
fi
ok "no boot-level crash signatures"

# -----------------------------------------------------------------------------
# 5. Authenticate
# -----------------------------------------------------------------------------
echo "→ logging in as $ADMIN_USER"
# ServiceBay's proxy.ts middleware rejects cross-site POSTs (CSRF). Set
# Origin to match the host so the same-origin check passes — this is what
# a browser would do automatically.
LOGIN_RESP=$(curl -sS -o /dev/null -w '%{http_code}' \
  -c "$COOKIE_JAR" \
  -H 'Content-Type: application/json' \
  -H "Origin: http://localhost:$PORT" \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" \
  "http://localhost:$PORT/api/auth/login" 2>/dev/null || echo 000)
case "$LOGIN_RESP" in
  200|204) ok "login (HTTP $LOGIN_RESP)" ;;
  *) fail "login returned $LOGIN_RESP (expected 200/204)" 2 ;;
esac

# -----------------------------------------------------------------------------
# 6. Hit the contract endpoints with the session — these are the same ones
#    the wizard / install pipeline call. Each must return 2xx; any 5xx is a
#    regression that the test loop would have caught.
# -----------------------------------------------------------------------------
probe() {
  local method="$1" path="$2" body="${3:-}" expect_low="${4:-200}" expect_high="${5:-299}"
  local code
  if [[ -n "$body" ]]; then
    code=$(curl -sS -o /dev/null -w '%{http_code}' \
      -b "$COOKIE_JAR" \
      -X "$method" \
      -H 'Content-Type: application/json' \
      -H "Origin: http://localhost:$PORT" \
      -d "$body" \
      "http://localhost:$PORT$path" 2>/dev/null || echo 000)
  else
    code=$(curl -sS -o /dev/null -w '%{http_code}' \
      -b "$COOKIE_JAR" \
      -X "$method" \
      -H "Origin: http://localhost:$PORT" \
      "http://localhost:$PORT$path" 2>/dev/null || echo 000)
  fi
  if [[ "$code" -ge "$expect_low" && "$code" -le "$expect_high" ]]; then
    ok "$method $path → $code"
  else
    fail "$method $path → $code (expected $expect_low–$expect_high)" 2
  fi
}

echo "→ contract endpoints"
probe GET  /api/system/version
probe GET  /api/install/status
probe POST /api/install/generate-secret '{}'
probe POST /api/templates/parse-dependencies '{"yaml":"metadata:\n  annotations:\n    servicebay.dependencies: \"auth,nginx\"\n"}'
probe POST /api/services/validate-yaml '{"yaml":"apiVersion: v1\nkind: Pod\nmetadata:\n  name: hello\n"}'

# -----------------------------------------------------------------------------
# 7. Late-log error scan — anything that surfaced *after* startup. Soft
#    signal: bootstrap retries (no SSH route to host loopback) are
#    expected in a standalone container; only fail on signatures we know
#    indicate a real bug.
# -----------------------------------------------------------------------------
echo "→ scanning late logs for regression signatures"
LATE_SIGS='Argument list too long|MODULE_NOT_FOUND|Failed to decrypt secret'
if podman logs "$CONTAINER" 2>&1 | grep -qE "$LATE_SIGS"; then
  podman logs "$CONTAINER" 2>&1 | grep -E "$LATE_SIGS" | head -5
  fail "regression signatures in late logs (see above)" 3
fi
ok "no regression signatures in late logs"

VERDICT=0
echo
echo "✓ e2e PASSED  ($IMAGE)"
