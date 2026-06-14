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
if [ "$password_auth" = no ] && [ -z "${CLAUDE_DEV_SSH_AUTHORIZED_KEY:-}" ] && [ -z "${LLDAP_ADMIN_PASSWORD:-}" ]; then
  echo "claude-dev: WARNING — no SSH password, authorized key, or LDAP set; nobody can log in." >&2
fi

# LDAP login (nss-pam-ldapd). When the LLDAP bind password is present, wire
# nslcd against the box's LLDAP so the operator signs in as their real LDAP
# user (e.g. `mdopp`) with their LLDAP credentials, instead of the shared
# `dev` account. The `dev` user is kept as a break-glass path so a misconfig
# here can never lock everyone out. Opt-in: with the var blank, this whole
# block is skipped and the box behaves exactly as before.
ldap_enabled=no
if [ -n "${LLDAP_ADMIN_PASSWORD:-}" ]; then
  LLDAP_HOST="${LLDAP_HOST:-localhost}"
  LLDAP_LDAP_PORT="${LLDAP_LDAP_PORT:-3890}"
  LLDAP_BASE_DN="${LLDAP_BASE_DN:-dc=dopp,dc=cloud}"
  CLAUDE_DEV_LDAP_GROUP="${CLAUDE_DEV_LDAP_GROUP:-lldap_admin}"

  # Per-user homes live under the persistent /workspace volume so each LDAP
  # user's git checkouts, ~/.claude history and gh auth survive a restart.
  install -d -o root -g root -m 0755 "$DEV_HOME/home"

  # LLDAP serves uid/uidNumber/gidNumber/memberOf but NOT homeDirectory or
  # loginShell — synthesize them via nslcd maps. pam_authz_search gates login
  # on membership of the configured LLDAP group. The file holds the bind
  # password, so keep it root-readable only.
  umask 077
  cat > /etc/nslcd.conf <<EOF
uid nslcd
gid nslcd
uri ldap://${LLDAP_HOST}:${LLDAP_LDAP_PORT}
base ${LLDAP_BASE_DN}
base passwd ou=people,${LLDAP_BASE_DN}
base group ou=groups,${LLDAP_BASE_DN}
binddn uid=admin,ou=people,${LLDAP_BASE_DN}
bindpw ${LLDAP_ADMIN_PASSWORD}
scope sub
map passwd homeDirectory "${DEV_HOME}/home/\$uid"
map passwd loginShell    "/bin/bash"
pam_authz_search (&(uid=\$username)(memberof=cn=${CLAUDE_DEV_LDAP_GROUP},ou=groups,${LLDAP_BASE_DN}))
EOF
  chown root:nslcd /etc/nslcd.conf
  chmod 640 /etc/nslcd.conf
  umask 022

  rm -f /run/nslcd/socket
  install -d -o nslcd -g nslcd -m 755 /run/nslcd
  if /usr/sbin/nslcd; then
    ldap_enabled=yes
    echo "claude-dev: LDAP login enabled — sign in as an LLDAP user in group '${CLAUDE_DEV_LDAP_GROUP}' (bind ldap://${LLDAP_HOST}:${LLDAP_LDAP_PORT})."
  else
    echo "claude-dev: WARNING — nslcd failed to start; LDAP login disabled, local 'dev' account still works." >&2
  fi
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

# Base sshd options. The local `dev` account authenticates with its own
# password/key exactly as before.
sshd_opts=(
  -D -e
  -p "$SSH_PORT"
  -o "PubkeyAuthentication=yes"
  -o "PermitRootLogin=no"
  -o "HostKey=${HOSTKEY_DIR}/ssh_host_ed25519_key"
  -o "HostKey=${HOSTKEY_DIR}/ssh_host_rsa_key"
)

if [ "$ldap_enabled" = yes ]; then
  # PAM drives LLDAP password verification (pam_ldap). Password auth must be
  # on for LDAP users to authenticate even when the `dev` password is unset.
  # AllowGroups restricts logins to the local `dev` break-glass group plus the
  # configured LLDAP group — without it, every resolvable LDAP user could log
  # in regardless of group, since pam_authz_search alone wouldn't bound NSS.
  sshd_opts+=(
    -o "UsePAM=yes"
    -o "PasswordAuthentication=yes"
    -o "KbdInteractiveAuthentication=yes"
    -o "AllowGroups=dev ${CLAUDE_DEV_LDAP_GROUP}"
  )
  echo "claude-dev: starting sshd on port ${SSH_PORT} (LDAP + local 'dev')."
else
  sshd_opts+=( -o "PasswordAuthentication=${password_auth}" )
  echo "claude-dev: starting sshd on port ${SSH_PORT} (local 'dev' only)."
fi

exec /usr/sbin/sshd "${sshd_opts[@]}"
