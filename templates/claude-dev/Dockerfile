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
# The GitHub CLI (`gh`) is not in Debian's repos, so add its apt source.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server openssh-client git bash \
      make gcc g++ python3 \
      podman procps iproute2 tmux \
      curl ca-certificates gnupg \
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
RUN useradd --create-home --home-dir /workspace --shell /bin/bash dev

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

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
