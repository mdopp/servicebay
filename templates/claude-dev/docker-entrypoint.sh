#!/usr/bin/env bash
# Entrypoint for the claude-dev container image.
#
# Wires SSH auth from the env vars the `claude-dev` template passes,
# persists host keys on the /workspace volume so the SSH client doesn't
# warn about a changed host key after every restart, then hands off to
# sshd as PID 1.
set -euo pipefail

SSH_PORT="${CLAUDE_DEV_SSH_PORT:-2222}"
DEV_HOME=/workspace
HOSTKEY_DIR="$DEV_HOME/.ssh/host_keys"

# /workspace is a fresh, root-owned bind mount on first install. Make it
# the dev user's home and lay down the .ssh scaffolding. The chown is
# non-recursive on purpose — the operator's own checkouts inside are
# created as `dev` already, and a recursive chown over a large repo
# tree on every restart would be wasteful.
chown dev:dev "$DEV_HOME"
install -d -o dev -g dev -m 700 "$DEV_HOME/.ssh"
install -d -o dev -g dev -m 700 "$HOSTKEY_DIR"

# Persist host keys on the volume.
for keytype in ed25519 rsa; do
  keyfile="$HOSTKEY_DIR/ssh_host_${keytype}_key"
  [ -f "$keyfile" ] || ssh-keygen -t "$keytype" -f "$keyfile" -N "" -q
done

password_auth=no
if [ -n "${CLAUDE_DEV_SSH_AUTHORIZED_KEY:-}" ]; then
  printf '%s\n' "$CLAUDE_DEV_SSH_AUTHORIZED_KEY" > "$DEV_HOME/.ssh/authorized_keys"
  chown dev:dev "$DEV_HOME/.ssh/authorized_keys"
  chmod 600 "$DEV_HOME/.ssh/authorized_keys"
  echo "claude-dev: key-based SSH login enabled for user 'dev'."
fi
if [ -n "${CLAUDE_DEV_SSH_PASSWORD:-}" ]; then
  echo "dev:${CLAUDE_DEV_SSH_PASSWORD}" | chpasswd
  password_auth=yes
  echo "claude-dev: password SSH login enabled for user 'dev'."
fi
if [ "$password_auth" = no ] && [ -z "${CLAUDE_DEV_SSH_AUTHORIZED_KEY:-}" ]; then
  echo "claude-dev: WARNING — no SSH password or authorized key set; nobody can log in." >&2
fi

# Start the long-lived `claude` tmux session as the dev user BEFORE we
# exec sshd, so it's already running before anyone connects (incl. after
# a container restart — `claude --continue` then resumes the prior
# conversation from the persisted ~/.claude on /workspace). The tmux
# server daemonizes, so sshd stays PID 1 — do NOT regress that. Idempotent:
# `has-session` skips re-creating it if one somehow already exists. The
# session runs as `dev` with /workspace as $HOME so its working dir + any
# `claude` auth/history match an interactive login's.
if su -s /bin/bash dev -c 'tmux has-session -t claude' 2>/dev/null; then
  echo "claude-dev: tmux session 'claude' already running."
else
  su -s /bin/bash dev -c "cd '$DEV_HOME' && HOME='$DEV_HOME' tmux new-session -d -s claude"
  echo "claude-dev: started detached tmux session 'claude' for user 'dev'."
fi

mkdir -p /run/sshd
echo "claude-dev: starting sshd on port ${SSH_PORT}."
exec /usr/sbin/sshd -D -e \
  -p "$SSH_PORT" \
  -o "PasswordAuthentication=${password_auth}" \
  -o "PubkeyAuthentication=yes" \
  -o "PermitRootLogin=no" \
  -o "HostKey=${HOSTKEY_DIR}/ssh_host_ed25519_key" \
  -o "HostKey=${HOSTKEY_DIR}/ssh_host_rsa_key"
