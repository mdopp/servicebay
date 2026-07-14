---
title: Mint a delegated-admin assertion from a server-side consumer (forward the Authelia session cookie)
whenToUse: A trusted server-side client (e.g. a BFF acting for a signed-in admin) needs to call POST /api/auth/*-from-authelia-session and gets 403 "cross-site request" on loopback or 401 through the public host. Use this for the correct server-to-server ingress.
kind: recipe
tags: [auth, authelia, delegated-admin, sso, mint, bff, server-to-server, npm, forward-auth, csrf, cookie, internal-token]
---

# Calling the `*-from-authelia-session` mint server-to-server

ServiceBay can mint a **short-lived, action-bound delegated-admin assertion**
(`POST /api/auth/delegated-admin-from-authelia-session`; sibling
`POST /api/auth/token-from-authelia-session`) so a trusted server-side consumer
can act **as the acting admin's already-verified identity** without holding any
standing ServiceBay credential. The assertion is returned in the
`x-sb-delegated-admin` header, lives ≤ 2 minutes, and its nonce is single-use.

The mint is designed for a caller that carries a **browser Authelia session** —
NOT a Bearer token and NOT an anonymous loopback call. Getting the ingress wrong
is the #1 stumbling block, because the two "obvious" shapes both fail:

## The trap: both naive shapes fail (and why)

| Shape | Result | Why |
|---|---|---|
| Loopback `http://<lan>:5888/api/auth/…-from-authelia-session` (bypasses NPM) | **403 `Forbidden: cross-site request`** | proxy.ts's CSRF guard. The exemption only fires when NPM has injected `X-SB-Internal-Token`; loopback has no token. |
| Public apex `https://<domain>/…` with **no cookie** | **401** | NPM runs Authelia forward-auth on the portal route and challenges a cookie-less call. |

They're mutually exclusive on their own: the only NPM ingress that injects the
internal token (the portal route) **also** enforces Authelia; the CSRF-exempt
loopback route has no token. A server consumer that has neither an Authelia
session nor the NPM-injected token cannot mint.

Do **NOT** "fix" this by provisioning the consumer with `X-SB-Internal-Token`
(an `AUTH_SECRET`-derived value): that puts a **standing root-of-trust
credential in the consumer pod**, which the delegation design exists to avoid.
The token is NPM's to inject from its position of trust — never the client's to hold.

## The working pattern: forward the admin's Authelia session cookie

The consumer is a **BFF acting for a signed-in admin**, so it already receives
that admin's Authelia session cookie (Authelia's `session.cookies[].domain` is
the box's public domain `<domain>`, so the `authelia_session` cookie is sent to
every `*.<domain>` host — including the BFF's own subdomain). Forward it:

```
POST https://www.<domain>/api/auth/delegated-admin-from-authelia-session
Cookie: authelia_session=<the acting admin's session cookie, forwarded verbatim>
Content-Type: application/json
{ "action": "<bound action>", "target": "<bound target>" }
```

Then NPM's forward-auth validates the cookie with Authelia → injects
`Remote-User` / `Remote-Groups` → NPM also injects `X-SB-Internal-Token` on this
route → the handler's own checks run and it mints. Read `x-sb-delegated-admin`
from the response and replay it (single-use, ≤ 2 min) on the delegated call.

### Two hard rules for the URL
- **Use `www.<domain>` (or another `*.<domain>` host), never the bare apex.**
  The apex is Authelia **default-deny**; only `*.<domain>` is `one_factor`
  (see the "subdomain needs public domain" / apex-deny notes). An apex call
  401s even *with* a valid cookie.
- **Go through NPM (the public host), not loopback.** The token injection and
  the Authelia validation both live on the NPM route; loopback has neither.

## What the handler still enforces (don't try to bypass these)
- **No Bearer.** A request carrying `Authorization: Bearer …` is refused (403) —
  a token client on a direct `:5888` call could forge its own `Remote-User` /
  `Remote-Groups` and self-elevate, so Bearer identity is never accepted here.
- **`Remote-User` required** (else 401) and **`Remote-Groups` must contain
  `admins`** (else 403). Identity may come *only* from Authelia's proxy headers.
- The admin is **re-derived server-side** (LLDAP) as a confused-deputy check; the
  assertion is bound to `{user, action, target}`, short-TTL, single-use nonce.

## Verifying end-to-end
The mint is not curl-scriptable without a real admin session (that's the whole
point). Prove it from the consumer with a live signed-in admin: forward the
cookie as above and assert a `200` + a populated `x-sb-delegated-admin` header.
A `401` means no/expired cookie or an apex URL; a `403` means a Bearer leaked in,
a non-admin session, or a loopback/no-token call.
