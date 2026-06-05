# ADR 0007 — App containers move off `hostNetwork` into isolated netns; named carve-outs stay on host networking

- **Status:** Accepted (incremental; epic #817)
- **Date:** 2026-06-05
- **Deciders:** operator (mdopp)
- **Related:** [ADR 0001](0001-authentication-via-authelia-sso-or-lldap.md)

## Context

Running app pods on `spec.hostNetwork` lets a compromised container reach the
host's other service ports and the ServiceBay control API. The goal (#817) is
to move non-essential templates into an **isolated bridge netns + per-port
`hostPort`**, shrinking that blast radius.

A subtlety bit increments 1–2: in **rootless podman an isolated pod cannot
reach the host's own LAN IP** (TCP refused). Pointing cross-pod refs at
`{{LAN_IP}}` silently broke vaultwarden/immich/audiobookshelf OIDC discovery and
radicale's LDAP bind.

## Decision

1. **Default: app templates drop `hostNetwork`**, add `hostPort` to each
   published `containerPort`, and reach other pods via the hostname
   **`host.containers.internal`** (podman auto-adds it) — **never `{{LAN_IP}}`**.
   Server-side OIDC discovery keeps a `hostAliases` entry mapping
   `auth.{{PUBLIC_DOMAIN}}` → `{{HOST_GATEWAY_IP}}` (default `169.254.1.2`) so
   the issuer name stays canonical.
2. **These stay on `hostNetwork` deliberately — do not re-litigate per #817:**
   - **nginx, adguard, home-assistant, voice** — genuinely need host networking
     (ingress :80/:443, DNS :53, mDNS/SSDP, Wyoming LAN).
   - **ollama + hermes** — ollama ships no auth and is loopback-bound by design;
     a plain `hostPort` would newly LAN-expose it, and isolated hermes can only
     reach ollama via the host. Revisit only once a host-firewall / private-
     network story exists.
   - **file-share** — Samba needs privileged ports 139/445 (hard under rootless)
     and the Syncthing GUI is loopback-bound. Needs design work first.
   - **auth** — migrated last, on its own (LLDAP holds all identity data).

## Consequences

- post-deploy scripts run in the **host** netns, so their `127.0.0.1` probes
  keep working — only in-container references change. No schema bump needed
  (precedent #824).
- Increment 1 (vaultwarden + immich) shipped 4.15.0; increment 2 (media +
  radicale) shipped 4.15.2; increment 3 (file-share) and auth remain.
