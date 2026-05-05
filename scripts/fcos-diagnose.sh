#!/usr/bin/env bash
# Post-install diagnostics for a freshly-installed ServiceBay FCOS box.
#
# Usage:
#   scripts/fcos-diagnose.sh                      # auto-detect from build/fcos/install-settings.env
#   scripts/fcos-diagnose.sh 192.168.1.50         # override target IP
#   scripts/fcos-diagnose.sh 192.168.1.50 admin   # override target IP + remote user
#
# Reads STATIC_IP, HOST_USER, SERVICEBAY_PORT from build/fcos/install-settings.env,
# uses build/fcos/servicebay-ssh/id_rsa as the SSH key. Override any of those by
# setting FCOS_HOST / FCOS_USER / FCOS_PORT / FCOS_KEY in the environment.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
SETTINGS_FILE="$REPO_ROOT/build/fcos/install-settings.env"
DEFAULT_KEY="$REPO_ROOT/build/fcos/servicebay-ssh/id_rsa"

load() { grep -oP "^$1=\K.*" "$SETTINGS_FILE" 2>/dev/null || echo ""; }

HOST="${1:-${FCOS_HOST:-$(load STATIC_IP)}}"
USER_NAME="${2:-${FCOS_USER:-$(load HOST_USER)}}"
PORT="${FCOS_PORT:-$(load SERVICEBAY_PORT)}"
KEY="${FCOS_KEY:-$DEFAULT_KEY}"

[[ -z "$HOST" ]] && { echo "✗ no host. Pass as arg or set FCOS_HOST." >&2; exit 1; }
[[ -z "$USER_NAME" ]] && USER_NAME="core"
[[ -z "$PORT" ]] && PORT="3000"
[[ ! -f "$KEY" ]] && { echo "✗ SSH key not found at $KEY (set FCOS_KEY to override)." >&2; exit 1; }

echo "▶ ServiceBay FCOS diagnostics: ${USER_NAME}@${HOST} (port ${PORT})"
echo ""

ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 "${USER_NAME}@${HOST}" "
PORT='${PORT}'
echo '== systemctl =='
systemctl --user status servicebay --no-pager 2>&1 | head -8

echo
echo '== container =='
podman ps -a --format '{{.Names}} {{.Status}} {{.Image}}' 2>&1

echo
echo '== listening =='
ss -ltn | grep -E \":\${PORT}\b|:3000\b\" || echo \"(nothing on :\${PORT} or :3000)\"

echo
echo '== local curl =='
curl -sS -m 3 -o /dev/null -w 'HTTP %{http_code}\n' \"http://localhost:\${PORT}\" 2>&1 \
  || echo \"(no response on localhost:\${PORT})\"

echo
echo '== firewall =='
if command -v firewall-cmd > /dev/null 2>&1; then
  sudo firewall-cmd --list-ports 2>&1
else
  echo '(firewalld not installed — FCOS default; nothing to open)'
fi

echo
echo '== first-boot units =='
systemctl --no-pager status setup-raid install-python install-nginx 2>&1 \
  | grep -E '(●|Active:)' || true

echo
echo '== /mnt/data =='
df -h /mnt/data 2>&1 | tail -1
ls -la /mnt/data/servicebay/ 2>&1 | head -5

echo
echo '== last log =='
journalctl --user -u servicebay -n 20 --no-pager 2>&1 | tail -20
"

echo ""
echo "▶ ServiceBay should be reachable at: http://${HOST}:${PORT}"
