# Connecting an LLM to ServiceBay (MCP)

ServiceBay exposes a [Model Context Protocol](https://modelcontextprotocol.io)
server at `/mcp` so an AI assistant — Claude Code, Claude Desktop, or anything
else that speaks MCP — can drive your homelab directly. Available tools include
`list_services`, `start_service` / `stop_service` / `restart_service`,
`update_service_yaml`, `add_proxy_route`, `run_backup`, `get_health_checks`,
`exec_command`, and ~30 others. Sensitive fields (`auth.passwordHash`,
SMTP/OIDC secrets) are redacted on read and write-allowlisted.

## Quick start (Claude Code)

> **Prereq:** you can log into the ServiceBay UI in your browser.

> **Tip:** for a long-lived, revocable connection, prefer a named **API token**
> over scraping the session cookie — see [API tokens](#api-tokens-recommended) below.

### 1. Grab a session cookie

ServiceBay's `/mcp` endpoint authenticates the same way the web UI does — a
session-cookie JWT. The cookie is `HttpOnly`, so you have to copy it via
DevTools (one-time):

1. Open the ServiceBay UI in Chrome/Firefox and log in.
2. Open DevTools → **Application** → **Storage → Cookies → `http://your-host:5888`**.
3. Copy the value of the `session` cookie. It looks like
   `eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYWRtaW4i…` (JWT).

### 2. Register with Claude Code

```bash
claude mcp add --transport http servicebay \
  http://192.168.x.x:5888/mcp \
  --header "Cookie: session=PASTE_THE_JWT_HERE"
```

All flags must come **before** the server name (`servicebay`). For multiple
headers, repeat `--header`.

### 3. Verify

```bash
claude mcp list                # should include "servicebay: http://..."
claude mcp get servicebay      # full details
```

Inside Claude Code, run `/mcp` to see the connection status and tool count.

### 4. Remove (if needed)

```bash
claude mcp remove servicebay
```

## Manual config (any MCP client)

Equivalent JSON for `~/.claude.json` (user scope), `.mcp.json` (project scope),
or Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "servicebay": {
      "type": "http",
      "url": "http://192.168.x.x:5888/mcp",
      "headers": {
        "Cookie": "session=PASTE_THE_JWT_HERE"
      }
    }
  }
}
```

## Sessions expire after 24 hours

The session JWT is short-lived. When it expires the MCP server returns 401 and
you'll need to grab a fresh cookie from the browser. Two ways to soften this:

### Option A: env var

Claude Code (v2.1.121+) supports `${VAR}` expansion in `.mcp.json`:

```json
{
  "mcpServers": {
    "servicebay": {
      "type": "http",
      "url": "http://192.168.x.x:5888/mcp",
      "headers": {
        "Cookie": "session=${SERVICEBAY_JWT}"
      }
    }
  }
}
```

Then `export SERVICEBAY_JWT=…` (or set it in your shell rc) and restart
Claude Code. Refreshing the JWT becomes a one-line `export`, no JSON edit.

### Option B: dynamic refresh script

```json
{
  "mcpServers": {
    "servicebay": {
      "type": "http",
      "url": "http://192.168.x.x:5888/mcp",
      "headersHelper": "/usr/local/bin/get-servicebay-jwt.sh"
    }
  }
}
```

`get-servicebay-jwt.sh` must print a JSON object to stdout, e.g.
`{"Cookie": "session=…"}`. Useful if you can wrap a real login flow.

## Connection notes

- **HTTPS:** if you're behind a TLS-terminating reverse proxy (Nginx Proxy
  Manager, Caddy, …), use the `https://` URL — the session cookie is set
  `Secure` in that case and only travels over TLS.
- **Plain HTTP on LAN:** works fine. Just make sure the URL in your MCP config
  matches the origin you logged into in the browser (otherwise the JWT is for
  a different origin and won't be valid here).
- **SSH tunnel from a remote workstation:**
  ```bash
  ssh -L 5888:localhost:5888 admin@your-servicebay-host
  ```
  Then point Claude Code at `http://localhost:5888/mcp`. Many browsers and
  clients treat `localhost` as trustworthy, sidestepping cookie/CORS quirks.

## What can the LLM actually do?

A non-exhaustive list — call `claude mcp get servicebay` (or `/mcp` inside
Claude Code) to see the live tool registry on your version.

| Category | Tools |
|----------|-------|
| Services | `list_services`, `start_service`, `stop_service`, `restart_service`, `deploy_service`, `update_service_yaml`, `delete_service`, `rename_service` |
| Containers | `list_containers`, `get_container_logs`, `get_podman_logs` |
| Health | `get_health_checks`, `create_health_check`, `delete_health_check`, `run_check_now` |
| Proxy | `get_proxy_routes`, `add_proxy_route`, `remove_proxy_route` |
| Backups | `list_backups`, `run_backup`, `restore_backup` |
| System | `list_nodes`, `get_system_info`, `get_network_graph`, `get_config`, `update_config`, `exec_command` |
| Unmanaged bundles | `get_unmanaged_bundles`, `merge_unmanaged_bundle` |

Sensitive config fields (`auth.passwordHash`, `oidc.clientSecret`, SMTP
passwords) are redacted from `get_config` and write-allowlisted in
`update_config`.

### Migrating legacy services into ServiceBay (ARCH-14)

ServiceBay discovers systemd/Podman services on each node that aren't
under its management. The LLM can enumerate those bundles and either
preview or execute a merge into a single managed Quadlet stack.

```text
get_unmanaged_bundles(node?) → ServiceBundle[]
  Read scope. Returns every unmanaged bundle the digital twin has
  detected on `node` (default: first node). Each bundle includes an
  `id`, `displayName`, `severity` (`info` | `warning` | `critical`),
  member `services`, hints, validations, and a discovery graph.

merge_unmanaged_bundle(bundleId, newName, node?, dryRun?) → plan | ok
  Mutate scope, destructive. Maps the bundle's members to
  DiscoveredService records and invokes the same merge pipeline as
  the React Service Bundle Merge Wizard.
    - `dryRun: true`  → returns `{ dryRun: true, plan: MergePlan }`
      with the generated Quadlet/YAML and a pre-mutation validation
      report. No filesystem writes, no service stops.
    - `dryRun: false` → executes the merge: stops legacy units,
      writes the new `{newName}.kube` + `{newName}.yml` to the
      systemd Quadlet dir, registers the merged service. `safeHandler`
      snapshots the system first and emails the operator on success.
```

Workflow the agent typically follows:

1. `get_unmanaged_bundles` → pick a bundle by its `id` and `severity`.
2. `merge_unmanaged_bundle(bundleId, newName, dryRun: true)` → review
   the plan's `stackPreview`, `validations`, and `fileMappings`.
3. Confirm with the operator (or check `config.mcp.allowMutations`).
4. `merge_unmanaged_bundle(bundleId, newName)` → the merge runs and is
   audited under `mcp.audit` with the snapshot id for one-click rollback.

## Troubleshooting

- **`401 Unauthorized` on first use** — the JWT pasted into your config is
  expired or for a different host. Grab a fresh one from DevTools.
- **`401 Unauthorized` after working for a while** — the JWT expired (24h).
  Refresh it. See the env-var option above to make this less painful.
- **Custom-header bug ([upstream issue #29562](https://github.com/anthropics/claude-code/issues/29562))**
  — there's a known Claude Code edge case where headers aren't sent during
  the initial MCP session-establishment handshake, surfacing as an instant
  401. Workaround: `headersHelper` script (Option B above).
- **`405 Method not allowed`** — only `POST /mcp` is implemented. If you see
  this, your client is using GET or another verb.

## API tokens (recommended)

ServiceBay has a first-class named API-token surface — long-lived, revocable,
and scoped — so MCP clients don't have to scrape a browser session cookie.

1. In the ServiceBay UI, go to **Settings → MCP** and create a named token
   (or `POST /api/system/mcp-tokens`). The secret is shown **once**, in the
   form `sb_<id>_<secret>`.
2. Register it with an `Authorization: Bearer` header instead of `Cookie`:

   ```bash
   claude mcp add --transport http servicebay \
     http://<your-host>:5888/mcp \
     --header "Authorization: Bearer sb_<id>_<secret>"
   ```
3. Revoke it any time from the same **Settings → MCP** screen. Unlike the
   session cookie, the token does not expire after 24h.

Tokens carry explicit scopes, so prefer a read-only token for an assistant
that only needs to observe.
