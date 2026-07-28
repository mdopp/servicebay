---
title: A hostNetwork pod's admin port is LAN-reachable — SSO on the subdomain does not gate it
whenToUse: You are adding or reviewing a port on a hostNetwork template, or you want to know whether an app's admin UI can be reached directly on the LAN without passing Authelia.
kind: footgun
tags: [security, hostnetwork, lan, authelia, forward-auth, loopback, nftables, template, ports]
---

# `hostNetwork: true` + a wildcard bind = an SSO bypass

## Symptom

An admin UI or control API is proxied at `https://<sub>.<domain>` with
`advanced_config: "__authelia_forward_auth__"`, and the gate works — through
nginx. But `curl http://<box-lan-ip>:<port>/` from any other LAN device answers
too, with no login at all.

The forward-auth block only gates the **nginx path**. Nothing makes nginx the
only path.

## Why

A `hostNetwork: true` pod publishes no ports — its containers share the host's
network namespace, so whatever address the app binds is the address it binds on
the host. Most apps default to `0.0.0.0` (or "unset = all interfaces"), which
under `hostNetwork` means **every** interface, LAN included. ServiceBay's target
OS ships with no firewall enabled, so nothing downstream catches it either.

This has been the same bug three times on three templates: an identity store's
web UI, its raw LDAP port, and a smart-home stack's Z-Wave admin UI plus its raw
control websocket. The last one was the sharpest — an unauthenticated websocket
that could actuate every paired device, door locks included.

The two aggravating factors to look for:

- **Undeclared ports.** A port missing from `servicebay.ports` is invisible to
  the network map and to review. Declare every listening TCP port, including
  ones only a sibling container talks to.
- **"It has a subdomain, so it's gated."** A subdomain gates the proxied route,
  never the port.

## Fix — in order of preference

**1. Bind the app to the loopback (best).** No privileged host state needed.
Find the app's bind-address knob and pin it to `127.0.0.1`; it is always
app-specific, never a pod-spec field:

| shape | example |
|---|---|
| env var | `LLDAP_HTTP_HOST`, `HOST`, `STGUIADDRESS: "127.0.0.1:<port>"` |
| CLI arg via `args:` | `--listen-address 127.0.0.1` |
| on-disk config the post-deploy seeds | a `serverHost` key in a settings JSON |

If the port is proxied, add `loopbackOnly: true` to its `type: "subdomain"`
variable. `buildProxyHosts` then emits `forwardHost: 127.0.0.1`, and the core
reconcile re-points an **existing** proxy host off the now-closed LAN address on
the next deploy — PUTting only the forward target, so exposure, forward-auth and
the bound cert survive. No manual proxy edit.

Two traps when you use `args:` — it **replaces** the image's `CMD` (the
`ENTRYPOINT` stays), so repeat the image's own default arguments verbatim or the
app starts misconfigured; and check the flag only binds the API server, not the
protocol stack (a Matter/Thread-style daemon has a separate interface flag for
its own traffic).

**2. `blockLanAccess: true` on the port variable — only when a loopback bind is
not available.** Some ports must answer on a host address because *isolated*
(non-hostNetwork) pods reach them through `host.containers.internal`, which
rootless podman/pasta maps to the host's LAN address rather than loopback — a
loopback bind would break those consumers. ServiceBay then renders a host
nftables rule dropping connections that arrive on a physical interface while
accepting the ones that arrive on `lo` (where the pasta-proxied path lands).
This costs privileged host state, so reach for it second.

**3. Leave it LAN-facing, with the reason written down.** Legitimate when the
port *is* the service (DNS, SMB, a sync protocol, sshd, the reverse proxy's own
front door) or when the app authenticates the request itself (its own login, or
proxy-auth mode that 403s a request without the forward-auth header). Write what
authenticates it — "it has a login" is a claim someone must be able to check.

## Guard rail

The template-consistency suite fails when a `hostNetwork` template declares a
TCP port that is neither loopback-bound, nor firewalled, nor listed with a
written reason — and, for a port claimed loopback-bound, it re-reads the config
file that is supposed to bind it. Adding a port to such a template forces the
triage above. If the suite points you here, pick one of the three fixes rather
than widening the exemption list by reflex.

## Rollout on an existing install

Two halves, and the second is the one people miss:

- **Pod-level binds** (env var / `args:`) land structurally — `podman play kube`
  recreates the pod from the new manifest. Bump `servicebay.schema-version` and
  add a `(breaking)` CHANGELOG section saying "re-deploy required": a running
  container started from the old manifest does not re-bind on its own.
- **On-disk binds** do not. If the bind address lives in a settings file that
  the post-deploy seeds *only when missing*, every existing install keeps the
  old wildcard value forever and the "fix" reaches new installs only. Ship a
  migration that rewrites that value in place, and make the post-deploy
  converge it on every deploy so a restored backup cannot reintroduce it. Leave
  a deliberately-pinned non-wildcard address alone — warn instead of
  overriding.

## Verify

From a **different** LAN host (not the box — loopback works there by
construction), confirm the port is refused, then confirm the legitimate paths
still work: the proxied subdomain still serves through nginx with its SSO gate,
and any sibling container that consumed the port over `localhost` is still
connected. Check the consumer's own view — a config entry that reconnects, a
log line — not just that the port answers.
