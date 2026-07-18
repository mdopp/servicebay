# Drivable by an agent

[← back to FEATURES](../FEATURES.md)

ServiceBay's whole control plane is exposed as a
[Model Context Protocol](https://modelcontextprotocol.io) server at `/mcp`, so an
LLM (Claude Code, Claude Desktop, any MCP client) can administer the box in plain
English. The connection setup — cookie vs. named token, env-var refresh,
troubleshooting — lives in [docs/MCP.md](../MCP.md); this page is about *what the
surface is and why it's safe*.

## 62 scoped MCP tools

**What it does.** The tool registry in
`packages/backend/src/lib/mcp/server.ts` exposes **62 tools** covering the same
Digital-Twin / `ServiceManager` / `HealthStore` paths the UI uses — no parallel
mutation surface. Highlights beyond the read/lifecycle basics:

- **`install_template`** — full template deploy (manifest assembly, variable
  defaults, secret generation, proxy wiring), not just a raw YAML push.
- **`create_proxy_route`** — creates a complete NPM proxy host including exposure
  tier, Authelia forward-auth, and cert handling (alongside the lower-level
  `add_proxy_route` / `remove_proxy_route`).
- **`write_file` (jailed)** — a write confined to the data dir (`/mnt/data`),
  creating the parent dir and setting `core:core` ownership. It cannot escape the
  jail.
- Lifecycle + recovery: `deploy_service`, `delete_service` (soft-delete trash),
  `restore_trashed_service`, `factory_reset`, `set_boot_next_usb`, `reboot_node`,
  channel switch (`get_channel` / `set_channel`), backups, health checks, and the
  `diagnose` aggregator.

> The exact count is verified against the registry — do not copy a number from
> older prose (`README`/`ARCHITECTURE.md` historically said "37"; the current
> registry has 62). Run `/mcp` in Claude Code to see the live count on your build.

## Scoped, revocable tokens

**What it does.** Tools are mapped to `read | lifecycle | mutate | destroy`
scopes, checked server-side against bearer tokens
([ARCHITECTURE.md audit](../ARCHITECTURE.md), "MCP scope enforcement"). Tokens are
named, per-client, revocable, and hashed at rest. `get_config` redacts
`auth.passwordHash` / `oidc.clientSecret` / SMTP passwords; `update_config` is
write-allowlisted so auth/OIDC/SMTP credentials always need a human.

Additional safety rails (see the README "Safety rails" section):

- **`exec_command` denylist** — `rm -rf /`, `mkfs`, `dd of=/dev/sd*`, fork bombs.
- **Auto-snapshot before destructive ops** — labelled `pre-mutation:` backup.
- **Soft-delete trash** + **audit log** + **email on destructive ops**.

## Time-limited token request/approve flow

**What it does.** A caller with no token (or a narrow one) can *request* a
short-lived, least-privilege token rather than being handed one — an admin
approves it out-of-band.

**How it works.** `packages/backend/src/lib/auth/tokenRequests.ts` +
the MCP tools `request_token`, `poll_token_request`, `list_requests(type="token")` (#2139):

1. The caller names the scopes it wants, a human reason, and a requested TTL —
   and gets back a **pending request id, not a token**.
2. An admin approves from the dashboard, optionally **narrowing** the granted
   scopes (an approval can never *widen* beyond the request) and overriding the
   TTL (capped at 30 days).
3. Only on approval is a real `sb_` token minted; the caller fetches it **exactly
   once** via `poll_token_request`. The secret is held transiently in memory for
   that single poll — never persisted.

There's also a **bootstrap token** (created during onboarding, ~30-minute expiry,
LAN-only) that is re-activatable from Settings for the onboarding agent — see
[UX_DECISIONS.md → MCP bootstrap token](../UX_DECISIONS.md).

## Related

- [docs/MCP.md](../MCP.md) — connection setup and troubleshooting.
- [Extensibility](extensibility.md) — an MCP tool is a documented first-PR
  extension point ([CONTRIBUTING.md](../CONTRIBUTING.md)).
- [SSO](sso.md) / [Backup](backup.md) — the flows `install_template` and
  `run_backup` drive end-to-end.
