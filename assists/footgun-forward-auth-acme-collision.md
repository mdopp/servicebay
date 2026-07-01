---
title: Forward-auth sentinel breaks NEW public LE subdomains (duplicate acme-challenge)
whenToUse: You created a new public subdomain with __authelia_forward_auth__ and it returns an SSL error / 000, or NPM shows nginx_online=false with a "duplicate location" error.
kind: footgun
tags: [authelia, forward-auth, nginx, npm, acme, letsencrypt, subdomain, sso, proxy]
---

# Forward-auth sentinel collides with NPM's acme-challenge on public LE hosts

## Symptom
A brand-new **public** subdomain gated with `__authelia_forward_auth__` gets its
NPM proxy host + LE cert created, but the site answers with an SSL connect error
(curl code 000). No error appears in the install/job log.

## Cause
NPM writes the host conf, then `nginx -t` fails and NPM **reverts** it:
```
nginx: [emerg] duplicate location "/.well-known/acme-challenge/" in <id>.conf
```
The sentinel-expanded forward-auth snippet includes a
`location /.well-known/acme-challenge/ { auth_request off; ... }` bypass. On a
public/internal (Let's Encrypt) host, **NPM already injects its own**
acme-challenge location for the cert → two identical locations → `[emerg]`. Older
forward-auth hosts predate the bypass in the snippet, so only *newly created*
public forward-auth subdomains collide.

## Diagnose
Read NPM's DB (open `?mode=ro`, **not** `immutable=1` — that ignores the WAL):
```
proxy_host.meta.nginx_online = false
proxy_host.meta.nginx_err    = 'nginx: [emerg] duplicate location "/.well-known/acme-challenge/" ...'
```

## Fix / workaround
Don't use the sentinel for a public forward-auth host. Set `advanced_config` to
the forward-auth block **literally, minus** the `location /.well-known/acme-challenge/`
block (NPM supplies that itself for LE hosts). Keep the `auth_request /authelia`
line and the `proxy_set_header Remote-*` lines so the app still gets its identity
headers. Do NOT include the `servicebay-proxy-error` / `forward-auth-denied`
blocks — the proxy-hosts route appends those (keyed on `auth_request /authelia`),
so a literal still gets them; including your own would duplicate them.

Proper fix lives in `packages/backend/src/lib/stackInstall/forwardAuth.ts`: make
the acme bypass conditional on non-LE exposure (tracked as a bug).
