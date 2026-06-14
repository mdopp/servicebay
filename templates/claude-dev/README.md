# claude-dev

A long-lived development container that carries the [Claude Code](https://claude.com/claude-code)
CLI and the ServiceBay toolchain, so a coding session against this repo
can be driven from the Claude Code mobile app without keeping a laptop
awake. The homelab already runs 24/7 — this makes it the dev host too,
removing the laptop as a single point of failure for development.

## What's in the image

Built from [`Dockerfile`](./Dockerfile) (published as
`ghcr.io/mdopp/servicebay-claude-dev:latest` by
`.github/workflows/claude-dev-image.yml`):

- Node.js 20.x + npm — matches the repo's `engines.node`
- `@anthropic-ai/claude-code` installed globally (`claude` on `PATH`)
- `git` + the GitHub CLI (`gh`)
- `make` / `gcc` / `g++` / `python3` — native-module builds
- the `podman` client — for the repo's `scripts/test-container-e2e.sh`
- an SSH server

`/workspace` is a persistent volume and the `dev` user's home, so git
checkouts, Claude Code session history (`~/.claude`), `gh` auth and the
SSH host keys all survive a container restart.

## Variables

| Variable | Purpose |
|---|---|
| `CLAUDE_DEV_SSH_PORT` | Host port sshd listens on (default `2222`). |
| `CLAUDE_DEV_SSH_PASSWORD` | Auto-generated password for the local `dev` break-glass user; surfaced as a credential after install. |
| `CLAUDE_DEV_SSH_AUTHORIZED_KEY` | Optional SSH public key for the `dev` user; enables key-based login (recommended when the box is reachable from outside the LAN). |
| `LLDAP_ADMIN_PASSWORD` | LLDAP bind password. **Not asked for** — reused automatically from the value the `auth` stack generated. Empty ⇒ LDAP login off, `dev` only. |
| `CLAUDE_DEV_LDAP_GROUP` | LLDAP group whose members may SSH in (default `lldap_admin`). |
| `LLDAP_HOST` / `LLDAP_LDAP_PORT` / `LLDAP_BASE_DN` | LLDAP coordinates; default to the `auth` stack's defaults (`localhost` / `3890` / `dc=dopp,dc=cloud`). |

## Logging in as your own LDAP user

When the `auth` stack is installed, the container authenticates SSH logins
against the box's **LLDAP** via `nss-pam-ldapd`, so you sign in as your real
LDAP user (e.g. `mdopp`) with your LLDAP password — no shared `dev` account:

```sh
ssh -p 2222 mdopp@<server-ip>      # password = your LLDAP password
```

- Only members of the `CLAUDE_DEV_LDAP_GROUP` (default `lldap_admin`) may log
  in — enforced by sshd `AllowGroups` + an nslcd `pam_authz_search` filter.
- Each LDAP user gets a persistent home at `/workspace/home/<user>` (created
  on first login), so their `~/.claude` history and `gh` auth survive
  restarts independently.
- LLDAP doesn't store `homeDirectory`/`loginShell`; nslcd synthesizes them.
- The local **`dev`** account stays as a break-glass path (its password/key
  still work), so a directory outage or LDAP misconfig can't lock you out.
- LDAP is **opt-in**: with `LLDAP_ADMIN_PASSWORD` blank (auth not installed)
  the container skips all LDAP wiring and behaves exactly as before.

## Reaching it from a phone

`sshd` binds `CLAUDE_DEV_SSH_PORT` directly on the host (the pod runs
with `hostNetwork`). On the LAN, connect straight to
`dev@<server-ip>:<port>`. From outside, add a FritzBox port-forward for
that port and point the Claude Code mobile app's SSH connection at it.

## Starting a session

```sh
# SSH in (password from the post-install credentials banner, or your key)
ssh -p 2222 dev@<server-ip>

# Clone the repo you want to work on into the persistent volume
git clone https://github.com/<you>/servicebay /workspace/servicebay
cd /workspace/servicebay

# Start Claude Code
claude
```

The clone only has to be done once — `/workspace` persists, so later
sessions just `cd /workspace/servicebay && claude`.

## Persistent session (tmux)

The container boots a detached `tmux` session named **`claude`** as the
`dev` user, and every interactive SSH login (the terminal, the mobile
app) automatically **attaches** to it. That means a closed phone or a
network blip no longer kills `claude`: the session keeps running on the
box, and the next connection lands right back in it.

- Re-attach manually (or from a non-login shell): `tmux new -A -s claude`
- Detach without killing it: `Ctrl-b d` (the session stays live).
- After a container restart, the entrypoint re-creates the session;
  `claude --continue` resumes the prior conversation from the persisted
  `~/.claude` on `/workspace`.

A non-interactive `podman exec` (scripts, health probes) is **not**
attached, so automation isn't trapped in tmux.

## Non-goals (first iteration)

- Running the full ServiceBay test suite *inside* this container
  (podman-in-podman / CI parity) — a later phase can add the e2e harness.
- Auto-cloning a repo on container start — the operator clones manually.
- Heavy multi-user concurrency. LDAP login gives each operator their own
  identity + home, but the box is still sized for one person at a time
  (a single shared `/workspace` checkout area, no per-user resource limits).
