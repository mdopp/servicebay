# claude-dev — containerised Claude Code CLI + ServiceBay dev toolchain.
#
# Published as ghcr.io/mdopp/servicebay-claude-dev:latest by
# .github/workflows/claude-dev-image.yml. The `claude-dev` stack
# template references that tag.
#
# Built FROM node:20-bookworm-slim so the Node version matches the
# repo's `engines.node` (20.x) — native npm modules compiled inside a
# session are ABI-compatible with what CI builds against.
FROM node:20-bookworm-slim

# Toolchain:
#   - openssh-server/-client : SSH in (mobile app) + host-key gen
#   - git                    : repo ops
#   - make/gcc/g++/python3   : native-module builds (better-sqlite3, …)
#   - podman                 : run the repo's container e2e scripts
#   - procps/iproute2        : ps/ss for debugging from inside a session
#   - tmux                   : persistent session that survives disconnects
#   - curl/ca-certificates/gnupg : fetch the GitHub CLI apt key
#   - nslcd/libnss-ldapd/libpam-ldapd : authenticate SSH logins against the
#       box's LLDAP so the operator signs in as their real LDAP user (e.g.
#       `mdopp`) instead of the shared local `dev` account. ldap-utils ships
#       `ldapsearch` for on-box debugging of the bind.
# The GitHub CLI (`gh`) is not in Debian's repos, so add its apt source.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      openssh-server openssh-client git bash \
      make gcc g++ python3 \
      podman procps iproute2 tmux \
      curl ca-certificates gnupg \
      nslcd libnss-ldapd libpam-ldapd ldap-utils \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Claude Code CLI — installed globally so `claude` is on PATH for every
# SSH session. Package name per the published npm package.
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

# Non-root `dev` user. Its home is /workspace — the template mounts a
# persistent volume there, so git checkouts, ~/.claude session history
# and gh auth all survive container restarts. --create-home seeds the
# skeleton; the runtime bind mount then takes over and the entrypoint
# re-scaffolds it.
# `devshare` is the shared-workspace group: `dev` plus every provisioned LDAP
# user belong to it so they can collaborate on the same /workspace checkouts.
# umask 002 (login shells) makes new files group-writable; paired with the
# setgid bit the entrypoint puts on /workspace, new clones stay shared.
RUN groupadd devshare \
 && useradd --create-home --home-dir /workspace --shell /bin/bash -G devshare dev \
 && printf '%s\n' 'umask 002' > /etc/profile.d/claude-dev-umask.sh

# LDAP auth wiring (nss-pam-ldapd), baked deterministically at build time.
#
# LLDAP (0.6.x) is an auth directory, not a POSIX/NSS source: it serves no
# uidNumber/gidNumber/homeDirectory and groups carry DN `member`s, not
# `memberUid`/`gidNumber`. So NSS can't resolve LLDAP users the normal way.
# Instead we use LDAP for AUTHENTICATION only: PAM (pam_ldap) verifies a
# password by binding to LLDAP as the user's DN, and the entrypoint
# auto-provisions a matching LOCAL account per group member so NSS (files)
# can resolve them. nslcd is the daemon pam_ldap talks to; it's configured
# and started by the entrypoint only when LLDAP_ADMIN_PASSWORD is set, so a
# box without the auth stack still boots with just the `dev` break-glass user.
#   - nsswitch stays `files`-only — local accounts (root, dev, provisioned
#     LDAP users) resolve fast and independently of the directory.
#   - pam_ldap in the common-* stacks (via pam-auth-update) does the
#     bind-as-user auth + group authz; pam_mkhomedir seeds each user's home
#     under /workspace/home/<uid> on first login from /etc/skel.
RUN set -eux; \
    printf '%s\n' \
      'passwd:         files' \
      'group:          files' \
      'shadow:         files' \
      'hosts:          files dns' \
      'networks:       files' \
      'protocols:      db files' \
      'services:       db files' \
      'ethers:         db files' \
      'rpc:            db files' \
      > /etc/nsswitch.conf; \
    DEBIAN_FRONTEND=noninteractive pam-auth-update --package --enable ldap; \
    grep -q pam_mkhomedir /etc/pam.d/common-session \
      || echo 'session optional pam_mkhomedir.so skel=/etc/skel umask=0077' >> /etc/pam.d/common-session

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# `start-claude` — manual launcher for one Claude per directory, each with
# Remote Control on and its own tmux window (survives SSH disconnects).
COPY start-claude.sh /usr/local/bin/start-claude
RUN chmod +x /usr/local/bin/start-claude

# Interactive login shells (an SSH session, the web terminal, the mobile
# app) attach to the long-lived `claude` tmux session the entrypoint
# starts on boot, so every connection lands in the SAME live session and
# detaching/disconnecting leaves it running. Guarded on an interactive
# shell ($- has i) and not-already-inside-tmux, so a non-interactive
# `podman exec` (scripts / health probes) is never trapped. Lives in the
# image layer (not under the /workspace bind mount that takes over $HOME),
# and `exec`s so the tmux client becomes the login shell. `new -A` creates
# the session if the boot-time one is somehow gone.
RUN printf '%s\n' \
      '# claude-dev: attach interactive logins to the persistent tmux session.' \
      'if [ -z "${TMUX:-}" ] && [ -n "${SSH_CONNECTION:-}" ] && case "$-" in *i*) true;; *) false;; esac; then' \
      '  exec tmux new -A -s claude' \
      'fi' \
      > /etc/profile.d/claude-dev-tmux.sh

# Informational — the real port is set at runtime via CLAUDE_DEV_SSH_PORT.
EXPOSE 2222

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
