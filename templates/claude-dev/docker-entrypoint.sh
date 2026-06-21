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

# /workspace is a fresh, root-owned bind mount on first install. It's a
# SHARED working area: the `dev` break-glass user plus every provisioned LDAP
# user (e.g. mdopp) collaborate on the same checkouts here. Own it
# `dev:devshare` with the setgid bit (2775) so new clones inherit the shared
# group and group members can write each other's files (paired with umask 002,
# set via /etc/profile.d). Per-user homes under /workspace/home stay private
# (mode 700). Non-recursive on purpose — existing checkouts persist on the
# volume; a recursive chown over a large repo tree on every restart would be
# wasteful, and setgid + umask cover anything created from now on.
groupadd -f devshare
usermod -aG devshare dev 2>/dev/null || true
chown dev:devshare "$DEV_HOME"
chmod 2775 "$DEV_HOME"
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

# LDAP login. When the LLDAP bind password is present, let the operator sign
# in as their real LLDAP user (e.g. `mdopp`) with their LLDAP password instead
# of the shared `dev` account. LLDAP 0.6.x is an auth directory with no POSIX
# attributes, so we use it for AUTHENTICATION only: pam_ldap verifies the
# password by binding to LLDAP as the user's DN (via nslcd), and we provision
# a matching LOCAL account per group member so NSS (files) can resolve them.
# `dev` stays as a break-glass path so a misconfig here can't lock everyone
# out. Opt-in: with the var blank the whole block is skipped.
ldap_enabled=no
if [ -n "${LLDAP_ADMIN_PASSWORD:-}" ]; then
  LLDAP_HOST="${LLDAP_HOST:-localhost}"
  LLDAP_LDAP_PORT="${LLDAP_LDAP_PORT:-3890}"
  LLDAP_BASE_DN="${LLDAP_BASE_DN:-dc=dopp,dc=cloud}"
  CLAUDE_DEV_LDAP_GROUP="${CLAUDE_DEV_LDAP_GROUP:-admins}"
  ldap_uri="ldap://${LLDAP_HOST}:${LLDAP_LDAP_PORT}"
  admin_dn="uid=admin,ou=people,${LLDAP_BASE_DN}"
  group_dn="cn=${CLAUDE_DEV_LDAP_GROUP},ou=groups,${LLDAP_BASE_DN}"

  # nslcd config — AUTH-ONLY. `$username` is expanded by nslcd at runtime, so
  # it must stay literal (escaped from this heredoc). pam_authz_search gates
  # login on group membership; LLDAP supports the memberof search filter.
  # pam_authc_search is disabled — LLDAP restricts a user reading other
  # entries, so the default post-bind self-search can wrongly deny auth.
  umask 077
  cat > /etc/nslcd.conf <<EOF
uid nslcd
gid nslcd
uri ${ldap_uri}
base ${LLDAP_BASE_DN}
binddn ${admin_dn}
bindpw ${LLDAP_ADMIN_PASSWORD}
base passwd ou=people,${LLDAP_BASE_DN}
filter passwd (objectClass=person)
pam_authc_search NONE
pam_authz_search (&(uid=\$username)(memberof=${group_dn}))
EOF
  chown root:nslcd /etc/nslcd.conf
  chmod 640 /etc/nslcd.conf
  umask 022

  rm -f /run/nslcd/socket
  install -d -o nslcd -g nslcd -m 755 /run/nslcd
  if /usr/sbin/nslcd; then
    ldap_enabled=yes
    # Provision a local account for each member of the allowed group so NSS
    # (files) resolves them; their password is never stored locally — PAM
    # checks it against LLDAP on each login. Idempotent: re-runs every start
    # to pick up new members, skips users that already exist. Homes live on
    # the persistent /workspace volume.
    install -d -o root -g root -m 0755 "$DEV_HOME/home"
    groupadd -f ldapusers
    members="$(ldapsearch -x -LLL -o ldif-wrap=no \
                 -H "$ldap_uri" -D "$admin_dn" -w "$LLDAP_ADMIN_PASSWORD" \
                 -b "$group_dn" '(objectClass=*)' member 2>/dev/null \
               | sed -n 's/^member: uid=\([^,]*\),.*/\1/p' | sort -u)"
    provisioned=0
    for u in $members; do
      case "$u" in admin|root|dev|''|*[!a-z0-9_-]*) continue;; esac
      if ! id "$u" >/dev/null 2>&1; then
        # `ldapusers` gates SSH; `devshare` lets them write the shared
        # /workspace checkouts alongside `dev` and each other.
        useradd --no-create-home --home-dir "$DEV_HOME/home/$u" \
                --shell /bin/bash -G ldapusers,devshare "$u" \
          && provisioned=$((provisioned + 1))
      else
        usermod -aG devshare "$u" 2>/dev/null || true
      fi
      # Reconcile the persisted per-user home to the CURRENT uid/gid every
      # boot. LDAP users get a runtime-assigned uid (the entrypoint can't pin
      # it the way the Dockerfile pins `dev`), so a rebuild that shifts the uid
      # would leave the old-uid-owned ~/.claude unreadable → silent re-login.
      # These homes are small and mode-700 (the heavy shared checkouts live in
      # /workspace itself, not here), so a recursive chown is cheap and safe.
      user_home="$DEV_HOME/home/$u"
      if [ -d "$user_home" ]; then
        chown -R "$u":"$u" "$user_home" 2>/dev/null || true
      fi
    done
    echo "claude-dev: LDAP login enabled — members of group '${CLAUDE_DEV_LDAP_GROUP}' sign in with their LLDAP password (bind ${ldap_uri}; ${provisioned} new local account(s) provisioned)."
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
  # AllowGroups restricts logins to the local `dev` break-glass account and the
  # `ldapusers` group every provisioned LDAP account is a member of — a second
  # belt on top of pam_authz_search's group gate.
  sshd_opts+=(
    -o "UsePAM=yes"
    -o "PasswordAuthentication=yes"
    -o "KbdInteractiveAuthentication=yes"
    -o "AllowGroups=dev ldapusers"
  )
  echo "claude-dev: starting sshd on port ${SSH_PORT} (LDAP + local 'dev')."
else
  sshd_opts+=( -o "PasswordAuthentication=${password_auth}" )
  echo "claude-dev: starting sshd on port ${SSH_PORT} (local 'dev' only)."
fi

exec /usr/sbin/sshd "${sshd_opts[@]}"
