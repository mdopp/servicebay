# ADR 0009 — Tokens & trust between services

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** @mdopp
- **Supersedes / relates to:** #322, #565, #780, #1204, #1419, #1552, #1559, #1639, #1667, #1705, #1713
- **Related ADRs:** [0001](0001-authentication-via-authelia-sso-or-lldap.md) (the operator→service auth decision; §2 here is the credential/trust elaboration), [0002](0002-tiered-backup-nas-config-vs-bulk-drive.md), [0006](0006-authelia-apex-deny-vs-wildcard.md)

> Format: Status / Context / Decision / Consequences, in the
> spirit of [`UX_DECISIONS.md`](../UX_DECISIONS.md) — record the choices that are
> **not derivable from the code alone**, with the incident that forged them.

## Context

ServiceBay is a single-node home server where several principals must authenticate
to each other across process and network boundaries:

- the **operator** (browser / phone) → the proxied web apps and ServiceBay itself;
- **external agents** — the Claude Code MCP client, OSCAR/Hermes — → ServiceBay's MCP + REST API;
- the **`sb` CLI** and **scripts** → the REST API;
- **service → service** (e.g. Hermes → ServiceBay MCP, Radicale → LLDAP, every OIDC app → Authelia);
- the **ServiceBay backend** → the **host** (mount, rsync, write files).

The box is reinstalled often (FCoS wipe-and-reinstall), credentials rotate on every
install, and the network has a hard **LAN vs. public** split (Authelia + a reverse
proxy in front of everything). Multiple incidents this cycle showed the trust model
was implicit and inconsistent — secrets that didn't survive a reinstall (#1667/#1559),
a reconnect bridge that self-destructed (#1705), a stale machine token after reinstall
(#1639). This ADR makes the model explicit.

## Decision

Trust is **layered**, and each principal gets the **lowest-privilege credential that
fits its job**. Six layers:

### 1. Root of trust — per-box identity secrets
`secret.key` (32-byte config-encryption key, #780) and `.auth-secret.env`
(`AUTH_SECRET`, the session-JWT HS256 key, #565) **are the box's identity**. Every
`enc:v1:…` value in `config.json` (FritzBox gateway password, every OIDC client
secret) is bound to `secret.key`; every UI session cookie is signed with `AUTH_SECRET`.

- **Decision:** these are **per-box identity**, the same trust class as the nginx certs
  and the Z-Wave network keys — they **MUST survive a wipe-config reinstall**. They are
  *not* regenerated when a preserved `enc:`-bearing config is present.
- **Why:** regenerating them orphans every encrypted credential → the box returns
  un-onboarded with all SSO broken. This was the root cause of the #1559 family
  (fixed by #1667).
- **Where:** `packages/backend/src/lib/secrets.ts`, the FCoS config-reset region, and
  `servicebay-secret-key-init` / `servicebay-auth-secret-init` boot units.

### 2. Operator → web apps — Authelia + LLDAP (SSO)
**LLDAP** is the single identity source; **Authelia** is the authenticator. Two
integration modes, deliberately distinct:

- **Forward-auth** (files, chat, zwave, sync, dns, ldap, nginx, ollama, …): the reverse
  proxy (NPM) calls Authelia's `/api/authz/auth-request`; on success it injects
  `Remote-User` / `Remote-Groups` / `Remote-Email` and the upstream **trusts the proxy**.
  Authelia's endpoint is **https-only** (an `http` `X-Original-URL` is rejected 400).
  Access policy: the **apex is default-deny**, only `*.<domain>` is `one_factor`
  (`group:family`/`admins`), and admin tools (nginx/dns/ldap/admin) are `two_factor`.
- **OIDC** (immich, vaultwarden, audiobookshelf, Home Assistant, servicebay): each app
  holds a per-service `client_id` + `client_secret` registered in Authelia.

- **Decision / constraint:** OIDC client secrets and the app's stored copy **must be
  reconciled on reinstall** — a drift between the app's secret and Authelia's registered
  secret is an `invalid_client` failure (observed live on immich: #1559). Forward-auth
  services trust the `Remote-*` headers **only** on the LAN-gated proxy path (see §5).

### 3. Machines/agents → API — scoped named tokens
Wire format `sb_<id>_<secret>` (Bearer). Stored in `api-tokens.json` as
**`sha256(secret)` only** (never plaintext), chmod-restricted; `prefix` (first 4 chars)
is for UI display. **One token authenticates both the MCP server and the REST API.**

- **Scope ladder** (`ApiScope`, `packages/backend/src/lib/auth/apiScope.ts`):
  `read` < `lifecycle` < `mutate` < `reboot` < `destroy` < `exec` (`destroy` implies
  `reboot` and `exec`). The authoritative per-capability / per-route mapping —
  *which scope gates which endpoint* — lives in [`SCOPE_AUDIT.md`](../SCOPE_AUDIT.md).
- **Consumers:** the `sb` CLI, OSCAR/Hermes (`oscar-hermes`, `hermes-mcp`), scripts.
- **Decision:** named scoped tokens are the **preferred** machine credential — least
  privilege, individually revocable, hash-at-rest. A consumer is granted only the scopes
  it needs (Hermes ≈ `read,mutate,lifecycle`; never `destroy`/`exec` unless required).
- **Caveat (#1639):** a service's *stored* token goes stale on reinstall (the id no
  longer exists) → `401`. The install flow is responsible for re-minting and re-wiring
  it (the OSCAR auto-mint, #921); a stale stored token is a re-mint, not a re-activate.

### 4. Agent bootstrap → MCP — the low-trust reconnect bridge
The **bootstrap token** (#322) exists so an MCP client (the Claude agent) can connect
**right after an install/reinstall**, before any named token has been minted. It is
deliberately weak:

- **LAN-only + short-TTL (30 min) + `read` scope**, stored as `sha256` in
  `config.auth.bootstrapToken.hash`. It is the **only** valid bearer that does *not*
  match the `sb_<id>_<secret>` shape.
- **Decision (corrected by #1705):** minting the first named token **deactivates**
  (expires) the bootstrap token but **does NOT delete** it — keep the hash, set
  `expiresAt` to the past. An expired token is inert (`verifyBootstrapToken` rejects on
  expiry), so it is not live attack surface, **yet it stays re-activatable** so re-granting
  an MCP client access does not require rotating its token (#1419/#1552). *Original #322
  deleted it outright, which made re-activation impossible — that was the bug.*
- **Where:** `packages/backend/src/lib/mcp/bootstrapToken.ts`; banner under
  **Settings → Security** (not Integrations).

### 5. The trust boundary — the LAN gate
Low-privilege access (the bootstrap token; some actions) is gated to the home LAN.

- `isLanIp()` accepts **loopback + RFC1918 + `fc00::/7`** and **rejects public outright**.
- Behind NPM the socket peer is always loopback, so `clientIpForLanGate()` trusts the
  proxy's `X-Forwarded-For` **only when the socket is loopback**; a direct (non-loopback)
  connection uses the socket address, because then the headers are attacker-controllable
  (#1204). This is why a public client can never spoof a LAN IP.
- **Where:** `packages/backend/src/lib/mcp/bootstrapToken.ts` (`isLanIp`,
  `clientIpForLanGate`), `packages/backend/src/lib/portal/lanGate.ts`.

### 6. Backend → host — allow-listed, opt-in-privileged exec
The backend reaches the host through the agent's **`safe_exec`**: it runs an
**allow-listed binary set** as the `core` user, with **opt-in `sudo -n` per call** for
ops that need root (disk-import `mount -o ro` / `mkdir` / `umount` / `chown` / `rsync`,
#1713; `write_file`).

- **Decision:** not arbitrary shell. The trust is `(allow-list) × (opt-in privilege) ×
  (per-op argument guards)` — read-only source mount, mountpoint confined to
  `/run/servicebay/disk-import/…`, `chown` group-only to the share gid, path-traversal
  guards on every target. `sudo -n` relies on FCoS's default `%wheel NOPASSWD` (the
  `core` user is in `wheel`); tightening that to command-scoped sudoers is owed hardening.
- **Where:** `packages/backend/src/lib/agent/v4/agent.py` (`SAFE_EXEC_ALLOWLIST`,
  `safe_exec`), `packages/backend/src/lib/diskImport/{mounter,plan,hostExec}.ts`.

### Auth resolution order (`packages/backend/src/server.ts`)
For an incoming request the backend resolves the principal in this order:

1. **Bearer named token** (`sb_<id>_<secret>`) → its scopes;
2. **Bearer bootstrap token** (LAN-only, `read`) — only if (1) didn't match;
3. **Cookie session** → **full scopes** (legacy, back-compat for pre-token clients).

Token paths are preferred; the full-access cookie is retained only so clients that
predate tokens keep working — fresh installs use named tokens.

## Consequences

- **Reinstall is a first-class trust event.** `secret.key`/`.auth-secret.env` must be
  preserved (#1667); OIDC client secrets must be reconciled per service (#1559); machine
  tokens must be re-minted and re-wired (#1639). "Wipe-config" must not equal "wipe identity."
- **Least privilege is the default.** Every machine principal gets a scoped named token;
  the bootstrap token is read-only/LAN-only/TTL'd; the host bridge is allow-listed and
  privilege is opt-in per call.
- **Public is default-deny.** The apex denies; low-privilege credentials are LAN-gated and
  cannot be reached from the internet (the `X-Forwarded-For`-only-when-loopback rule).
- **Re-grant ≠ rotate.** Re-opening access (the bootstrap token) keeps the same value so
  configured clients keep working (#1705); a genuinely stale machine token (#1639) is a
  re-mint, not a re-activate. These are different operations and surfaced differently.
- **One credential, two doors.** A named token authenticates both the MCP server and the
  REST API — there is no separate "MCP token" vs "API token" type, only scopes.

## Open items (tracked elsewhere)
- Per-service OIDC-secret reconciliation on reinstall — **#1559** (needs design decision).
- Command-scoped sudoers instead of `%wheel NOPASSWD` for the host bridge — owed hardening on **#1713**.
- Machine-token auto-rewire on reinstall (OSCAR/Hermes) — **#1639** (oscar-side).
