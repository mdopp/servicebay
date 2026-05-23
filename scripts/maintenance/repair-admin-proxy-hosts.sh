#!/usr/bin/env bash
# Heal admin / nginx / ldap proxy hosts on a deployed ServiceBay (#878).
#
# What gets patched on a host that needs healing:
#   1. Authelia forward-auth   — adds the `advanced_config` block so
#      nginx makes the auth_request subrequest before forwarding to
#      the upstream. Without this, Authelia's `group:admins` rule
#      never fires and a family-only user reaches the LLDAP / NPM /
#      AdGuard UI directly.
#   2. SSL certificate         — binds a Let's Encrypt cert covering
#      the subdomain. Without one, nginx serves the default cert,
#      the SNI handshake fails with `unrecognized name`, and the
#      browser refuses the connection.
#
# Discovery is idempotent: every domain is fetched, inspected, and
# only patched when its current shape differs from the target. A
# host that's already correct logs `(no change)` and skips.
#
# Usage:
#   scripts/maintenance/repair-admin-proxy-hosts.sh                    # heal & report
#   scripts/maintenance/repair-admin-proxy-hosts.sh --dry-run          # what would change
#   scripts/maintenance/repair-admin-proxy-hosts.sh --host 10.0.0.42   # different box
#   scripts/maintenance/repair-admin-proxy-hosts.sh --no-cert          # forward-auth only
#
# Requires: SSH access to the box (build/fcos/servicebay-ssh/id_rsa)
# + curl + python3.
set -euo pipefail

HOST="${SB_HOST:-192.168.178.100}"
SB_PORT="${SB_PORT:-5888}"
SB_ADMIN_USER="${SB_ADMIN_USER:-admin}"
SB_ADMIN_PASS="${SB_ADMIN_PASS:-}"
DOMAIN="${SB_DOMAIN:-dopp.cloud}"
SSH_KEY="${SB_SSH_KEY:-build/fcos/servicebay-ssh/id_rsa}"
SSH_USER="${SB_SSH_USER:-core}"
DRY_RUN=0
NO_CERT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --no-cert) NO_CERT=1; shift ;;
    --host) HOST="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --help|-h) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; OFF=$'\033[0m'
ssh_cmd() { ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$SSH_USER@$HOST" "$@"; }

# Which subdomains need which fixes. Keep this list narrow — these are
# the three NPM was creating without the right shape per #878. Everything
# else (vault / photos / etc.) is fine as-is.
#
# Subdomain   | Needs forward-auth | Needs cert
# ------------|--------------------|------------
# ldap        | yes  (admins-only) | already has one
# nginx       | yes  (admins-only) | yes
# admin       | no   (ServiceBay has its own auth)        | yes
HOSTS_WITH_FORWARD_AUTH="ldap nginx"
HOSTS_NEEDING_CERT="nginx admin"

# -------------------- NPM admin auth --------------------
info() { printf "%s·%s %s\n" "$CYAN" "$OFF" "$1"; }
pass() { printf "%s✓%s %s\n" "$GREEN" "$OFF" "$1"; }
warn() { printf "%s!%s %s\n" "$YELLOW" "$OFF" "$1"; }
fail() { printf "%s✗%s %s\n" "$RED" "$OFF" "$1"; }

info "Resolving NPM admin credentials..."
# Resolution order:
#   1. NPM_EMAIL + NPM_PASS env vars — operator override, always wins.
#   2. ServiceBay credentials manifest — the auto-saved pair under
#      "Nginx Proxy Manager". Only useful when ServiceBay and NPM
#      haven't drifted; older installs can have a stale entry that
#      NPM never accepted (the npm_data_stale diagnose probe surfaces
#      this case in the dashboard).
#   3. Hard failure with actionable hints. We don't try the
#      `admin@example.com / changeme` NPM default — if we get to step 3
#      the operator needs to look it up themselves.
NPM_EMAIL="${NPM_EMAIL:-}"
NPM_PASS="${NPM_PASS:-}"

if [[ -z "$NPM_PASS" ]]; then
  if [[ -z "$SB_ADMIN_PASS" ]]; then
    fail "Set NPM_EMAIL + NPM_PASS, or SB_ADMIN_PASS to pull from the manifest."
    fail "  NPM admin user/password: open ServiceBay → Settings → Integrations → Reverse Proxy"
    fail "  ServiceBay admin password (for manifest lookup):"
    fail '    ssh '"$SSH_USER"'@'"$HOST"' "grep SERVICEBAY_PASSWORD ~/.config/containers/systemd/servicebay.container"'
    exit 1
  fi
  SB_BASE="http://$HOST:$SB_PORT"
  SB_COOKIES=$(mktemp -t sb-heal-cookies.XXXXXX)
  trap 'rm -f "$SB_COOKIES"' EXIT
  sb_code=$(curl -sS -o /dev/null -w "%{http_code}" \
    -H "Origin: $SB_BASE" -H "Content-Type: application/json" \
    -c "$SB_COOKIES" \
    -X POST "$SB_BASE/api/auth/login" \
    -d "{\"username\":\"$SB_ADMIN_USER\",\"password\":\"$SB_ADMIN_PASS\"}")
  if [[ "$sb_code" != "200" ]]; then
    fail "ServiceBay login as $SB_ADMIN_USER failed (HTTP $sb_code)"
    exit 1
  fi
  pass "ServiceBay login as $SB_ADMIN_USER"

  NPM_FROM_MANIFEST=$(curl -fsS -b "$SB_COOKIES" -H "Origin: $SB_BASE" \
    "$SB_BASE/api/system/credentials" | python3 -c "
import json, sys
m = json.load(sys.stdin).get('manifest', {})
for c in m.get('credentials', []):
    if c.get('service') == 'Nginx Proxy Manager':
        print(c.get('username','') + '|' + c.get('password',''))
        break
")
  NPM_EMAIL=$(echo "$NPM_FROM_MANIFEST" | cut -d'|' -f1)
  NPM_PASS=$(echo "$NPM_FROM_MANIFEST" | cut -d'|' -f2-)
  if [[ -z "$NPM_PASS" ]]; then
    fail "no Nginx Proxy Manager entry in the credentials manifest"
    exit 1
  fi
  pass "got NPM creds for $NPM_EMAIL from manifest"
else
  pass "using NPM creds for $NPM_EMAIL from env"
fi

NPM_BASE="http://$HOST:81"
NPM_TOKEN_RESP=$(curl -sS -X POST "$NPM_BASE/api/tokens" \
  -H "Content-Type: application/json" \
  -d "{\"identity\":\"$NPM_EMAIL\",\"secret\":\"$NPM_PASS\"}")
NPM_TOKEN=$(echo "$NPM_TOKEN_RESP" | python3 -c "
import json, sys
try:
    print(json.load(sys.stdin).get('token',''))
except Exception:
    pass
")
if [[ -z "$NPM_TOKEN" ]]; then
  fail "NPM /api/tokens login failed."
  fail "  response: $NPM_TOKEN_RESP"
  fail "  This is the NPM-credential drift the npm_data_stale probe surfaces."
  fail "  Recovery: run the Settings → Integrations → Reverse Proxy 'Reset NPM credentials'"
  fail "  flow in the dashboard, or pass the working creds directly via env:"
  fail "    NPM_EMAIL=... NPM_PASS=... $0"
  exit 1
fi
pass "NPM admin /api/tokens → JWT"

# -------------------- expansion of the forward-auth snippet --------------------
# AUTHELIA_PORT can vary per install. Read it from the deployed Authelia config.
AUTHELIA_PORT=$(ssh_cmd "podman exec auth-authelia printenv AUTHELIA_SERVER_ADDRESS 2>/dev/null | grep -oE '[0-9]+$' | head -1" || echo "")
[[ -z "$AUTHELIA_PORT" ]] && AUTHELIA_PORT="9091"
info "Authelia listens on port $AUTHELIA_PORT"

FORWARD_AUTH_SNIPPET=$(cat <<EOF
auth_request /authelia;
auth_request_set \$target_url \$scheme://\$http_host\$request_uri;
auth_request_set \$user \$upstream_http_remote_user;
auth_request_set \$groups \$upstream_http_remote_groups;
auth_request_set \$name \$upstream_http_remote_name;
auth_request_set \$email \$upstream_http_remote_email;
auth_request_set \$redirect \$upstream_http_location;
proxy_set_header Remote-User \$user;
proxy_set_header Remote-Groups \$groups;
proxy_set_header Remote-Name \$name;
proxy_set_header Remote-Email \$email;
error_page 401 =302 \$redirect;

location = /authelia {
    internal;
    proxy_pass http://127.0.0.1:$AUTHELIA_PORT/api/authz/auth-request;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header X-Original-URL \$scheme://\$http_host\$request_uri;
    proxy_set_header X-Original-Method \$request_method;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP \$remote_addr;
}
EOF
)

# -------------------- find existing proxy hosts --------------------
ALL_HOSTS_JSON=$(curl -fsS -H "Authorization: Bearer $NPM_TOKEN" \
  "$NPM_BASE/api/nginx/proxy-hosts?expand=owner,access_list,certificate")

# -------------------- find LE certs we can reuse --------------------
ALL_CERTS_JSON=$(curl -fsS -H "Authorization: Bearer $NPM_TOKEN" \
  "$NPM_BASE/api/nginx/certificates?expand=owner")

find_proxy_id() {
  local subdomain="$1"
  local fqdn="$subdomain.$DOMAIN"
  echo "$ALL_HOSTS_JSON" | python3 -c "
import json, sys
hosts = json.load(sys.stdin)
m = next((h for h in hosts if '$fqdn' in h.get('domain_names', [])), None)
print(m['id'] if m else '')
"
}

find_cert_id() {
  local subdomain="$1"
  local fqdn="$subdomain.$DOMAIN"
  echo "$ALL_CERTS_JSON" | python3 -c "
import json, sys
certs = json.load(sys.stdin)
m = next((c for c in certs if c.get('provider') == 'letsencrypt' and '$fqdn' in c.get('domain_names', [])), None)
print(m['id'] if m else '')
"
}

get_proxy_field() {
  local proxy_id="$1"
  local field="$2"
  echo "$ALL_HOSTS_JSON" | python3 -c "
import json, sys
hosts = json.load(sys.stdin)
h = next((h for h in hosts if h.get('id') == $proxy_id), None)
print(h.get('$field', '') if h else '')
"
}

patch_proxy_host() {
  local proxy_id="$1"
  local body="$2"
  local label="$3"
  if [[ $DRY_RUN -eq 1 ]]; then
    info "  [dry-run] would PUT $NPM_BASE/api/nginx/proxy-hosts/$proxy_id ($label)"
    return 0
  fi
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X PUT "$NPM_BASE/api/nginx/proxy-hosts/$proxy_id" \
    -H "Authorization: Bearer $NPM_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body")
  local code=${resp##*$'\n'}
  if [[ "$code" =~ ^2 ]]; then
    pass "  patched ($label)"
    return 0
  else
    fail "  PUT failed (HTTP $code): ${resp%$'\n'*}"
    return 1
  fi
}

issue_cert_for() {
  local subdomain="$1"
  local fqdn="$subdomain.$DOMAIN"
  if [[ $DRY_RUN -eq 1 ]]; then
    info "  [dry-run] would request LE cert for $fqdn"
    return 0
  fi
  local resp
  resp=$(curl -sS -w "\n%{http_code}" --max-time 120 \
    -X POST "$NPM_BASE/api/nginx/certificates" \
    -H "Authorization: Bearer $NPM_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"provider\":\"letsencrypt\",\"domain_names\":[\"$fqdn\"],\"meta\":{\"dns_challenge\":false}}")
  local code=${resp##*$'\n'}
  local body=${resp%$'\n'*}
  if [[ "$code" =~ ^2 ]]; then
    local new_id
    new_id=$(echo "$body" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")
    pass "  cert issued for $fqdn (id=$new_id)"
    echo "$new_id"
  else
    fail "  cert request failed (HTTP $code): ${body:0:200}"
    echo ""
  fi
}

# -------------------- heal each host --------------------
TOTAL_CHANGES=0
for subdomain in admin nginx ldap; do
  fqdn="$subdomain.$DOMAIN"
  printf "\n%s%s%s\n" "$YELLOW" "$fqdn" "$OFF"
  proxy_id=$(find_proxy_id "$subdomain")
  if [[ -z "$proxy_id" ]]; then
    warn "  no proxy host found — skipping (re-run the wizard's auth/nginx step to create it)"
    continue
  fi
  info "  proxy host id=$proxy_id"

  current_adv=$(get_proxy_field "$proxy_id" "advanced_config")
  current_cert=$(get_proxy_field "$proxy_id" "certificate_id")

  # ---- 1) certificate ----
  if [[ $NO_CERT -eq 0 && " $HOSTS_NEEDING_CERT " == *" $subdomain "* ]]; then
    if [[ -n "$current_cert" && "$current_cert" != "0" ]]; then
      pass "  cert already bound (id=$current_cert)"
    else
      cert_id=$(find_cert_id "$subdomain")
      if [[ -z "$cert_id" ]]; then
        info "  no existing cert covering $fqdn — requesting one"
        cert_id=$(issue_cert_for "$subdomain")
      else
        info "  reusing existing cert (id=$cert_id)"
      fi
      if [[ -n "$cert_id" ]]; then
        patch_proxy_host "$proxy_id" \
          "{\"certificate_id\":$cert_id,\"ssl_forced\":true,\"http2_support\":true}" \
          "bind cert $cert_id" \
          && TOTAL_CHANGES=$((TOTAL_CHANGES + 1))
      fi
    fi
  fi

  # ---- 2) forward-auth advanced_config ----
  if [[ " $HOSTS_WITH_FORWARD_AUTH " == *" $subdomain "* ]]; then
    if echo "$current_adv" | grep -q "auth_request /authelia"; then
      pass "  forward-auth already present"
    else
      escaped_snippet=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$FORWARD_AUTH_SNIPPET")
      patch_proxy_host "$proxy_id" \
        "{\"advanced_config\":$escaped_snippet}" \
        "install auth_request block" \
        && TOTAL_CHANGES=$((TOTAL_CHANGES + 1))
    fi
  fi
done

printf "\n"
if [[ $DRY_RUN -eq 1 ]]; then
  info "dry-run complete. $TOTAL_CHANGES change(s) would be applied. Re-run without --dry-run to apply."
elif [[ $TOTAL_CHANGES -eq 0 ]]; then
  pass "everything is already in shape. No changes applied."
else
  pass "applied $TOTAL_CHANGES change(s). Verify with scripts/smoke/sso-verify.sh."
  info "NPM should have reloaded its nginx config automatically. If a host is still serving the old TLS cert, run:"
  info "  ssh $SSH_USER@$HOST 'systemctl --user restart nginx'"
fi
