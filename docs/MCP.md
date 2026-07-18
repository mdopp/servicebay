# Connecting an LLM to ServiceBay (MCP)

ServiceBay exposes a [Model Context Protocol](https://modelcontextprotocol.io)
server at `/mcp` so an AI assistant — Claude Code, Claude Desktop, or anything
else that speaks MCP — can drive your homelab directly. Available tools include
`list_services`, `manage_service` (start/stop/restart via an `action`),
`get_logs` (service/container/podman via a `source`), `update_service_yaml`,
`add_proxy_route`, `run_backup`, `get_health_checks`, `exec_command`, and ~30
others. Sensitive fields (`auth.passwordHash`, SMTP/OIDC secrets) are redacted
on read and write-allowlisted.

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
| Services | `list_services`, `manage_service` (`action: start\|stop\|restart`), `deploy_service`, `update_service_yaml`, `delete_service`, `rename_service` |
| Containers / logs | `list_containers`, `get_logs` (`source: service\|container\|podman`) |
| Templates | `list_templates`, `get_template_artifact` (`artifact: readme\|yaml\|variables`), `install_template` |
| Health | `get_health_checks`, `create_health_check`, `delete_health_check`, `run_check_now` |
| Proxy | `get_proxy_routes`, `add_proxy_route`, `create_proxy_route`, `remove_proxy_route` |
| Requests | `list_requests` (`type: access\|token`), `file_access_request`, `get_access_request_status`, `request_token`, `poll_token_request` |
| Backups | `list_backups`, `run_backup`, `restore_backup` |
| System | `list_nodes`, `get_system_info`, `get_network_graph`, `get_config`, `update_config`, `exec_command`, `get_channel`, `set_channel` |
| Knowledge | `list_assists`, `get_assist`, `get_service_standards` (`flavor: servicebay\|generic`), `propose_learning` (`propose` scope), `list_learning_proposals` / `get_learning_proposal` / `list_assist_drift` (`read`, admin review) |

The three merged tools above (`manage_service`, `get_logs`,
`get_template_artifact`) plus `list_requests` replaced nine (+2) narrower tools
in #2324 — a **breaking change** to the tool surface. Each stays in its original
scope: `get_logs` / `get_template_artifact` / `list_requests` are `read`,
`manage_service` is `lifecycle`.

Sensitive config fields (`auth.passwordHash`, `oidc.clientSecret`, SMTP
passwords) are redacted from `get_config` and write-allowlisted in
`update_config`.

`get_service_standards` (`read` scope) returns a curated *pointer* index for
building a new project. `flavor: 'servicebay'` (default) yields four blocks —
`mustRespectAdrs` (the platform ADRs a new service is bound by, with titles
scanned live from `docs/adr/*.md` so they never drift), `enforcedInvariants`
(pointer to `docs/ARCHITECTURE_INVARIANTS.md` + the gate commands and 70 %
diff-coverage floor), `assistsToRead` (ids resolvable via `get_assist`), and
`templateContract` (pointers to `docs/TEMPLATE_AUTHORING.md` + `templates/CLAUDE.md`).
`flavor: 'generic'` yields platform-agnostic dev standards (commit convention,
release discipline, coverage floor, secret hygiene, scripts-over-prose) with no
ServiceBay ADRs or template details. Backing prose lives single-sourced in the
`new-service-standards` / `generic-project-standards` assists.

### The learning-feedback loop (`propose_learning`, #2326)

`propose_learning` (`propose` scope) is the knowledge **Rückkanal** — a
central knowledge base that connected agents *improve*, admin-gated. An agent
submits a proposed assist — `title`, `whenToUse`, `kind` (guide | recipe | adr |
template | checklist | footgun | snippet), `tags`, `body`, plus an optional
**self-assessment** (pros / cons / redundancy) — and it is queued as a **pending**
proposal with a namespaced id `local/<slug>` (derived from the title). Proposals
are **additive-only**: they land in the `local/` namespace and **never shadow a
built-in** assist (propose a companion; updating a built-in is a repo PR). A
same-id local proposal surfaces its `siblingProposalIds` so the admin sees
duplicates.

`propose` is its own **off-ladder** scope (see `SCOPE_AUDIT.md`): a
`propose`-only token can submit knowledge and nothing else, and a read/mutate
token can't submit at all. The submitter **cannot self-approve**.

**Admin review + landing.** An admin reviews the queue with the read-scoped
tools `list_learning_proposals` (defaults to pending) and `get_learning_proposal`
(one proposal by id, with body + self-assessment), then approves or rejects from
the dashboard. On approval the proposal lands to `DATA_DIR/local-assists/`
**behind a hard secret scan** — a proposal that trips a known secret signature is
**blocked and never written**, not merely flagged. Once landed it is served
alongside built-ins by `list_assists` / `get_assist` with no release needed.

**Promotion backlog.** `list_assist_drift` (read scope) reports landed
local-assists that don't yet have a matching `assists/<slug>.md` in the repo —
the promotion backlog. Each entry carries a `promotionHint`; making a runtime
assist permanent (shipped in the image) is a later manual repo PR that adds the
file.

### Native distribution: assists as MCP resources + prompts (#2326 s6)

The assist catalog is ALSO exposed over MCP's **native** primitives, so a client
can discover + load knowledge without knowing our tool names (`list_assists` /
`get_assist` stay unchanged — this is purely **additive**):

- **Resources.** Every assist — built-in and landed local — is an MCP
  **Resource** under an `assist://<id>` URI (`text/markdown`), served via a
  ResourceTemplate whose list callback enumerates the catalog **live** (the same
  `listAssists` loader the tools use), so newly-landed local-assists appear
  without a restart. Each resource's `source` (Built-in/Local) and `kind` ride
  in the description + `_meta`. Read a resource to get the full assist markdown.
- **Prompts.** The curated **actionable** subset (kinds `guide` / `recipe` /
  `checklist` / `adr` — e.g. `servicebay-overview`, `create-service`,
  `new-service-architecture`) is exposed as MCP **Prompts** (`assist_<id>`), each
  returning the assist content as a prompt message so a client can invoke an
  operational how-to by name. `footgun` / `snippet` / `template` kinds stay
  resources-only (reference/gotcha material, not a runnable walkthrough).

Registering a resource/prompt makes the SDK advertise the `resources` /
`prompts` capabilities automatically. Reading assists is read-tier knowledge —
assists carry no secrets by contract (the secret-scan gate) and are already
readable via the read-scoped tools — so the native surface introduces no new
privilege. The mapping lives in `packages/backend/src/lib/mcp/assistCatalog.ts`.

## Tool visibility is scoped to your token (#2325)

`tools/list` returns **only the tools your token could actually call**. A tool
is advertised iff its required scope (`TOOL_SCOPES` in
`packages/backend/src/lib/mcp/server.ts`) is within your token's granted scopes,
using the same implication ladder the gate uses (`destroy` implies `reboot` +
`exec`; see `SCOPE_AUDIT.md`). So:

- a **read-only** token sees only the `read`-tier tools — no
  mutate/destroy/exec/lifecycle tools ever appear in its list;
- a **lifecycle** token additionally sees `manage_service`, `run_backup`, … ;
- a **cookie / session (operator)** client sees the full surface (cookie auth
  carries all scopes by design).

This is **visibility only** — it changes what's *advertised*, never what's
*allowed*. Enforcement is unchanged: `safeHandler` remains the single authority,
so a tool that a token can't see still exists and, if called by id, is refused
at the scope gate (`Token scope '…' required for …`) — **not** with a
"tool not found". Advertising less means fewer tokens in-context and fewer
wrong picks for small models, plus least-privilege (don't advertise what you
can't invoke).

**Deterministic ordering.** The returned list is sorted by tool name and is
stable per token across requests. Tool definitions render at prompt position 0
(`tools → system → messages`), so a stable, deterministic order is what lets a
client prompt-cache them: any add/remove/reorder invalidates that cache, and a
scope-filtered list is cache-safe precisely because it's fixed per token and
isn't rebuilt mid-session.

### `defer_loading` kernel set

A small **always-on core** is designated in `MCP_KERNEL_TOOLS`
(`server.ts`): `list_services`, `list_containers`, `diagnose`, `get_logs`,
`get_system_info` — all `read`-tier, so every token (down to read-only) sees the
whole kernel. A client using the Anthropic **Tool Search Tool**
(`tool_search_tool_regex_20251119` / `tool_search_tool_bm25_20251119`) can keep
this kernel eagerly loaded and mark the rest `defer_loading: true`, lazy-loading
a tool's schema only when it's needed. Because deferred schemas are **appended,
not swapped**, the prompt cache stays intact. Enabling Tool Search is a
**client-side decision** — ServiceBay doesn't force it; it just designates the
kernel and keeps descriptions terse so the remaining surface is cheap to search
and lazy-load.

### Channel switching

`get_channel` and `set_channel` let an LLM (or the operator) flip the
running box between release channels without SSH:

```text
get_channel() → { channel: 'latest' | 'dev' | 'test', since? }
  Read scope. Returns the current channel and (if available) when it
  was last set.

set_channel(channel) → { ok: true, channel, note }
  Lifecycle scope. Pulls the new image and restarts ServiceBay in the
  background. Returns before the restart completes (~1–2 min), so the
  MCP connection will drop — reconnect and poll get_channel to confirm.
```

Typical autonomous-verify workflow:

1. `set_channel('dev')` — flip to the latest non-release main commit.
2. Wait for reconnect, then `get_channel()` to confirm.
3. Run the usual verify tools (`get_health_checks`, `list_services`, …).
4. `set_channel('latest')` — return to the stable release channel.

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
   (or `POST /api/system/api-tokens` — the older `/api/system/mcp-tokens`
   path still works as an alias). The secret is shown **once**, in the form
   `sb_<id>_<secret>`. The same token authenticates both MCP and opt-in REST
   API routes.
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
