# Single sign-on with no hand-wiring

[← back to FEATURES](../FEATURES.md)

Deploying an SSO-enabled service normally means creating an OIDC client, copying a
client secret into two places, and hoping the auth server can reach the callback.
ServiceBay does all of that from the template — and, critically, *keeps* it
working when the auth stack itself is redeployed.

## OIDC client self-registers on deploy

**What it does.** A template declares an `oidcClient` block on a variable in its
`variables.json` (client id, name, redirect URIs, scopes, and a
`clientSecretVar`). On install, ServiceBay collects those blocks across every
selected template and registers the clients with Authelia — no console, no config
edit.

**How it works.** When a service installs, the install runner emits a
`feature.installed` event; the Authelia capability handler (`handleInstalled` in
`packages/backend/src/lib/capabilities/authelia.ts`) POSTs the template's OIDC
client(s) to `/api/system/authelia/oidc-clients`. The endpoint is idempotent —
existing `client_id`s are skipped. When `clientSecretVar` is set, the same secret
is wired into the container env and into Authelia's `clients[]`, so there's no
secret to paste. The full end-to-end SSO contract (secret pinning + reachability
of `auth.<domain>` from inside the pod) is in
[TEMPLATE_AUTHORING.md → Wiring SSO end-to-end](../TEMPLATE_AUTHORING.md#wiring-sso-end-to-end).

## Redeploy auth without breaking everyone

**What it does.** Every non-auth stack registers its OIDC client *incrementally*
into Authelia's on-disk `configuration.yml`. When the `auth` stack re-renders that
file from its Mustache template, a naive write would contain only its own baked-in
client and drop everyone else's — a full SSO outage. ServiceBay merges the
existing clients back in before writing.

**How it works.** `mergeAutheliaOidcClients`
(`packages/backend/src/lib/capabilities/autheliaClientMerge.ts`, #1724):

- **Preserves every existing client verbatim**, including its `client_secret` (no
  rotation — that rotation was the #1559 drift this whole family is about).
- **The fresh render wins for shared `client_id`s**, so a template change to the
  baseline `servicebay` client (new redirect URI, policy) still lands.
- **Idempotent**, dedup by `client_id`, and **fail-soft** — a malformed on-disk
  file returns the fresh render unchanged rather than blocking the redeploy.

> This closes the specific foot-gun recorded in project memory: redeploying `basic`
> used to wipe other stacks' Authelia OIDC clients. The merge is the fix — recover
> a genuinely-lost client by redeploying its *owning* stack, never `auth`.

## Family portal with self-service access requests

**What it does.** Relatives on the family LAN don't need the admin to hand-create
their account. The portal shows a "Don't have an account?" form; a submission
becomes a pending access request; one admin click provisions the LLDAP user.

**How it works.**

- Request form: `packages/frontend/src/app/portal/RequestAccessButton.tsx` →
  POST `/api/system/access-requests` (public, LAN-gated).
- The request is persisted as `pending` and the admin is notified by email.
- Approve: `/api/system/access-requests/[id]/approve` creates the LLDAP user from
  the submitted profile; the user sets their password via LLDAP's flow.
- Optional guardrails (off by default): a **max-users** cap and a **LAN-only**
  gate on the portal — see
  [UX_DECISIONS.md → Portal access](../UX_DECISIONS.md).

## Related

- [TEMPLATE_AUTHORING.md](../TEMPLATE_AUTHORING.md) — the `oidcClient` variable
  contract and the three legs of a working SSO template.
- [Extensibility](extensibility.md) — how a new template opts into SSO with zero
  core changes.
