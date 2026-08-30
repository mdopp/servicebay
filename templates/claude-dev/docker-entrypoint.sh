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

# ---------------------------------------------------------------------------
# Helpers. Everything below the sourcing guard is the boot sequence, which is
# root-only and ends in `exec sshd`; these three functions hold the parts that
# handle UNTRUSTED input (shared-workspace directory names) or a SECRET (the
# LLDAP bind password), so they are defined up here and exercised directly by
# tests/templates/claude_dev_entrypoint_test.sh.
# ---------------------------------------------------------------------------

# Run `su` as the `dev` user with an explicit argv vector.
#
# The `--` before the user name is LOAD-BEARING, not decoration: util-linux
# `su` parses its arguments with a PERMUTING getopt, so options are still
# recognised *after* the user operand. Without the `--`, a checkout named
# `-c` would be re-read as su's own `--command` and replace the command su
# runs; `-s` would pick the shell. `--` stops option parsing, so every
# following word is a plain positional the su'd shell sees as "$0", "$1", …
# and never re-parses (#2418).
su_dev() {
  local script="$1"; shift
  su -s /bin/bash -c "$script" -- dev claude-dev "$@"
}

# Discover git checkouts under $DEV_HOME into the global `repos` array.
#
# A checkout is a top-level dir holding a `.git` entry. The `*/` glob skips
# hidden dirs (~/.ssh, ~/.claude) and the per-user homes (home/ has no .git),
# so only real project checkouts are picked up.
#
# /workspace is group-writable by `devshare` (see the chown below), so these
# basenames are ATTACKER-CONTROLLED: a filename may hold any byte but `/` and
# NUL. They are therefore only ever handled as array elements — never spliced
# into a string that a second shell re-parses.
discover_repos() {
  local d
  repos=()
  for d in "$DEV_HOME"/*/; do
    [ -e "${d}.git" ] || continue
    repos+=("$(basename -- "$d")")
  done
}

# Narrow the discovered checkouts to the ones that are DEVELOPMENT targets.
#
# Deliberately a SEPARATE pass rather than a condition inside discover_repos:
# `safe.directory` must be registered for every git checkout, including the
# ones we do not auto-start, or git refuses to run in a root-owned content
# repo the moment someone `cd`s into it by hand. Only the autostart is
# filtered.
#
# `CLAUDE.md` is the marker. A git checkout is not automatically something to
# point an unattended agent at — content repos live under /workspace too
# (`servicebay-templates` is a README and a templates/ tree) and an agent
# started there has nothing to do. A repo meant to be worked on by Claude Code
# carries a CLAUDE.md anyway, so this needs no extra bookkeeping file and no
# per-box configuration.
select_autostart_repos() {
  local name now
  autostart_repos=()
  skipped_repos=()
  for name in "$@"; do
    if [ -e "$DEV_HOME/$name/CLAUDE.md" ]; then
      autostart_repos+=("$name")
    else
      skipped_repos+=("$name")
    fi
  done

  # Report the skip set — but only when it CHANGES, because reconcile_repos
  # re-runs on a 300s timer and an unconditional line would be pure noise.
  #
  # Reporting at all is the point: a checkout that silently gets no session
  # looks exactly like one that is running fine, which is the failure this
  # change exists to end. A repo skipped here never gets a window at all, so
  # `remain-on-exit` cannot surface it — only this line can.
  # `skipped_reported` is deliberately not `local`: it must survive calls.
  now="${skipped_repos[*]}"
  if [ "$now" != "${skipped_reported:-}" ]; then
    skipped_reported="$now"
    if [ -n "$now" ]; then
      echo "claude-dev: skipping ${#skipped_repos[@]} checkout(s) with no CLAUDE.md (not a development target): $now"
    fi
  fi
}

# Make git usable for the `dev` user in every discovered checkout.
#
# Why this is needed: a checkout that was created AS ROOT (a clone run from a
# root shell, a restored backup, a `podman exec` that ran as root) stays
# root-owned. The chown below is non-recursive on purpose, so it never reaches
# into it, and setgid+umask don't help either — the problem is the OWNER, not
# the group. git then refuses EVERY command in that directory with "detected
# dubious ownership", while the session still starts, is named after the
# directory and looks perfectly healthy from the outside (#2612).
#
# Two properties this is built around:
#
#   * IDEMPOTENT. `--replace-all` collapses the entry for a path to exactly one
#     line instead of appending another one. Registering with `--add` on every
#     boot is what grew the reference box's list to ~65 entries, ~30 of them the
#     same repo — while the checkouts that actually needed an entry had none.
#
#   * SCOPED to what this entrypoint owns. It only ever writes entries for the
#     checkouts it just discovered, and only ever removes entries under
#     $DEV_HOME that name neither a discovered checkout nor any other git
#     repository (i.e. a path that has gone away). Entries for anything outside
#     $DEV_HOME — a dotfiles dir, a per-user home, whatever the operator added
#     by hand — are never touched. This is deliberately NOT a "de-duplicate the
#     whole config" pass: rewriting a user's global git config beyond this
#     tool's own entries is not ours to do.
#
# `--fixed-value` (git ≥ 2.30) makes the value-pattern an exact string compare
# instead of a regex, so a shared-workspace directory name full of regex
# metacharacters can't widen the match. Directory names cross the su boundary
# as positional parameters, same as everywhere else in this file (#2418).
register_safe_directories() {
  su_dev '
    set -u
    dev_home="$1"; shift
    export HOME="$dev_home"
    rc=0

    for name in "$@"; do
      path="$dev_home/$name"
      git config --global --replace-all --fixed-value \
        safe.directory "$path" "$path" || rc=1
    done

    entries="$(git config --global --get-all safe.directory 2>/dev/null || true)"
    printf "%s\n" "$entries" | while IFS= read -r entry; do
      [ -n "$entry" ] || continue
      case "$entry" in "$dev_home"/*) ;; *) continue;; esac
      keep=0
      for name in "$@"; do
        if [ "$entry" = "$dev_home/$name" ]; then keep=1; break; fi
      done
      [ "$keep" -eq 1 ] && continue
      [ -e "$entry/.git" ] && continue
      git config --global --unset-all --fixed-value safe.directory "$entry" || true
    done

    exit "$rc"
  ' "$DEV_HOME" "$@"
}

# Give every Claude session read access to ServiceBay's own API, so it can look
# up an ADR, an assist, a service's logs or a rendered service definition
# without anyone pasting a token into a session by hand.
#
# ONE token at Claude Code's `user` scope, not one per checkout. Per-repo tokens
# would buy attribution and nothing else: ServiceBay's scope ladder has no
# per-service granularity, and a READ-ONLY token cannot change anything no
# matter which project holds it. User scope also covers checkouts cloned later,
# so this needs no reconcile pass and no repo discovery.
#
# Mint it READ-ONLY. ServiceBay offers "Never Expires" only for read-only scope
# sets — anything from `lifecycle` upward expires within 30 days and puts the
# operator on a rotation treadmill. A session that genuinely needs to restart or
# deploy something calls `request_token`, which itself needs only `read`, and the
# operator approves that one job; a shell goes through the one-shot flow bound to
# a single operation.
#
# `--scope user`, and if you ever narrow this to a single project use `local` —
# never `project`. Project scope writes `.mcp.json` INTO the checkout, which is a
# tracked file, so the token would be committed on the next `git add`.
#
# The endpoint is the INTERNAL one. Since claude-dev moved into its own network
# namespace (ADR 0007 Decision 1) the pod cannot resolve the public `admin.`
# hostname; on-box siblings are reached through `host.containers.internal`, the
# same way the LLDAP bind is.
MCP_URL="http://host.containers.internal:5888/mcp"

configure_mcp_server() {
  local token="${SERVICEBAY_MCP_TOKEN:-}"
  [ -n "$token" ] || return 0
  # The token is interpolated into a command, so it may hold only the characters
  # an `sb_` token actually contains. Refusing loudly beats configuring a server
  # that then fails on every call.
  case "$token" in *[!A-Za-z0-9_-]*)
    echo "claude-dev: WARNING — SERVICEBAY_MCP_TOKEN contains unexpected characters; MCP server not configured." >&2
    return 0;;
  esac
  # remove-then-add keeps this idempotent across restarts: a rotated token or a
  # changed URL replaces the old entry instead of colliding with it.
  if su_dev '
      export HOME="$1"
      cd "$HOME" || exit 1
      claude mcp remove servicebay --scope user >/dev/null 2>&1
      claude mcp add --transport http --scope user servicebay "$2" \
        --header "Authorization: Bearer $3" >/dev/null 2>&1
    ' "$DEV_HOME" "$MCP_URL" "$token"; then
    echo "claude-dev: ServiceBay MCP server configured for every session."
  else
    echo "claude-dev: WARNING — could not configure the ServiceBay MCP server." >&2
  fi
}

# One full reconcile pass: discover the checkouts, make git usable in each of
# them, then start a session for any that has none yet. Every step is
# idempotent — `--replace-all` rather than `--add`, and `start-claude` skips a
# repo whose tmux window already exists — so this is safe to run both at boot
# and on a timer, which is how a checkout that appears AFTER the container
# started still ends up with a usable session (#2612).
reconcile_repos() {
  discover_repos
  # Every checkout, development target or not — see select_autostart_repos.
  register_safe_directories "${repos[@]}" \
    || echo "claude-dev: WARNING — could not register every checkout as a git safe.directory; git may refuse to run in a root-owned one." >&2
  select_autostart_repos "${repos[@]}"
  [ "${#autostart_repos[@]}" -gt 0 ] || return 0
  autostart_claude "${autostart_repos[@]}" \
    || echo "claude-dev: WARNING — autostart of Claude sessions reported an error." >&2
}

# Hand the discovered repo list to `start-claude` as an argv array.
# $DEV_HOME and every repo name cross the su boundary as positional
# parameters; the only shell source here is the literal single-quoted script,
# which contains no interpolation at all.
autostart_claude() {
  su_dev '
    if [ "$#" -lt 2 ]; then
      echo "claude-dev: autostart received no arguments across the su boundary." >&2
      exit 1
    fi
    dev_home="$1"; shift
    cd "$dev_home" || exit 1
    export HOME="$dev_home" CLAUDE_START_NO_ATTACH=1
    exec start-claude --continue --allow-dangerously-skip-permissions -- "$@"
  ' "$DEV_HOME" "$@"
}

# List the uids of the LLDAP group members allowed to log in.
#
# The bind password goes to ldapsearch through a mode-0600 file (`-y`), never
# on the command line (`-w`), where any user on the box could read it out of
# /proc/<pid>/cmdline. `printf '%s'`, not `echo`: ldapsearch takes the file's
# ENTIRE contents as the password, a trailing newline included.
ldap_group_members() {
  local pwfile
  pwfile="$(mktemp)"
  chmod 600 "$pwfile"
  printf '%s' "$LLDAP_ADMIN_PASSWORD" > "$pwfile"
  ldapsearch -x -LLL -o ldif-wrap=no \
    -H "$ldap_uri" -D "$admin_dn" -y "$pwfile" \
    -b "$group_dn" '(objectClass=*)' member 2>/dev/null \
    | sed -n 's/^member: uid=\([^,]*\),.*/\1/p' | sort -u
  rm -f "$pwfile"
}

# Credential + private-state files under $DEV_HOME that must belong to `dev`
# alone. Relative to $DEV_HOME so the fake workspace in the regression test
# exercises the same list the boot sequence uses.
#
# `.config/gh/hosts.yml` is the GitHub OAuth token every session pushes with;
# `.claude/.credentials.json` is the Claude OAuth blob; `settings.json` and
# `history.jsonl` are the session's own private state. They are created by
# tools run in a root shell (`gh auth login` over `podman exec`, a restore),
# which leaves them root-owned mode 0777 — readable AND overwritable by every
# provisioned LLDAP user, since sshd admits `AllowGroups dev ldapusers`
# (#2672).
DEV_PRIVATE_DIRS=(
  '.config'
  '.config/gh'
  '.claude'
)
DEV_PRIVATE_FILES=(
  '.config/gh/hosts.yml'
  '.claude/.credentials.json'
  '.claude/settings.json'
  '.claude/history.jsonl'
)

# Re-assert `dev`-only ownership and mode on those paths. Runs on every boot,
# so a file recreated by hand as root is retightened on the next restart and a
# volume restore cannot quietly reopen the token.
#
# Two properties this is built around:
#
#   * ORDER. chown BEFORE chmod, and chmod ONLY if the chown succeeded. Today
#     `dev` can read a root-owned hosts.yml solely because it is 0777; mode
#     0600 on a file still owned by root would break `git push` for every
#     session at once. Tightening a file we could not take ownership of is
#     therefore worse than leaving it alone — so we don't.
#
#   * ABSENCE IS NOT AN ERROR. A box that never ran `gh auth login` has no
#     hosts.yml, and a fresh volume has no ~/.claude. Each path is guarded on
#     existence; the function still returns non-zero if a path that IS there
#     could not be secured, so the caller can say so.
secure_dev_private_state() {
  local rel path rc=0 mode secured=0
  for rel in "${DEV_PRIVATE_DIRS[@]}" "${DEV_PRIVATE_FILES[@]}"; do
    path="$DEV_HOME/$rel"
    if [ -d "$path" ]; then
      mode=0700
    elif [ -f "$path" ]; then
      mode=0600
    else
      continue
    fi
    if chown dev:dev "$path" 2>/dev/null; then
      if chmod "$mode" "$path" 2>/dev/null; then
        secured=$((secured + 1))
      else
        rc=1
      fi
    else
      rc=1
    fi
  done
  echo "claude-dev: secured $secured credential/state path(s) under $DEV_HOME as dev-only."
  return "$rc"
}

# Sourcing guard: `CLAUDE_DEV_ENTRYPOINT_LIB=1 source docker-entrypoint.sh`
# stops here with the helpers defined, so the regression test can exercise
# them without the root-only boot sequence below.
if [ -n "${CLAUDE_DEV_ENTRYPOINT_LIB:-}" ]; then
  return 0
fi

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
#
# LLDAP_BASE_DN has no fallback literal (#2439): every DN below is built from
# it, so a guessed value would point nslcd at a tree that does not exist and
# fail every login with an opaque bind error. ServiceBay derives the DN from
# PUBLIC_DOMAIN at install time; if it is still blank here, skip LDAP loudly.
ldap_enabled=no
if [ -n "${LLDAP_ADMIN_PASSWORD:-}" ] && [ -z "${LLDAP_BASE_DN:-}" ]; then
  echo "claude-dev: WARNING — LLDAP_ADMIN_PASSWORD is set but LLDAP_BASE_DN is empty; skipping LDAP login (set it to the base DN the \`auth\` stack initialised LLDAP with)." >&2
fi
if [ -n "${LLDAP_ADMIN_PASSWORD:-}" ] && [ -n "${LLDAP_BASE_DN:-}" ]; then
  LLDAP_HOST="${LLDAP_HOST:-localhost}"
  LLDAP_LDAP_PORT="${LLDAP_LDAP_PORT:-3890}"
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
    members="$(ldap_group_members)"
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

# The GitHub OAuth token and the persisted Claude state are only as private as
# their file modes. Re-assert them here, AFTER the LDAP block has provisioned
# the collaborator accounts that would otherwise be able to read (and
# overwrite) them (#2672).
secure_dev_private_state \
  || echo "claude-dev: WARNING — could not secure every credential file under $DEV_HOME; a token there may still be readable by other logins." >&2

# Long-lived subscription auth, from `claude setup-token` on a machine that
# has a browser. Without it every session here runs on the interactive
# `/login` OAuth blob in ~/.claude, whose refresh token carries a rolling
# ~30-day expiry — so the operator had to SSH in and re-authenticate EVERY
# tmux window by hand, pasting a URL and a code back and forth. That is merely
# tedious at a desk and effectively impossible from the mobile app.
#
# The boot-time autostart below already inherits the variable directly:
# `su_dev` is a NON-login `su`, which preserves the environment. A LOGIN shell
# does not (`su - dev` drops it), and sshd builds a fresh environment for
# every session, so the profile.d drop-in below covers the interactive path.
# It matters for one real case: if the operator kills the tmux server and a
# fresh one is started from an interactive login, that server would otherwise
# be born without the token and every window in it would demand a login.
#
# The ordering is LOAD-BEARING. profile.d is sourced alphabetically, so
# `claude-dev-auth.sh` runs BEFORE `claude-dev-tmux.sh` `exec`s tmux — the
# token is therefore already in the client environment that a newly created
# tmux server inherits. Renaming either file breaks that silently.
#
# Mode 0640 root:dev, NOT profile.d's world-readable default: this token
# spends the OPERATOR'S OWN Claude subscription, and sshd's `AllowGroups` also
# admits `ldapusers`, whose members are deliberately provisioned into
# `ldapusers,devshare` and never into group `dev` (see the useradd above). The
# `[ -r ]` guard makes the file a silent no-op for them rather than an error
# on every login.
auth_profile=/etc/profile.d/claude-dev-auth.sh
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  install -m 0640 -o root -g dev /dev/null "$auth_profile"
  {
    printf '%s\n' '# claude-dev: long-lived subscription token, written at boot by the entrypoint.'
    # `%q` so a token containing shell metacharacters cannot break out of the
    # assignment when a login shell sources this.
    printf 'export CLAUDE_CODE_OAUTH_TOKEN=%q\n' "$CLAUDE_CODE_OAUTH_TOKEN"
  } > "$auth_profile"
  echo "claude-dev: long-lived Claude token supplied — sessions start authenticated, no interactive /login needed."
else
  # Clearing the variable has to actually clear it. The file lives in the
  # image layer, not on /workspace, but a container that is merely RESTARTED
  # after the operator blanked the variable would otherwise keep re-exporting
  # a revoked token, which fails in a far more confusing way than no token.
  rm -f "$auth_profile"
  echo "claude-dev: no CLAUDE_CODE_OAUTH_TOKEN set — sessions use the interactive /login, which lapses roughly monthly. Run 'claude setup-token' on a machine with a browser and set the variable to stop that."
fi

# Auto-start Claude in every git checkout under /workspace BEFORE we exec
# sshd, so live sessions are already running before anyone connects (incl.
# after a container restart, when the tmux server is gone with the old
# process). The deterministic mechanics live in `start-claude`; here we just
# discover the repos and hand them off. Each repo gets its own tmux window
# with Remote Control on and NAMED AFTER THE DIRECTORY (start-claude passes
# `--remote-control <dir>`), so it shows up labelled in the Claude mobile
# app / web; `--continue` resumes that repo's prior conversation from the
# persisted ~/.claude on /workspace, and `--allow-dangerously-skip-permissions`
# lets the session run unattended. start-claude skips any repo whose window
# already exists, so this is idempotent. Runs as `dev` with /workspace as
# $HOME so working dir + auth/history match an interactive login. tmux
# daemonizes, so sshd stays PID 1 — do NOT regress that. CLAUDE_START_NO_ATTACH
# stops start-claude from trying to attach a terminal we don't have here.
#
# Repo discovery, the safe.directory registration that keeps git usable in a
# root-owned checkout, and the su hand-off live in `reconcile_repos` /
# `register_safe_directories` / `discover_repos` / `autostart_claude` at the top
# of this file — the directory names are shared-workspace-writable, so they must
# reach `start-claude` as argv, never as shell source (#2418).
# Before the autostart, not after: a Claude session reads its MCP configuration
# once, at launch. Configuring the server afterwards would leave every session
# started this boot without it until the next restart.
configure_mcp_server

reconcile_repos

if [ "${#autostart_repos[@]}" -gt 0 ]; then
  echo "claude-dev: auto-started Claude in ${#autostart_repos[@]} git repo(s): ${autostart_repos[*]}"
else
  # No DEVELOPMENT checkouts yet — still start an empty `claude` tmux session
  # so interactive logins have something to attach to. The condition is
  # `autostart_repos`, not `repos`: a volume holding only content repos (no
  # CLAUDE.md) starts nothing, and gating on `repos` would leave those boxes
  # with no session for the login shell to attach to at all.
  if su_dev 'tmux has-session -t claude' 2>/dev/null; then
    echo "claude-dev: tmux session 'claude' already running."
  else
    su_dev 'cd "$1" && HOME="$1" tmux new-session -d -s claude' "$DEV_HOME"
    echo "claude-dev: no development checkouts under $DEV_HOME yet — started empty tmux session 'claude' for user 'dev'."
  fi
fi

# Checkouts also appear AFTER boot — cloned inside a running session, restored
# from a backup, or added by a collaborator. Discovery used to run only here, so
# such a checkout got neither a session nor a safe.directory entry until the
# next container restart (#2612). A small background reconcile loop closes that
# gap. It is a plain subshell backgrounded before the `exec` below, so sshd
# stays PID 1 (do NOT regress that) and reaps it as its own child. Set
# CLAUDE_DEV_REPO_RESCAN_SECONDS=0 to switch the loop off.
rescan_interval="${CLAUDE_DEV_REPO_RESCAN_SECONDS:-300}"
if [ "$rescan_interval" -gt 0 ] 2>/dev/null; then
  ( while sleep "$rescan_interval"; do reconcile_repos || true; done ) &
  echo "claude-dev: rescanning $DEV_HOME for new checkouts every ${rescan_interval}s."
else
  echo "claude-dev: repo rescan disabled — a checkout added after boot gets its session on the next restart."
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
