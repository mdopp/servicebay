---
title: Reaching ServiceBay's API/MCP from a container running on the box itself
whenToUse: You are an agent or script running in a container ON the ServiceBay host and cannot reach its API or /mcp endpoint — TLS handshakes are rejected, you get a bare 404, or a 301 to the public URL. Read this before concluding you need an /etc/hosts entry, --add-host, or a restored LAN route.
kind: footgun
tags: [mcp, api, networking, adr-0007, container, host-containers-internal, reverse-proxy, agent, troubleshooting, token, auth]
---

# The MCP endpoint is on the app port, not behind the proxy

**Answer first:**

```
http://host.containers.internal:5888/mcp
```

with the usual `Authorization: Bearer sb_<id>_<secret>`. No DNS, no TLS, no
`Host` header, no `/etc/hosts` entry, no container rebuild. If `PORT` is set on
the ServiceBay service, use that instead of `5888`.

## Why the obvious route fails

Ports **80/443 are nginx-proxy-manager**. A reverse proxy has to route by
**vhost name**, and ServiceBay's own admin host is one of six permanently
LAN-only NPM hosts whose access list ends in `deny all`. So from inside the box
the proxy is not a path to `/mcp` at all — no header or address gets you
through it, because the denial is deliberate and happens before the app sees
the request.

ServiceBay's backend listens on its **app port** as well. That port has no
vhost logic, so none of the proxy's prerequisites apply to it.

## Why this eats a whole session

Each failed attempt looks like a *different*, solvable problem:

| Attempt | Result | What it looks like |
|---|---|---|
| `https://host.containers.internal/mcp` | TLS handshake rejected | a certificate problem |
| `https://<host-ip>/mcp` | TLS handshake rejected | a certificate problem |
| `http://<host-ip>/mcp` | `404` | the endpoint moved |
| `http://<host-ip>/mcp` + `Host: admin.<domain>` | `301` to the public URL | "just map the name to a reachable address" |
| **`http://host.containers.internal:5888/mcp`** | **`200`** | — |

The fourth row is the trap. It hands you a specific, plausible instruction —
add `169.254.1.2 admin.<domain>` to `/etc/hosts`, or `--add-host` at container
creation — and that **actually works**. It is still wrong: it re-creates the
dependency on the proxy and on the container's LAN route, needs root inside a
container that usually has no `sudo`, and disappears the next time the
container is rebuilt. You end up asking a human to run a privileged command on
the host to restore something you never needed.

**Diagnostic that settles it in one call** — if this returns 200, stop
theorising about DNS and certificates:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  http://host.containers.internal:5888/mcp \
  -H "Authorization: Bearer $SB_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
```

## Two things that look like a working token and aren't

- **A `401` from `/api/health` means the box is up** — that route is auth-gated,
  so a `401` is proof the app answered. Don't read it as "box down" and go
  hunting for a restart.
- **`$SERVICEBAY_MCP_TOKEN` is not the MCP token.** It's a different value (no
  `sb_` prefix) and gets a **401** on every `/mcp` call. The credential that
  actually works is the `Authorization: Bearer sb_<id>_<secret>` value already
  configured for the `atHome-Servicebay` MCP entry in `~/.claude.json` — read
  it from there, don't re-derive or substitute it. A script that runs
  `export SB_TOKEN="$SERVICEBAY_MCP_TOKEN"` overrides the correct fallback and
  then silently fails every box call for the rest of the session; leave
  `SB_TOKEN` unset so tooling (e.g. `scripts/autoloop-box.ts`) falls back to
  `~/.claude.json` on its own.
- **Self-check before doing anything else**, once you're pointed at the right
  URL and token: a `tools/call get_channel` (or `npm run autoloop:box --
  channel`, which additionally needs `SB_BOX_URL=http://host.containers.internal:5888`
  set explicitly — without it `channel` reports `{"channel":null}` even with a
  correct token) must return `{"channel": "latest"|"dev"}`. A `null` channel or
  a `-32001` error means the token or URL is wrong, not that the box is
  unreachable — go back to the diagnostic above rather than concluding the box
  is down.

## Things worth knowing before you use it

- **Plain HTTP is not a downgrade here.** The traffic is host-local
  link-local and never reaches a network interface.
- **Authentication is unchanged.** You are bypassing the proxy's *routing*,
  never its *authorization* — the app port enforces the same Bearer/session
  check.
- **Responses are SSE-framed.** Lines arrive as `data: {...}`; strip the prefix
  before parsing. Call `initialize` first, then `tools/list` / `tools/call`.
  There is no session header to carry between calls.
- **`container_exec` / `exec_command` are capped at ~30 s** by the agent. For
  anything longer, start it detached inside the target container
  (`nohup … &`) and poll a log file.
- **Output is secret-redacted.** A line matching `apikey:`/`password:` comes
  back `<redacted>` even through `container_exec`. Never rewrite a config file
  wholesale from what you read — edit it in place, or you will destroy the
  credential you couldn't see.
- **`exec_command` carries an advisory tripwire** matching `rm -rf /etc`-shaped
  strings *anywhere* in the command, including inside heredoc **comment** text.
  Reword the comment; do not encode around the guard.
- **Prefer the read tools** (`diagnose`, `get_logs`, `list_containers`,
  `get_system_info`, `read_file`, `list_dir`) — `exec_command` and
  `container_exec` trip a destructive-op alert and an auto-snapshot.

## Where the rule lives

- `assists/adr-0007-container-network-isolation-and-carveouts.md` — amendment
  2026-08-17 states the rule and why the proxy is the wrong layer.
- `docs/MCP.md` — "Client running on the box (agent in a container)".
- Settings → MCP in the UI shows the on-box URL next to the browser one.
