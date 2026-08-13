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

It's also a **shared working area**: `dev` and every provisioned LDAP user
(see below) belong to the `devshare` group, and `/workspace` is `dev:devshare`
mode `2775` (setgid) with login shells defaulting to `umask 002`. So checkouts
cloned by one user are writable by the others — you log in as `mdopp` and work
on the same `/workspace/servicebay` clone regardless of who cloned it. Per-user
homes under `/workspace/home/<user>` stay private (mode `700`).

## Variables

| Variable | Purpose |
|---|---|
| `CLAUDE_DEV_SSH_PORT` | Host port sshd listens on (default `2222`). |
| `CLAUDE_DEV_SSH_PASSWORD` | Auto-generated password for the local `dev` break-glass user; surfaced as a credential after install. |
| `CLAUDE_DEV_SSH_AUTHORIZED_KEY` | Optional SSH public key for the `dev` user; enables key-based login (recommended when the box is reachable from outside the LAN). |
| `LLDAP_ADMIN_PASSWORD` | LLDAP bind password. **Not asked for** — reused automatically from the value the `auth` stack generated. Empty ⇒ LDAP login off, `dev` only. |
| `CLAUDE_DEV_LDAP_GROUP` | LLDAP group whose members may SSH in (default `admins`). |
| `LLDAP_LDAP_PORT` / `LLDAP_BASE_DN` | LLDAP coordinates; default to the `auth` stack's (`3890` / the base DN derived from `PUBLIC_DOMAIN`). LDAP login is skipped when the base DN is blank. The LLDAP *host* is not a variable — since template v2 the pod reaches it at `host.containers.internal` (see [CHANGELOG](CHANGELOG.md)). |

## Logging in as your own LDAP user

When the `auth` stack is installed, the container authenticates SSH logins
against the box's **LLDAP**, so you sign in as your real LDAP user (e.g.
`mdopp`) with your LLDAP password — no shared `dev` account:

```sh
ssh -p 2222 mdopp@<server-ip>      # password = your LLDAP password
```

How it works — LLDAP 0.6.x is an *auth* directory, not a POSIX/NSS source (it
serves no `uidNumber`/`gidNumber`, and groups carry DN `member`s rather than
`memberUid`). So the container uses LDAP for **authentication only**:

- `pam_ldap` (via `nslcd`) verifies the password by **binding to LLDAP as the
  user's DN** — no POSIX attributes required.
- On start, the entrypoint reads the members of `CLAUDE_DEV_LDAP_GROUP`
  (default `admins`) and **provisions a matching local account** for each, so
  the OS can resolve them. The password is never stored locally — every login
  is checked against LLDAP. New group members appear after a container
  restart.
- Login is gated twice: an nslcd `pam_authz_search` `memberof` filter **and**
  sshd `AllowGroups` (the local `ldapusers` group).
- Each user gets a persistent home at `/workspace/home/<user>`, so their
  `~/.claude` history and `gh` auth survive restarts independently.
- The local **`dev`** account stays as a break-glass path (its password/key
  still work), so a directory outage or LDAP misconfig can't lock you out.
- LDAP is **opt-in**: with `LLDAP_ADMIN_PASSWORD` blank (auth not installed)
  the container skips all LDAP wiring and behaves exactly as before.

## Reaching it from a phone

`CLAUDE_DEV_SSH_PORT` is published on the host via `hostPort` with no
`hostIP`, so it answers on every interface. (Before template v2 the pod ran
with `hostNetwork` and sshd bound the host directly — the reachability is the
same, the blast radius is not; see [CHANGELOG](CHANGELOG.md) and
[ADR 0007](../../docs/adr/0007-container-network-isolation-and-carveouts.md).)
On the LAN, connect straight to `dev@<server-ip>:<port>`. From outside, add a
FritzBox port-forward for that port and point the Claude Code mobile app's SSH
connection at it.

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

## Running several Claudes at once (`start-claude`)

`start-claude` launches one Claude per directory — each with **Remote Control
enabled** and **named after the directory** (so it's labelled in the mobile
app / web), in its own window of the shared `claude` tmux session. Because they
run in tmux, they keep going when you disconnect.

```sh
# from /workspace (where your clones live)
start-claude --allow-dangerously-skip-permissions servicebay solbay
```

- Leading `--flags` are passed through to `claude`; the bare names are
  directories (relative to the current dir, or absolute).
- Re-running skips a directory that already has a live window — safe to call
  again to add more.
- Switch between them with `Ctrl-b w` (window list) or `Ctrl-b <n>`.
- The container also runs this **automatically at boot** (see below); call it
  by hand to add more directories or use different flags.

### Auto-start at boot

On container start the entrypoint auto-launches one Claude per **git checkout**
under `/workspace` (any top-level dir with a `.git`), each with `--continue
--allow-dangerously-skip-permissions` and Remote Control named after the
directory — so every repo's session comes back up labelled in the mobile app /
web without logging in. Hidden dirs (`~/.ssh`, `~/.claude`) and per-user homes
are skipped. A fresh volume with no checkouts yet just gets an empty `claude`
tmux session to attach to; clone a repo and restart (or run `start-claude`) to
bring it up.

## Persistent session (tmux)

The container boots a detached `tmux` session named **`claude`** as the
`dev` user, and every interactive SSH login (the terminal, the mobile
app) automatically **attaches** to it. That means a closed phone or a
network blip no longer kills `claude`: the session keeps running on the
box, and the next connection lands right back in it.

- Re-attach manually (or from a non-login shell): `tmux new -A -s claude`
- Detach without killing it: `Ctrl-b d` (the session stays live).
- After a container restart, the entrypoint re-launches Claude per git repo
  (see "Auto-start at boot"); `--continue` resumes each repo's prior
  conversation from the persisted `~/.claude` on `/workspace`.

A non-interactive `podman exec` (scripts, health probes) is **not**
attached, so automation isn't trapped in tmux.

## Non-goals (first iteration)

- Running the full ServiceBay test suite *inside* this container
  (podman-in-podman / CI parity) — a later phase can add the e2e harness.
- Auto-cloning a repo on container start — the operator clones manually.
- Heavy multi-user concurrency. LDAP login gives each operator their own
  identity + home, but the box is still sized for one person at a time
  (a single shared `/workspace` checkout area, no per-user resource limits).
