# ADR 0005 — DNS topology: the router hands out AdGuard as the LAN DNS (Pattern A); deterministic resolution beats public fallback

- **Status:** Accepted (reverses an earlier Pattern-B preference, 2026-06-02)
- **Date:** 2026-06-05
- **Deciders:** operator (mdopp)
- **Related:** [ADR 0001](0001-authentication-via-authelia-sso-or-lldap.md), [ADR 0006](0006-authelia-apex-deny-vs-wildcard.md)

## Context

This is a single-server homelab where **every app lives behind
`*.<domain>`** and those names must resolve to the box for SSO/OIDC callbacks
and the box→LLDAP fetch (`ldap.<domain>`) to work.

The DNS layout matters more than it looks:

- **Pattern A** — clients get **AdGuard** as their DHCP DNS server (the FritzBox
  hands out AdGuard's IP); AdGuard resolves `*.<domain>` → box via rewrites, and
  uses public DNS as its own upstream.
- **Pattern B** (previously preferred for "resilience") — the FritzBox is the
  client DNS, AdGuard only its upstream, with public fallback.

The **2026-06-02 reinstall proved Pattern B is a trap**: when the
FritzBox→AdGuard upstream link dropped, clients silently fell back to **public
DNS**, which does not resolve `*.<domain>` to the box. Every internal SSO/OIDC
callback and the box→LLDAP bind failed, and **all app logins broke**
(vault/immich/jellyfin/audiobookshelf/file-share, #1559) with no obvious cause.

## Decision

1. **Pattern A is the supported default.** The router's DHCP hands out AdGuard
   as the LAN DNS; AdGuard owns `*.<domain>` → box; public DNS is AdGuard's
   upstream only. **Deterministic `*.<domain>` → box resolution beats
   fallback-resilience** for this topology.
2. The `router_dns_not_pointing` probe's expectation (DHCP-DNS pointed at
   AdGuard/ServiceBay) is the **correct desired state**; a warn there is a real
   misconfiguration, not a by-design Pattern B.
3. `/verify` carries a **blocking** check that service domains resolve to the
   box — a reinstall must not pass green while `*.<domain>` doesn't.

## Consequences

- The old "public fallback when AdGuard is down" argument is explicitly
  **rejected**: that fallback is what silently breaks SSO.
- If outage resilience is wanted, the answer is a **HA AdGuard pair**, not
  falling back to a resolver that can't see the box's domains.
