# Connecting an LLM (MCP)

ServiceBay exposes a Model Context Protocol (MCP) server at `/mcp` so an AI
assistant — Claude Code, Claude Desktop, or any MCP-aware client — can drive
your homelab directly. Tools include start/stop/restart services, edit Quadlet
YAML, manage proxy routes, run backups, configure health checks, and more.

## Setup (Claude Code)

### 1. Create an API token (recommended)

Open **Settings → Security → API tokens → New token**.
Pick a name (e.g. `Claude Code on workstation`) and the scopes you want
this client to have:

- **read** — list/get only. The safest default.
- **lifecycle** — adds start/stop/restart, run-check-now, refresh-agent.
- **mutate** — adds deploy/update/add-route/create-check.
- **destroy** — adds delete/exec/restore/purge. Use sparingly.

The token is shown **once** when you create it — copy it now. Format:
`sb_<id>_<secret>`. Revoke any time without affecting other clients.

### 2. Register the server

```bash
claude mcp add --transport http servicebay \
  <YOUR_SERVICEBAY_URL>/mcp \
  --header "Authorization: Bearer sb_xxxxxxxx_YOUR_TOKEN_HERE"
```

Replace `<YOUR_SERVICEBAY_URL>` with the URL you used to log in (the same
one shown in the **MCP Server** card on Settings → Security).

> **Legacy: session cookie.** Pre-existing MCP setups that pass
> `Cookie: session=<JWT>` still work and have full scopes. New clients
> should use Bearer tokens — they're per-client, scope-able, and
> revocable.

### 3. Verify

```bash
claude mcp list           # should list "servicebay"
claude mcp get servicebay # full status + tool count
```

Inside Claude Code, run `/mcp` to confirm the connection.

## Manual JSON config

For Claude Desktop or `~/.claude.json` / `.mcp.json` direct edits:

```json
{
  "mcpServers": {
    "servicebay": {
      "type": "http",
      "url": "<YOUR_SERVICEBAY_URL>/mcp",
      "headers": { "Cookie": "session=PASTE_THE_JWT_HERE" }
    }
  }
}
```

## Heads-ups

- **The session JWT expires after 24h.** When it does, the MCP server returns
  `401` and you need to copy a fresh cookie. Use a `${SERVICEBAY_JWT}` env-var
  in `.mcp.json` so refreshing is one `export`.
- **Use the URL you logged into.** A JWT issued for `http://192.168.x.x:5888`
  isn't valid for `http://localhost:5888`. If you log in via an SSH tunnel,
  use the `localhost` URL in your MCP config.
- **TLS:** if you reach this UI via `https://…`, use that URL. The cookie is
  marked `Secure` and won't travel over plain HTTP.

## Safety toggles

Two switches on this card control how much of ServiceBay an MCP client can
touch. Fresh installs default to **read-only** — flip the switches only for
trusted clients.

- **Allow MCP clients to mutate state.** Off by default. When off, MCP can
  read services / logs / health / config but cannot start/stop/restart,
  deploy, delete, exec, or restore. Read-only mode covers the most common
  use case (Claude advising you on what's running) without any risk.
- **Allow dangerous `exec_command` patterns.** Off by default and can only
  be flipped on after mutations are enabled. The denylist refuses
  `rm -rf /`, `mkfs`, `dd of=/dev/sd*`, partition editors, redirects to
  raw block devices, and a few other foot-guns. If your workflow genuinely
  needs one of these through MCP, lift the switch (and reach for it
  carefully).

## Auto-snapshot before destructive ops

When mutations are enabled, ServiceBay takes a labelled system-config
snapshot **before** any destructive MCP call (`delete_service`,
`update_service_yaml`, `update_config`, `restore_backup`, `exec_command`).
You'll find the snapshots in **Settings → Backups** with a
`pre-mutation:<tool>` timestamp; one click rewinds the change.

## What's documented in full

The complete reference (env-var setup, dynamic refresh scripts, full tool
list, troubleshooting) lives at
[`docs/MCP.md`](https://github.com/mdopp/servicebay/blob/main/docs/MCP.md)
in the repo.
