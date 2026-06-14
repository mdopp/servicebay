---
lucide_icon: "bot"
category: "Development"
tagline: "Code against your repos from anywhere — a Claude Code dev box that lives on the home server, no laptop required."
# claude-dev has no subdomain / proxy host, so there's no "Open" URL.
# The card renders via the appless path (#1618): the primary action is
# the web terminal deep-link that attaches to the container's persistent
# `claude` tmux session (#1617), and the VS Code Remote-SSH handoff is a
# desktop-only secondary action.
#
# The container that `podman play kube` creates is named
# `<pod>-<container>` = `claude-dev-claude-dev` (pod `claude-dev` +
# container `claude-dev`), NOT `claude-dev`. The terminal deep-link must
# target that real container name, or `podman exec` finds no such
# container (#1681).
primary_action:
  type: "in_app"
  label: "Open terminal"
  href: "/terminal?node=Local&container=claude-dev-claude-dev&attach=claude"
  icon: "bot"
actions:
  # vscode:// hands off to the desktop VS Code app's Remote-SSH. The host
  # and port come from the install (the box's LAN IP and the
  # CLAUDE_DEV_SSH_PORT you set), so the `HOST`/`PORT` tokens below are
  # interpolated at render time by the portal card builder (#1682). The
  # body keeps the copy-the-command fallback for outside-LAN / dyn-DNS.
  # desktop_only defaults true for external_scheme, so the phone UI hides
  # this button.
  - type: "external_scheme"
    label: "Open in VS Code (desktop)"
    href: "vscode://vscode-remote/ssh-remote+dev@HOST:PORT/workspace"
    icon: "package"
---

# Coding from anywhere with Claude Dev

This is a development box that runs on the home server 24/7. It carries the
**Claude Code** CLI, `git`, the GitHub CLI, and a Node toolchain, with a
persistent `/workspace` that survives restarts. Drive it from your phone,
your laptop, or a browser tab — the session keeps running on the box even
when you close the lid.

There's no website to open here: the card's **Open terminal** button drops
you straight into the box's terminal, attached to the always-on `claude`
session.

## Open the terminal (primary)

Click **Open terminal** on the card. It opens the ServiceBay web terminal
already attached to the container's persistent `claude` tmux session — the
same session the mobile app and an SSH login land in. Close the tab and the
session keeps running; re-open it and you're back where you left off.

## Open in VS Code (desktop)

On a desktop with [VS Code](https://code.visualstudio.com/) and the
**Remote - SSH** extension, you can edit `/workspace` natively. The card's
**Open in VS Code** button uses this URL scheme — but the host and port
come from *your* install, so copy the real link with your values filled in:

```
vscode://vscode-remote/ssh-remote+dev@<host>:<port>/workspace
```

- `<host>` — the home server's LAN IP (the same address you use to reach
  ServiceBay), or your dynamic-DNS / public hostname when connecting from
  outside.
- `<port>` — the `CLAUDE_DEV_SSH_PORT` you chose at install (default
  `2222`; shown on the install/credentials screen).

Example on the LAN with the default port:

```
vscode://vscode-remote/ssh-remote+dev@192.168.1.50:2222/workspace
```

The `dev` user's password is on the post-install credentials banner (or use
your SSH key if you supplied `CLAUDE_DEV_SSH_AUTHORIZED_KEY`).

## Connect over SSH (terminal / mobile app)

When the **Authelia/LLDAP** stack is installed, you sign in with your **own
LLDAP account** (e.g. `mdopp`) and your LLDAP password — the box authenticates
against the directory, so there's no shared account to hand around:

```sh
ssh -p <port> <your-ldap-user>@<host>
```

Only members of the configured LLDAP group (default `lldap_admin`) may log in.
Each LDAP user gets their own persistent home at `/workspace/home/<user>`.

A local **`dev`** account stays available as a break-glass fallback (its
password is on the post-install credentials banner, or use your SSH key), so a
directory hiccup can't lock you out:

```sh
ssh -p <port> dev@<host>
```

`sshd` binds the port directly on the host, so on the LAN you connect straight
to it; from outside, add a FritzBox port-forward for that port first.

Every interactive login auto-attaches to the persistent `claude` tmux
session, so a closed phone or a network blip never kills your work. Detach
without stopping it with `Ctrl-b d`; re-attach manually with:

```sh
tmux new -A -s claude
```

## Log in to Claude (first time)

Inside the session, run Claude once and complete the login — it persists to
`~/.claude` on the `/workspace` volume, so you only do this once (it survives
container restarts):

```sh
claude
```

Follow the OAuth prompt to sign in. On a headless box where the browser
hand-off is awkward, mint a token instead and paste it when asked:

```sh
claude setup-token
```

After a restart, resume the previous conversation from the persisted history
with:

```sh
claude --continue
```

## Switch repositories

`/workspace` is your persistent home, so you can keep several checkouts side
by side. Clone a new repo with the GitHub CLI (run `gh auth login` once — it
also persists), then start Claude in it:

```sh
cd /workspace && gh repo clone <owner>/<repo>
cd <repo> && claude
```

Switching back later is just `cd /workspace/<repo> && claude` — nothing to
re-clone.
