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
SSH_DIR="$DATA_DIR/data/ssh"
SSH_KEY="$SSH_DIR/id_rsa"
PORT="${SERVICEBAY_DEV_PORT:-3000}"
NAME="${SERVICEBAY_DEV_NAME:-servicebay-dev}"
IMAGE="servicebay:dev"

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

build_image() {
  log "building $IMAGE with $ENGINE (this can take a few minutes the first time)"
  $ENGINE build -t "$IMAGE" "$REPO_ROOT"
}

run_container() {
  local secret
  secret=$(cat "$SECRET_FILE")
  log "starting $NAME on http://localhost:$PORT"
  $ENGINE run -d \
    --name "$NAME" \
    -p "${PORT}:3000" \
    -e AUTH_SECRET="$secret" \
    -e HOST_SSH="$HOST_SSH_HOSTNAME" \
    -v "$DATA_DIR/data:/app/data:Z" \
    --restart=no \
    "${HOST_GATEWAY_FLAG[@]}" \
    "$IMAGE" > /dev/null
  log "ready. ServiceBay → http://localhost:$PORT"
  log "tail logs with: scripts/dev-container.sh logs"
}

# ─── subcommands ───────────────────────────────────────────────────────────
cmd_up() {
  ensure_data_layout
  ensure_auth_secret
  ensure_ssh_key
  remove_if_exists
  build_image
  run_container
}

cmd_restart() {
  ensure_data_layout
  ensure_auth_secret
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
