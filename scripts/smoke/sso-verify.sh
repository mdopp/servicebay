#!/usr/bin/env bash
# End-to-end smoke test for ServiceBay's user-auth + per-service stack.
#
# Drives the full operator-realistic flow:
#   1. Box health  — every Quadlet service is `active`, every container is Up.
#   2. LLDAP admin — admin login + GraphQL handshake against :17170.
#   3. User CRUD   — create a fresh test user, set its password via the
#                    in-container `lldap_set_password` binary, join it to
#                    the `family` group.
#   4. Authelia    — POST /api/firstfactor with the new creds, capture the
#                    session cookie.
#   5. Per-app     — hit each user-facing service domain with the cookie,
#                    expect HTTP 2xx/3xx and (where it's a stable string)
#                    a recognisable HTML title or content signature.
#   6. Access ctl  — confirm the `family` user is REJECTED by admin-only
#                    domains (admin.dopp.cloud, nginx.dopp.cloud, ...).
#   7. Cleanup     — delete the test user (always, even on failure).
#
# Exit 0 ⇔ every check passed. Exit 1 with a per-step PASS/FAIL summary
# otherwise.
#
# Usage:
#   scripts/smoke/sso-verify.sh                    # uses defaults below
#   scripts/smoke/sso-verify.sh --keep-user        # leaves the test user
#                                                    in place for poking
#   scripts/smoke/sso-verify.sh --host 10.0.0.42   # different host
#   scripts/smoke/sso-verify.sh --verbose          # log every curl
#
# Requires: ssh key at build/fcos/servicebay-ssh/id_rsa (the same one the
# rest of the repo's tooling uses), bash, curl, openssl, python3.
set -euo pipefail

# -------------------- defaults --------------------
HOST="${SB_HOST:-192.168.178.100}"
SB_PORT="${SB_PORT:-5888}"
LLDAP_PORT="${LLDAP_PORT:-17170}"
DOMAIN="${SB_DOMAIN:-dopp.cloud}"
SSH_KEY="${SB_SSH_KEY:-build/fcos/servicebay-ssh/id_rsa}"
SSH_USER="${SB_SSH_USER:-core}"
KEEP_USER=0
VERBOSE=0

# -------------------- arg parse --------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-user) KEEP_USER=1; shift ;;
    --verbose|-v) VERBOSE=1; shift ;;
    --host) HOST="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# -------------------- helpers --------------------
RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; OFF=$'\033[0m'
PASSED=0; FAILED=0; FAILED_LINES=()

pass() { PASSED=$((PASSED + 1)); printf "  %s✓%s %s\n" "$GREEN" "$OFF" "$1"; }
fail() { FAILED=$((FAILED + 1)); FAILED_LINES+=("$1"); printf "  %s✗%s %s\n" "$RED" "$OFF" "$1"; }
info() { printf "  %s·%s %s\n" "$CYAN" "$OFF" "$1"; }
section() { printf "\n%s%s%s\n" "$YELLOW" "$1" "$OFF"; }

vlog() { (( VERBOSE )) && printf "    %s>%s %s\n" "$CYAN" "$OFF" "$*" >&2 || true; }

ssh_cmd() {
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
      "$SSH_USER@$HOST" "$@"
}

# Curl wrapper that pins SNI to the box's IP via --resolve, since the
# operator running this from outside the LAN may not have *.dopp.cloud
# in their resolver.
RESOLVE_FLAGS=""
build_resolve_flags() {
  local hosts=(auth ldap admin nginx dns)
  hosts+=(vault photos music books home files caldav sync hermes zwave www)
  hosts+=("")  # bare apex
  RESOLVE_FLAGS=""
  for h in "${hosts[@]}"; do
    local fqdn
    if [[ -z "$h" ]]; then fqdn="$DOMAIN"; else fqdn="$h.$DOMAIN"; fi
    RESOLVE_FLAGS+=" --resolve $fqdn:443:$HOST"
  done
}

# Random test-user identifier — keeps concurrent runs (CI + operator
# laptop) from stepping on each other.
TEST_USER="sb-smoke-$(date +%s)-$$"
TEST_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
LLDAP_ADMIN_TOKEN=""

# Always-runs teardown — even if a check throws.
cleanup() {
  local rc=$?
  if [[ -n "$LLDAP_ADMIN_TOKEN" && $KEEP_USER -eq 0 ]]; then
    curl -fsS -X POST "http://$HOST:$LLDAP_PORT/api/graphql" \
      -H "Authorization: Bearer $LLDAP_ADMIN_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"query\":\"mutation { deleteUser(userId: \\\"$TEST_USER\\\") { ok } }\"}" \
      > /dev/null 2>&1 || true
    info "test user $TEST_USER deleted"
  elif [[ $KEEP_USER -eq 1 ]]; then
    printf "\n%sKept test user — clean up manually when done:%s\n" "$YELLOW" "$OFF"
    printf "  username: %s\n  password: %s\n" "$TEST_USER" "$TEST_PASS"
  fi
  rm -f /tmp/sb-smoke-cookies.* /tmp/sb-smoke-svc.* /tmp/sb-smoke-token
  exit $rc
}
trap cleanup EXIT

# -------------------- 1. box health --------------------
section "1/6 · Box health — Quadlet units + containers"
if ! ssh_cmd 'true' &> /dev/null; then
  fail "SSH to $SSH_USER@$HOST failed (key: $SSH_KEY)"
  exit 1
fi
pass "SSH reachable at $SSH_USER@$HOST"

failed_units=$(ssh_cmd 'systemctl --user list-units --type=service --state=failed --no-pager 2>&1 | grep -c "0 loaded units listed" || true')
if [[ "$failed_units" == "1" ]]; then
  pass "0 failed user-systemd services"
else
  fail "user-systemd reports failed units (see: systemctl --user --failed)"
fi

container_count=$(ssh_cmd 'podman ps --format "{{.Names}}" | wc -l')
if [[ "$container_count" -gt 5 ]]; then
  pass "$container_count containers Up"
else
  fail "only $container_count containers Up (expected ≥6 for a basic stack)"
fi

# -------------------- 2. LLDAP admin handshake --------------------
section "2/6 · LLDAP admin handshake"
LLDAP_ADMIN_PASS=$(ssh_cmd 'podman exec auth-lldap printenv LLDAP_LDAP_USER_PASS 2>/dev/null' | tr -d '\r\n')
if [[ -z "$LLDAP_ADMIN_PASS" ]]; then
  fail "could not read LLDAP_LDAP_USER_PASS from auth-lldap container"
  exit 1
fi
pass "LLDAP admin password read from container env"

LLDAP_ADMIN_TOKEN=$(curl -fsS -X POST "http://$HOST:$LLDAP_PORT/auth/simple/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"password\":\"$LLDAP_ADMIN_PASS\"}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))")
if [[ -z "$LLDAP_ADMIN_TOKEN" ]]; then
  fail "LLDAP admin login returned no token"
  exit 1
fi
pass "LLDAP admin /auth/simple/login → JWT"

# Family group id must exist — every test user needs it for the user-app rule.
FAMILY_GID=$(curl -fsS -X POST "http://$HOST:$LLDAP_PORT/api/graphql" \
  -H "Authorization: Bearer $LLDAP_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ groups { id displayName } }"}' \
  | python3 -c "import json,sys; gs=json.load(sys.stdin)['data']['groups']; print(next((g['id'] for g in gs if g['displayName']=='family'), ''))")
if [[ -z "$FAMILY_GID" ]]; then
  fail "no 'family' group in LLDAP — Authelia rules expect it"
  exit 1
fi
pass "'family' group exists (id=$FAMILY_GID)"

# -------------------- 3. user lifecycle --------------------
section "3/6 · User lifecycle — create + set password + group-add"

create_resp=$(curl -fsS -X POST "http://$HOST:$LLDAP_PORT/api/graphql" \
  -H "Authorization: Bearer $LLDAP_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation { createUser(user: { id: \\\"$TEST_USER\\\", email: \\\"$TEST_USER@$DOMAIN\\\", displayName: \\\"Smoke Test\\\" }) { id } }\"}")
vlog "createUser: $create_resp"
if echo "$create_resp" | grep -q "\"id\":\"$TEST_USER\""; then
  pass "createUser($TEST_USER)"
else
  fail "createUser failed: $create_resp"
  exit 1
fi

setpw_out=$(ssh_cmd "podman exec auth-lldap /app/lldap_set_password \
  -u $TEST_USER -p '$TEST_PASS' \
  --base-url http://localhost:$LLDAP_PORT \
  --token '$LLDAP_ADMIN_TOKEN'" 2>&1)
if echo "$setpw_out" | grep -q "Successfully changed"; then
  pass "lldap_set_password($TEST_USER)"
else
  fail "lldap_set_password failed: $setpw_out"
  exit 1
fi

group_resp=$(curl -fsS -X POST "http://$HOST:$LLDAP_PORT/api/graphql" \
  -H "Authorization: Bearer $LLDAP_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation { addUserToGroup(userId: \\\"$TEST_USER\\\", groupId: $FAMILY_GID) { ok } }\"}")
if echo "$group_resp" | grep -q '"ok":true'; then
  pass "addUserToGroup($TEST_USER, family)"
else
  fail "addUserToGroup failed: $group_resp"
fi

# Verify the user can log into LLDAP itself with its new password —
# isolates "password storage broken" from "Authelia config broken".
user_token=$(curl -fsS -X POST "http://$HOST:$LLDAP_PORT/auth/simple/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$TEST_USER\",\"password\":\"$TEST_PASS\"}" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('token',''))")
if [[ -n "$user_token" ]]; then
  pass "LLDAP login as $TEST_USER → JWT (groups: family)"
else
  fail "LLDAP login as $TEST_USER failed"
fi

# -------------------- 4. Authelia SSO --------------------
section "4/6 · Authelia firstfactor"
build_resolve_flags
COOKIE_JAR=$(mktemp -t sb-smoke-cookies.XXXXXX)
authelia_resp=$(curl -fsS $RESOLVE_FLAGS -k -c "$COOKIE_JAR" \
  -X POST "https://auth.$DOMAIN/api/firstfactor" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$TEST_USER\",\"password\":\"$TEST_PASS\",\"requestMethod\":\"GET\",\"targetURL\":\"https://vault.$DOMAIN/\"}")
if echo "$authelia_resp" | grep -q '"status":"OK"'; then
  pass "POST auth.$DOMAIN/api/firstfactor → OK"
else
  fail "Authelia firstfactor failed: $authelia_resp"
  exit 1
fi

if grep -q "authelia_session" "$COOKIE_JAR" 2>/dev/null; then
  pass "Authelia session cookie set"
else
  fail "Authelia session cookie NOT set"
fi

# -------------------- 5. per-service reachability --------------------
section "5/6 · User-facing services — hit via SSO cookie"

# host → expected content signature (case-sensitive grep). Empty value
# means "just expect 2xx/3xx" without content assertion.
declare -A USER_APPS=(
  [vault]="Vaultwarden Web"
  [photos]=""
  [music]=""
  [books]="Audiobookshelf"
  [home]=""
  [files]=""
  [sync]=""
  [caldav]=""
)

for h in "${!USER_APPS[@]}"; do
  sig=${USER_APPS[$h]}
  body=$(mktemp -t sb-smoke-svc.XXXXXX)
  # `|| echo` would CONCAT with curl's own %{http_code} output ("200000"
  # for a 200 that exited non-zero), so we set +e + check the exit code
  # separately. A blank code means a true transport error.
  set +e
  code=$(curl -ks $RESOLVE_FLAGS -b "$COOKIE_JAR" \
              -o "$body" -w "%{http_code}" "https://$h.$DOMAIN/" 2>/dev/null)
  curl_rc=$?
  set -e
  [[ $curl_rc -ne 0 && -z "$code" ]] && code="000"

  if [[ "$code" =~ ^(2[0-9]{2}|3[0-9]{2})$ ]]; then
    if [[ -n "$sig" ]] && ! grep -q "$sig" "$body"; then
      fail "$h.$DOMAIN → HTTP $code but content missing signature '$sig'"
    else
      pass "$h.$DOMAIN → HTTP $code${sig:+ (matched '$sig')}"
    fi
  else
    fail "$h.$DOMAIN → HTTP $code (auth or upstream broken)"
  fi
  rm -f "$body"
done

# -------------------- 6. access control negative --------------------
section "6/6 · Access control — family user MUST NOT reach admin domains"

# These are listed under Authelia's admins-group rule. A family-only
# user should get redirected back to /auth (302) or refused (403 from
# Authelia's verify endpoint), NOT 200 from the upstream app.
for h in admin nginx dns ldap; do
  body=$(mktemp -t sb-smoke-svc.XXXXXX)
  # Single follow-on response — don't chase redirects, so a 302 back
  # to auth.dopp.cloud is the SUCCESS signal here.
  set +e
  code=$(curl -ks $RESOLVE_FLAGS -b "$COOKIE_JAR" \
              --max-redirs 0 \
              -o "$body" -w "%{http_code}" "https://$h.$DOMAIN/" 2>/dev/null)
  curl_rc=$?
  set -e
  [[ $curl_rc -ne 0 && -z "$code" ]] && code="000"

  case "$code" in
    302|303|401|403)
      pass "$h.$DOMAIN → HTTP $code (correctly blocked for family-only user)"
      ;;
    2*)
      fail "$h.$DOMAIN → HTTP $code: family user got in, ACL bypassed"
      ;;
    *)
      fail "$h.$DOMAIN → HTTP $code (transport-level error, can't judge ACL)"
      ;;
  esac
  rm -f "$body"
done

# -------------------- summary --------------------
section "Summary"
printf "  %s%d passed%s · %s%d failed%s\n" \
  "$GREEN" "$PASSED" "$OFF" \
  "$RED" "$FAILED" "$OFF"

if [[ $FAILED -gt 0 ]]; then
  printf "\nFailures:\n"
  for line in "${FAILED_LINES[@]}"; do
    printf "  %s✗%s %s\n" "$RED" "$OFF" "$line"
  done
  exit 1
fi
