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

# Random test-user identifiers — keeps concurrent runs (CI + operator
# laptop) from stepping on each other. Two users: one family-only
# (most user-facing tests run against this), one admins+family (the
# positive-admin-path test in section 7).
TEST_USER="sb-smoke-$(date +%s)-$$"
TEST_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
ADMIN_TEST_USER="sb-smoke-admin-$(date +%s)-$$"
ADMIN_TEST_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
LLDAP_ADMIN_TOKEN=""

# Always-runs teardown — even if a check throws.
cleanup() {
  local rc=$?
  if [[ -n "$LLDAP_ADMIN_TOKEN" && $KEEP_USER -eq 0 ]]; then
    for u in "$TEST_USER" "$ADMIN_TEST_USER"; do
      curl -fsS -X POST "http://$HOST:$LLDAP_PORT/api/graphql" \
        -H "Authorization: Bearer $LLDAP_ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"query\":\"mutation { deleteUser(userId: \\\"$u\\\") { ok } }\"}" \
        > /dev/null 2>&1 || true
    done
    info "test users $TEST_USER + $ADMIN_TEST_USER deleted"
  elif [[ $KEEP_USER -eq 1 ]]; then
    printf "\n%sKept test users — clean up manually when done:%s\n" "$YELLOW" "$OFF"
    printf "  family user: %s / %s\n" "$TEST_USER" "$TEST_PASS"
    printf "  admin user:  %s / %s\n" "$ADMIN_TEST_USER" "$ADMIN_TEST_PASS"
  fi
  rm -f /tmp/sb-smoke-cookies.* /tmp/sb-smoke-svc.* /tmp/sb-smoke-token
  exit $rc
}
trap cleanup EXIT

# -------------------- 1. box health --------------------
section "1/7 · Box health — Quadlet units + containers"
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
section "2/7 · LLDAP admin handshake"
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

# Family + admins group ids must exist — Authelia rules key off both.
GROUP_IDS=$(curl -fsS -X POST "http://$HOST:$LLDAP_PORT/api/graphql" \
  -H "Authorization: Bearer $LLDAP_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ groups { id displayName } }"}' \
  | python3 -c "
import json, sys
gs = json.load(sys.stdin)['data']['groups']
fam = next((g['id'] for g in gs if g['displayName']=='family'), '')
adm = next((g['id'] for g in gs if g['displayName']=='admins'), '')
print(f'{fam}|{adm}')")
FAMILY_GID=$(echo "$GROUP_IDS" | cut -d'|' -f1)
ADMINS_GID=$(echo "$GROUP_IDS" | cut -d'|' -f2)
if [[ -z "$FAMILY_GID" ]]; then
  fail "no 'family' group in LLDAP — Authelia rules expect it"
  exit 1
fi
pass "'family' group exists (id=$FAMILY_GID)"
if [[ -z "$ADMINS_GID" ]]; then
  fail "no 'admins' group in LLDAP — Authelia rules for admin domains expect it"
  exit 1
fi
pass "'admins' group exists (id=$ADMINS_GID)"

# Pre-flight: the built-in LLDAP `admin` user must be in `admins`
# so the operator's first hit on https://ldap.<domain>/ passes
# Authelia's admin-domain rule. Without this, the docs' first-run
# flow ("log in as admin to LLDAP and add users to family") returns
# 403 at the door. The auth template's post-deploy.py grants this
# at install — flagging it here catches drift if someone removes
# the membership manually.
admin_groups=$(curl -fsS -X POST "http://$HOST:$LLDAP_PORT/api/graphql" \
  -H "Authorization: Bearer $LLDAP_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ user(userId: \"admin\") { groups { displayName } } }"}' \
  | python3 -c "import json,sys; print(','.join(g.get('displayName','') for g in (json.load(sys.stdin).get('data',{}).get('user',{}).get('groups',[]))))")
if [[ ",${admin_groups}," == *",admins,"* ]]; then
  pass "LLDAP 'admin' user is in 'admins' (Authelia admin-domain login enabled)"
else
  fail "LLDAP 'admin' user is NOT in 'admins' — operator can't log into ldap.<domain> (groups: $admin_groups)"
fi

# -------------------- 3. user lifecycle --------------------
section "3/7 · User lifecycle — create + set password + group-add"

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

# Mirror lifecycle for the admin-group test user used by section 7.
create_admin=$(curl -fsS -X POST "http://$HOST:$LLDAP_PORT/api/graphql" \
  -H "Authorization: Bearer $LLDAP_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation { createUser(user: { id: \\\"$ADMIN_TEST_USER\\\", email: \\\"$ADMIN_TEST_USER@$DOMAIN\\\", displayName: \\\"Smoke Admin\\\" }) { id } }\"}")
if echo "$create_admin" | grep -q "\"id\":\"$ADMIN_TEST_USER\""; then
  pass "createUser($ADMIN_TEST_USER)"
else
  fail "createUser admin failed: $create_admin"
  exit 1
fi
ssh_cmd "podman exec auth-lldap /app/lldap_set_password \
  -u $ADMIN_TEST_USER -p '$ADMIN_TEST_PASS' \
  --base-url http://localhost:$LLDAP_PORT \
  --token '$LLDAP_ADMIN_TOKEN'" > /dev/null 2>&1 && \
  pass "lldap_set_password($ADMIN_TEST_USER)" || fail "lldap_set_password($ADMIN_TEST_USER) failed"
# Add to both groups: admins (for admin-domain ACL match) and family
# (so the wildcard rule still grants user-app access via the same
# session — without family, Authelia's catch-all wouldn't match and
# the admin would be locked out of user apps).
for GID in "$FAMILY_GID" "$ADMINS_GID"; do
  curl -fsS -X POST "http://$HOST:$LLDAP_PORT/api/graphql" \
    -H "Authorization: Bearer $LLDAP_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\":\"mutation { addUserToGroup(userId: \\\"$ADMIN_TEST_USER\\\", groupId: $GID) { ok } }\"}" \
    > /dev/null
done
pass "addUserToGroup($ADMIN_TEST_USER, family + admins)"

# -------------------- 4. Authelia SSO --------------------
section "4/7 · Authelia firstfactor"
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
section "5/7 · User-facing services — hit via SSO cookie"

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
  # Hermes' dashboard is uvicorn-backed and rejects requests whose Host
  # header doesn't match its bind address — caught here as HTTP 400 with
  # `{"detail":"Invalid Host header. ..."}` when NPM forwards
  # `Host: hermes.dopp.cloud` without the `proxy_set_header Host
  # 127.0.0.1:9119;` rewrite from the template's advanced_config. Signature
  # is the literal dashboard title so the test also catches a "200 with
  # wrong content" regression (proxy half-broken).
  [hermes]="Hermes Agent"
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
section "6/7 · Access control — family user MUST NOT reach admin domains"

# These are listed under Authelia's admins-group rule. A family-only
# user should get redirected back to /auth (302) or refused (403 from
# Authelia's verify endpoint), NOT 200 from the upstream app.
#
# `admin.dopp.cloud` is intentionally NOT in this list: ServiceBay
# has its own login on the application layer, and stacking Authelia
# forward-auth on top would double-login the operator whose recovery
# path goes through this UI. The HTML shell at `/` is reachable on
# admin.dopp.cloud but every API call returns 401 without a
# ServiceBay session — covered by integration tests on the
# ServiceBay app itself, not by this smoke test.
for h in nginx dns ldap; do
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

# -------------------- 7. admin path — admins user reaches admin domains --------------------
section "7/7 · Admin path — admins user reaches LLDAP / NPM / AdGuard admin"

# Authelia's admin-domain rule requires `group:admins` AND `policy: two_factor`.
# An admins-group user without 2FA enrolled gets redirected through the
# Authelia 2FA enrollment / challenge flow rather than a clean 200. The
# expected responses are:
#   - 200 if `--max-redirs 0` lands on the upstream after auth (2FA disabled / configured)
#   - 302/303 to auth.<domain>/2fa/... (Authelia challenge — admin can reach the path)
#   - 401 from Authelia's verify endpoint while 2FA pending (also an OK signal —
#     the admin is recognised, just needs to complete 2FA)
# What we MUST NOT see is 403 — that means the admins-group user is
# being denied at the group level (the bug this test catches).
ADMIN_JAR=$(mktemp -t sb-smoke-cookies.XXXXXX)
admin_authelia=$(curl -fsS $RESOLVE_FLAGS -k -c "$ADMIN_JAR" \
  -X POST "https://auth.$DOMAIN/api/firstfactor" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$ADMIN_TEST_USER\",\"password\":\"$ADMIN_TEST_PASS\",\"requestMethod\":\"GET\",\"targetURL\":\"https://ldap.$DOMAIN/\"}")
if echo "$admin_authelia" | grep -q '"status":"OK"'; then
  pass "POST auth.$DOMAIN/api/firstfactor as admins user → OK"
else
  fail "Authelia firstfactor for admin user failed: $admin_authelia"
fi

for h in ldap nginx dns; do
  body=$(mktemp -t sb-smoke-svc.XXXXXX)
  set +e
  code=$(curl -ks $RESOLVE_FLAGS -b "$ADMIN_JAR" \
              --max-redirs 0 \
              -o "$body" -w "%{http_code}" "https://$h.$DOMAIN/" 2>/dev/null)
  curl_rc=$?
  set -e
  [[ $curl_rc -ne 0 && -z "$code" ]] && code="000"

  case "$code" in
    2*|301|302|303|401)
      pass "$h.$DOMAIN → HTTP $code (admins user reaches it — 401/302 = 2FA challenge, both OK)"
      ;;
    403)
      fail "$h.$DOMAIN → HTTP $code: admins user DENIED. The ACL is gated on a group the user doesn't have — check 'admins' membership + Authelia rules."
      ;;
    *)
      fail "$h.$DOMAIN → HTTP $code (transport-level error, can't judge admin path)"
      ;;
  esac
  rm -f "$body"
done
rm -f "$ADMIN_JAR"

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
