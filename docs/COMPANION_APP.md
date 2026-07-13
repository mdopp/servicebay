# Companion-app native API (`/napi/*`) & deep-links

The companion (phone) app talks to ServiceBay over a **token-only, proxy-bypassed**
surface under `/napi/*`, and opens the web UI via a small set of **deep-link
URLs** when a widget is tapped. This is epic #2242 (Native token-only API +
Device-Token-Pairing).

Design rule for the whole `/napi/*` surface: each route is a **lean twin** of an
existing `/api/*` route, reusing the same backend primitive (no second store, no
duplicated logic). The `/api/*` route stays the rich, cookie-authenticated
browser surface; the `/napi/*` twin is the token-only path that never touches
Authelia. The scope required is declared in the `withApiHandler` /
`withApiHandlerParams` **options object** (the only place the gate reads it — a
scope on an inner `requireSession` 401s a valid Bearer, #2249), so a device
token that lacks the scope is rejected before the handler runs.

## Pairing → token (#2251)

1. A signed-in admin opens **Settings → Access → Connect Device**, which POSTs
   `POST /napi/pair` (browser Authelia session only — a Bearer is refused, #2249)
   and gets back a short-lived 6-char pairing code + a QR-encodable redeem URL.
2. The phone redeems it at the public `POST /napi/pair/redeem` and receives a
   **read-scoped** `sb_` Bearer token (30-day expiry).

> **Scope note (open sub-decision, #2253).** The redeem path mints a **`read`
> token only** — by hard invariant (`REDEEM_SCOPES = ['read']`, "never widen").
> The mutating `/napi/*` endpoints below therefore require a token minted through
> the admin **API Tokens** UI (`Settings → Access → API Tokens`) with the
> `lifecycle` / `mutate` scope, not the default paired read token. Whether the
> *pairing* flow should offer a scope choice (mint a combined
> `read`+`lifecycle`+`mutate` token) is a product decision tracked on the epic;
> the endpoints ship scope-gated regardless of how the device acquires the token.

## Read endpoints (#2252) — `read` scope

| Method | Path | Twin of |
|---|---|---|
| GET | `/napi/home` | dashboard summary |
| GET | `/napi/approvals` | `/api/approvals` (pending only) |
| GET | `/napi/services` | `/api/services` (lean projection) |
| GET | `/napi/upgrades` | template + image update signals |

## Operate endpoints (#2253)

### `POST /napi/services/:name/operate` — `lifecycle` scope

Start / stop / restart a managed service. Reuses
`ServiceManager.{start,stop,restart}Service` (the same primitive the browser
`/api/services/[name]/action` route drives).

```
POST /napi/services/immich/operate
Authorization: Bearer sb_…            # must hold `lifecycle` (or higher)
Content-Type: application/json

{ "action": "start" | "stop" | "restart" }
→ 200 { "ok": true, "name": "immich", "action": "start" }
```

- A `read`-only token → **401** (wrong scope). No-token → **401**.
- Invalid service name → **400**. A lifecycle failure → **500** (never a
  false-green `ok`).
- `update` is intentionally NOT offered here — it is a heavier upgrade operation,
  outside the reversible `lifecycle` tier. Surfaced in the app as
  "sensitive — confirmation required."
- Optional `?node=<name>` targets a non-`Local` node.

### `POST /napi/approvals/:id/approve` and `POST /napi/approvals/:id/deny` — `mutate` scope

Deliver the operator's verdict on a pending approval from the app. Reuse the same
`approveApproval` / `rejectApproval` store as the browser routes.

```
POST /napi/approvals/<id>/approve       # or /deny
Authorization: Bearer sb_…              # must hold `mutate`
→ 200 { "ok": true, … }
```

- A `read`-only token → **401**. No-token → **401**.
- **Self-approve guard preserved** (memory
  `reference_mcp_destroy_tier_approval_flow`): the token that *proposed* a
  destroy-tier action cannot approve or deny it — a **different** operator's
  verdict is required → **403**. Any destructive work an approval carries was
  scope-checked when it was *proposed*; delivering the verdict is a mutate-tier
  action, so these routes are `mutate`, not `destroy`.

## Deep-links — open the web UI from a widget tap

Widget taps open the **browser** UI (a normal Authelia-session cookie flow, NOT
a Bearer token — these are Next.js pages behind the proxy, not `/napi/*` routes).
Canonical URLs (relative to the box's public admin origin, `<sb_url>`):

| Intent | URL | Route |
|---|---|---|
| Approvals | `<sb_url>/settings/access#approvals` | `(dashboard)/settings/access`, section `id="approvals"` |
| Services | `<sb_url>/services` | `(dashboard)/services` |
| Status | `<sb_url>/status` | `(dashboard)/status` |

> The approvals link resolves to `/settings/access#approvals` (the Approvals
> section lives on the **Access** settings page under an `#approvals` anchor) —
> there is no standalone `/settings/approvals` route. When opened in the phone
> browser with an active Authelia session the page renders directly; without a
> session Authelia intercepts and returns the user to the target after login.
