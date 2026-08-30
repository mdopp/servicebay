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
| `CLAUDE_CODE_OAUTH_TOKEN` | Optional long-lived Claude subscription token, so sessions never need an interactive `/login`. See [Staying logged in](#staying-logged-in). Blank keeps the interactive login. |
| `SERVICEBAY_MCP_TOKEN` | Optional read-only ServiceBay API token, wired as an MCP server for every session. See [Reading ServiceBay from a session](#reading-servicebay-from-a-session). |
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

On container start the entrypoint auto-launches one Claude per **development
checkout** under `/workspace`, each with `--continue
--allow-dangerously-skip-permissions` and Remote Control named after the
directory — so every repo's session comes back up labelled in the mobile app /
web without logging in. Hidden dirs (`~/.ssh`, `~/.claude`) and per-user homes
are skipped. A volume with no development checkouts just gets an empty
`claude` tmux session to attach to; clone a repo and restart (or run
`start-claude`) to bring it up.

**A development checkout is a top-level dir with both a `.git` and a
`CLAUDE.md`.** Content repos live here too — a repo that is only data, docs or
templates has nothing for an unattended agent to do — and `CLAUDE.md` is the
marker because a repo meant to be worked on by Claude Code carries one anyway.
Checkouts skipped this way are **named in the log** on every boot and whenever
the set changes:

```
claude-dev: skipping 1 checkout(s) with no CLAUDE.md (not a development target): servicebay-templates
```

Add a `CLAUDE.md` to bring a repo into the autostart. `safe.directory` is
registered for *every* checkout regardless, so git works when you `cd` into a
skipped one by hand.

Two behaviours exist because a session that dies takes its window with it, and
a repo with no window is indistinguishable from a healthy one:

- `--continue` is tried first and **falls back to a fresh session** if there is
  nothing to resume. Without this, every newly cloned checkout died on startup
  (`claude --continue` exits 1 when no conversation is persisted) and silently
  never got a session.
- `remain-on-exit failed` keeps a **dead pane visible** with its exit status
  instead of closing the window. A clean exit still tidies itself away.

## Staying logged in

The sessions here start unattended at boot, so authentication cannot be
interactive. Two modes:

**With `CLAUDE_CODE_OAUTH_TOKEN` set (recommended).** Generate the token once
on any machine that has a browser — it is account-scoped, not machine-scoped,
so your laptop's token works on the box:

```sh
claude setup-token
```

Paste the result into the variable at install or re-configure time. Every
session then starts already authenticated: no `/login`, no URL to copy, and
nothing to redo after a container restart.

**Blank (the default).** Sessions fall back to the interactive `/login`, whose
OAuth refresh token carries a rolling **~30-day expiry**. When it lapses every
tmux window has to be re-authenticated by hand — SSH in, `/login`, copy the
URL into a browser, paste the code back, once per window. That is tedious at a
desk and effectively impossible from the mobile app, which is the whole reason
the variable exists. The entrypoint logs which of the two modes it booted in.

The token is written to `/etc/profile.d/claude-dev-auth.sh` at boot as
`0640 root:dev`, deliberately **not** profile.d's world-readable default: it
spends your own Claude subscription, and LDAP users (who are in `ldapusers` and
`devshare`, never in group `dev`) must not be able to read it. Clearing the
variable and restarting removes the file rather than leaving a revoked token
behind.

## Reading ServiceBay from a session

A session regularly needs to look something up about the box it runs on — an
ADR, an assist, a service's logs, its rendered definition. Set
`SERVICEBAY_MCP_TOKEN` and the entrypoint registers ServiceBay as an MCP server
for every session at boot, so nothing has to be pasted in by hand.

**Mint it with the `read` scope only, and tick "Never Expires".** ServiceBay
offers that option exclusively for read-only scope sets, which makes the token
configure-once. Anything from `lifecycle` upward expires within 30 days.

When a session genuinely needs to change something it asks: `request_token`
needs only `read`, so the session can request a short-lived `lifecycle` token
and you approve that one job from the UI. A shell goes through the one-shot
flow, bound to a single operation, minted on approval and burned after use.

One shared token is deliberate. ServiceBay's scope ladder has no per-service
granularity, so a read-only token is equally harmless in every checkout and
per-repo tokens would buy attribution and nothing else. User scope also covers
checkouts cloned later, with no reconcile pass to run.

If you ever configure this by hand, note two things:

- Use `--scope user` (or `local` for a single project) — **never
  `--scope project`**, which writes `.mcp.json` into the checkout. That file
  is tracked, so the token would be committed.
- The endpoint is `http://host.containers.internal:5888/mcp`. Since the pod
  moved into its own network namespace it cannot resolve the public `admin.`
  hostname; on-box siblings are reached through `host.containers.internal`.
- A session reads its MCP configuration once, at launch. Adding a server to a
  running session does nothing until it restarts.

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
