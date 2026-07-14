---
title: Give an unattended consumer a long-lived read-only ServiceBay token (never-expires)
whenToUse: A headless/background client (a script, a companion service, a cron job) needs to call ServiceBay's read-only API or MCP tools with no human to re-mint an expiring credential. Use this to mint a read-only + never-expiring token, place it in a deploy-time file, and recover from a 401.
kind: recipe
tags: [auth, api-token, machine-token, unattended, read-only, never-expires, mcp, headless, automation, 2299]
---

# The unattended-consumer token: read-only + never-expires

An interactive operator can re-mint a lapsed token from the UI. A **headless
consumer** can't — a token that expires silently breaks the integration at 3am
with nobody to notice. ServiceBay (#2299) makes the *safe* long-lived path
first-class: a token that **never expires**, hard-limited to the **read** scope.

The guard is deliberate and fail-closed: a never-expiring credential that could
`mutate`/`destroy`/`exec` is a standing liability, so the mint refuses it. If
your consumer genuinely needs to change state, don't reach for never-expires —
use a scoped, *expiring* token (and rotate it), or the delegated/one-shot flows.

## 1. Mint the token (once)

### From the UI
Settings → Access → **API Tokens** → *New token*:
1. Name it for the consumer (e.g. the service or host it runs on).
2. Leave **only `read`** selected. Any other scope disables the checkbox.
3. Tick **Never Expires**.
4. Create, and **copy the secret now** — it is shown exactly once.

The token appears in the list marked **Expires: Never**.

### From the API (for a scripted/first-boot provision)
`POST /api/system/api-tokens` with an admin session:

```
POST /api/system/api-tokens
Content-Type: application/json
{ "name": "<consumer-name>", "scopes": ["read"], "neverExpires": true }
```

Response returns the clear-text secret **once** as `secret`
(shape `sb_<id>_<secret>`). A `403` means you asked for a non-`read` scope
alongside `neverExpires` — drop the extra scopes or give the token an expiry.

## 2. Place it in a deploy-time token file

Write the secret to a file the consumer reads at startup — **not** an
environment literal baked into an image, and **never** committed to a repo:

```
# owned by the consumer's runtime user, 0600
printf '%s' "$SECRET" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
```

The consumer loads it at boot and sends it as a Bearer credential on every call:

```
Authorization: Bearer <contents of $TOKEN_FILE>
```

Because the token never expires, there is **no refresh loop** to build — read
the file once and reuse it.

## 3. Trivial 401-recovery: re-read the file

A never-expiring token doesn't lapse, but it *can* be **revoked** by the operator
(rotation, off-boarding a host). Handle that with the simplest possible recovery:
**on a 401/403, re-read the token file** (the operator may have dropped a fresh
secret in place) and retry once. No token-refresh protocol, no cached-in-memory
staleness:

```
1. call ServiceBay with the in-memory token
2. on 401/403 → re-read $TOKEN_FILE, replace the in-memory token, retry once
3. still 401/403 → the credential is gone; log + alert the operator to re-mint
```

This keeps an unattended consumer self-healing across a routine rotation without
any coordination beyond "the operator overwrote the file."

## Hygiene
- The secret is shown **once**. If it's lost, revoke the token and mint a new one.
- Never commit the secret. Never log its value. Keep the file `0600`.
- Read-only is the ceiling for a never-expiring token by design — if the
  consumer's job grows to need writes, that's a *different* credential (expiring +
  scoped), reviewed as such.
