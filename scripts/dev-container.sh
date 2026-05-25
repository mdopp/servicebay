#!/usr/bin/env bash
# ServiceBay — local dev container runner.
#
# DEVELOPMENT ONLY. Production deployment is via Fedora CoreOS
# (./install-fedora-coreos.sh). This script builds the image from the local
# repo so code changes are picked up on each `up`.
#
# Usage:
#   scripts/dev-container.sh up         build + (re)start the container
#   scripts/dev-container.sh logs       follow logs
#   scripts/dev-container.sh down       stop + remove container
#   scripts/dev-container.sh restart    restart without rebuild
#   scripts/dev-container.sh shell      open a shell inside the container
#   scripts/dev-container.sh reset      down + delete dev data dir (DESTRUCTIVE)
#
# Env overrides:
#   SERVICEBAY_DEV_DIR   data dir (default: ~/.servicebay-dev)
#   SERVICEBAY_DEV_PORT  host port (default: 3000)
#   SERVICEBAY_DEV_NAME  container name (default: servicebay-dev)
#   ENGINE               podman | docker (auto-detected; podman preferred)

set -euo pipefail

# ─── repo-root sanity ──────────────────────────────────────────────────────
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
REPO_ROOT=$(dirname "$SCRIPT_DIR")
if [ ! -f "$REPO_ROOT/Dockerfile" ] || [ ! -f "$REPO_ROOT/package.json" ]; then
  echo "✗ scripts/dev-container.sh must live alongside the ServiceBay Dockerfile" >&2
  exit 1
fi
cd "$REPO_ROOT"

# ─── config ────────────────────────────────────────────────────────────────
DATA_DIR="${SERVICEBAY_DEV_DIR:-$HOME/.servicebay-dev}"
SECRET_FILE="$DATA_DIR/.auth-secret"
PASSWORD_FILE="$DATA_DIR/.bootstrap-password"
SSH_DIR="$DATA_DIR/data/ssh"
SSH_KEY="$SSH_DIR/id_rsa"
PORT="${SERVICEBAY_DEV_PORT:-3000}"
NAME="${SERVICEBAY_DEV_NAME:-servicebay-dev}"
IMAGE="servicebay:dev"
DEV_USERNAME="${SERVICEBAY_USERNAME:-admin}"

# ─── pick container engine ─────────────────────────────────────────────────
if [ -z "${ENGINE:-}" ]; then
  if command -v podman > /dev/null 2>&1; then
    ENGINE=podman
  elif command -v docker > /dev/null 2>&1; then
    ENGINE=docker
  else
    echo "✗ neither podman nor docker found in PATH" >&2
    exit 1
  fi
fi

# Docker doesn't expose host.containers.internal by default; podman does.
if [ "$ENGINE" = "docker" ]; then
  HOST_SSH_HOSTNAME="host.docker.internal"
  HOST_GATEWAY_FLAG=(--add-host=host.docker.internal:host-gateway)
else
  HOST_SSH_HOSTNAME="host.containers.internal"
  HOST_GATEWAY_FLAG=()
fi

# ─── helpers ───────────────────────────────────────────────────────────────
log() { printf '▶ %s\n' "$*"; }
err() { printf '✗ %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

ensure_data_layout() {
  mkdir -p "$DATA_DIR" "$DATA_DIR/data" "$SSH_DIR"
}

ensure_auth_secret() {
  if [ ! -f "$SECRET_FILE" ]; then
    log "generating AUTH_SECRET → $SECRET_FILE"
    install -m 0600 /dev/null "$SECRET_FILE"
    openssl rand -hex 32 > "$SECRET_FILE"
  fi
}

preflight_host_sshd() {
  # The agent inside the container SSHs back to the host via
  # host.containers.internal. If no sshd is listening on the host's port 22,
  # the UI will load but every Local-node action will fail with ECONNREFUSED.
  # We warn here rather than fail — the rest of ServiceBay still works.
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE '(^|:)22$'; then
    return
  fi
  if command -v sshd > /dev/null 2>&1; then
    cat >&2 <<'EOF'
⚠ no sshd listening on the host (port 22). The agent will not be able to
  reach back from the container. Start it with:
    sudo service ssh start
EOF
  else
    cat >&2 <<EOF
⚠ openssh-server is not installed on this host. The agent inside the
  container needs SSH back to the host (Local node) to inspect podman /
  systemd state. Install it once, then re-run 'scripts/dev-container.sh up':

    sudo apt update && sudo apt install -y openssh-server
    sudo sed -i 's/^#*PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
    sudo service ssh start

  Public key to authorize (already added if you said 'y' above):
    $SSH_KEY.pub → ~/.ssh/authorized_keys
EOF
  fi
}

ensure_bootstrap_password() {
  # First-run bootstrap: ServiceBay reads SERVICEBAY_PASSWORD on first login,
  # hashes it, persists the hash in config.json, and from then on the env var
  # is unused. We always pass it so a fresh data dir can log in.
  if [ ! -f "$PASSWORD_FILE" ]; then
    log "generating dev bootstrap password → $PASSWORD_FILE"
    install -m 0600 /dev/null "$PASSWORD_FILE"
    openssl rand -hex 12 > "$PASSWORD_FILE"
  fi
}

ensure_ssh_key() {
  if [ -f "$SSH_KEY" ]; then return; fi
  log "generating SSH key → $SSH_KEY"
  ssh-keygen -t ed25519 -f "$SSH_KEY" -N "" -C "servicebay-dev@$(hostname)" > /dev/null
  local pub="${SSH_KEY}.pub"
  printf '\nGenerated key:\n  %s\n\n' "$(cat "$pub")"
  read -r -p "Append public key to ~/.ssh/authorized_keys so the container can SSH back to this host? [y/N] " ans
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    mkdir -p "$HOME/.ssh"
    chmod 700 "$HOME/.ssh"
    touch "$HOME/.ssh/authorized_keys"
    chmod 600 "$HOME/.ssh/authorized_keys"
    if ! grep -qF "$(cat "$pub")" "$HOME/.ssh/authorized_keys"; then
      cat "$pub" >> "$HOME/.ssh/authorized_keys"
      log "added to authorized_keys"
    else
      log "already present in authorized_keys"
    fi
  fi
}

container_exists() {
  $ENGINE container inspect "$NAME" > /dev/null 2>&1
}

container_running() {
  [ "$($ENGINE container inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = "true" ]
}

stop_if_running() {
  if container_running; then
    log "stopping $NAME"
    $ENGINE stop "$NAME" > /dev/null
  fi
}

remove_if_exists() {
  stop_if_running
  if container_exists; then
    log "removing $NAME"
    $ENGINE rm "$NAME" > /dev/null
  fi
}

host_build() {
  # Build .next/ and dist-server/ on the host. The dev image deliberately
  # does NOT run `npm run build` inside the container — webpack inside podman
  # under WSL reliably OOMs and crashes the WSL VM. Building on the host is
  # both faster and safer.
  if [ -n "${SERVICEBAY_DEV_SKIP_HOST_BUILD:-}" ]; then
    log "SERVICEBAY_DEV_SKIP_HOST_BUILD set — reusing existing packages/frontend/.next/ + dist-server/"
    [ -d "$REPO_ROOT/packages/frontend/.next" ] && [ -f "$REPO_ROOT/dist-server/server.cjs" ] || \
      die "no prior build found; run without SERVICEBAY_DEV_SKIP_HOST_BUILD once"
    return
  fi
  log "building Next.js + server bundle on the host (npm run build)"
  ( cd "$REPO_ROOT" && npm run build )
}

build_image() {
  log "building $IMAGE with $ENGINE from prebuilt artifacts"
  $ENGINE build -f Dockerfile.dev -t "$IMAGE" "$REPO_ROOT"
}

run_container() {
  local secret password
  secret=$(cat "$SECRET_FILE")
  password=$(cat "$PASSWORD_FILE")
  log "starting $NAME on http://localhost:$PORT"
  $ENGINE run -d \
    --name "$NAME" \
    -p "${PORT}:3000" \
    -e AUTH_SECRET="$secret" \
    -e SERVICEBAY_USERNAME="$DEV_USERNAME" \
    -e SERVICEBAY_PASSWORD="$password" \
    -e HOST_SSH="$HOST_SSH_HOSTNAME" \
    -e HOST_USER="${SERVICEBAY_HOST_USER:-$USER}" \
    -v "$DATA_DIR/data:/app/data:Z" \
    --restart=no \
    "${HOST_GATEWAY_FLAG[@]}" \
    "$IMAGE" > /dev/null
  log "ready. ServiceBay → http://localhost:$PORT"
  log "login:  user '$DEV_USERNAME'  password (also in $PASSWORD_FILE):"
  log "        $password"
  log "tail logs with: scripts/dev-container.sh logs"
}

# ─── subcommands ───────────────────────────────────────────────────────────
cmd_up() {
  ensure_data_layout
  ensure_auth_secret
  ensure_bootstrap_password
  ensure_ssh_key
  preflight_host_sshd
  host_build
  remove_if_exists
  build_image
  run_container
}

cmd_restart() {
  ensure_data_layout
  ensure_auth_secret
  ensure_bootstrap_password
  if ! container_exists; then
    log "no existing container; running 'up' instead"
    cmd_up
    return
  fi
  remove_if_exists
  run_container
}

cmd_down() {
  remove_if_exists
  log "down"
}

cmd_logs() {
  container_exists || die "no container '$NAME' — run 'up' first"
  exec $ENGINE logs -f "$NAME"
}

cmd_shell() {
  container_running || die "container '$NAME' is not running"
  exec $ENGINE exec -it "$NAME" /bin/bash
}

cmd_reset() {
  remove_if_exists
  if [ -d "$DATA_DIR" ]; then
    read -r -p "Delete $DATA_DIR (auth secret, SSH key, app data)? [y/N] " ans
    if [[ "$ans" =~ ^[Yy]$ ]]; then
      rm -rf "$DATA_DIR"
      log "removed $DATA_DIR"
    fi
  fi
}

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
}

case "${1:-}" in
  up)       cmd_up ;;
  restart)  cmd_restart ;;
  down)     cmd_down ;;
  logs)     cmd_logs ;;
  shell)    cmd_shell ;;
  reset)    cmd_reset ;;
  -h|--help) usage; exit 0 ;;
  "") usage; exit 1 ;;
  *) err "unknown subcommand: $1"; usage; exit 1 ;;
esac
