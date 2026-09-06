---
title: "ADR 0007 — App containers move off `hostNetwork` into isolated netns; named carve-outs stay on host networking"
whenToUse: "You are choosing a network mode for a template or wiring one service to another: whether a pod may set hostNetwork, which address a cross-service reference must use (loopback inside a pod, the host gateway across services, never a hard-coded LAN IP), and why needing a loopback-bound neighbour is not a reason to leave the isolated netns."
kind: adr
tags: [adr, decision, network, containers, podman, isolation, ports]
---
# ADR 0007 — App containers move off `hostNetwork` into isolated netns; named carve-outs stay on host networking

- **Status:** Accepted (incremental; epic #817) — amended 2026-08-12 (see
  [Amendment 2026-08-12](#amendment-2026-08-12--consuming-a-loopback-bound-sibling-is-not-a-carve-out))
- **Date:** 2026-06-05
- **Deciders:** operator (mdopp)
- **Related:** [ADR 0001](adr-0001-authentication-via-authelia-sso-or-lldap.md)

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
2. **These stay on `hostNetwork` deliberately — do not re-litigate per #817.**
   The list is **closed**: it is enumerated here by name, and a new service does
   **not** join it by arguing its case. Adding a name is an amendment to this
   ADR, not a template decision.
   - **nginx, adguard, home-assistant** — genuinely need host networking
     (ingress :80/:443, DNS :53, mDNS/SSDP).
   - **llama + solaris** — the local model server (llama-server, port 11435)
     ships no auth and is loopback-bound by design; a plain `hostPort` would
     newly LAN-expose it, and an isolated consumer can only reach it via the
     host. Revisit only once a host-firewall / private-network story exists.
     **That precondition was met by #2388** — see the amendment below; this
     entry is grandfathered, not a precedent. *(This entry read `ollama +
     hermes` until 2026-09; renamed, not re-decided — see
     [History 2026-09-06](#history-2026-09-06--the-model-server-carve-out-is-now-llama).)*
   - **file-share** — Samba needs privileged ports 139/445 (hard under rootless)
     and the Syncthing GUI is loopback-bound. Needs design work first.
   - **auth** — migrated last, on its own (LLDAP holds all identity data).
3. **Consuming a loopback-bound sibling on the box is NOT a carve-out.** Needing
   to reach another on-box service that binds `127.0.0.1` does not qualify a
   service for `hostNetwork: true` and does not add it to the list in Decision 2.
   The intended pattern is Decision 1 plus a host-firewall rule on the *sibling*:
   - the **consumer** runs isolated (no `hostNetwork`), publishes its own ports
     as `hostPort`, and addresses the sibling as
     `http://host.containers.internal:<port>` — never `127.0.0.1`, never
     `{{LAN_IP}}`;
   - the **sibling** binds wider than loopback so that path resolves (pasta maps
     `host.containers.internal` to the host's LAN address, not to loopback), and
     its port variable carries **`blockLanAccess: true`**, which installs an
     nftables rule refusing that port on physical interfaces while still
     accepting loopback and the pasta-proxied path (#2388, mechanics in
     `packages/backend/src/lib/hostFirewall.ts`, contract in
     `docs/TEMPLATE_AUTHORING.md`).

   The order matters: **siblings first, consumer second.** Until the sibling
   binds wider and carries `blockLanAccess`, an isolated consumer cannot reach
   it, and the honest state of such a service is a *documented deviation* — not
   a carve-out. When the sibling is owned by another repo, that deviation is
   recorded in the consuming template, and this ADR's list stays unchanged.

## Amendment 2026-08-12 — consuming a loopback-bound sibling is not a carve-out

Decision 3 was added after #2518 asked whether a service that talks to two
loopback-bound siblings counts as a named carve-out. It does not.

The trigger: Decision 2's second entry — then named `ollama + hermes`, today
`llama + solaris` — made its own revisit
conditional on *"a host-firewall / private-network story"*. That story shipped in
**#2388** — the `blockLanAccess` port flag and its nftables capability handler —
and this ADR was never updated, which left three documents stating three
different rules (this ADR, `assists/new-service-architecture.md`, and the
Solaris directives' container-DNS table). With the firewall story in place, the
motivating reason for a loopback-consumer carve-out is gone, so the list stays
closed and Decision 3 states the pattern instead.

Consequences of the amendment tracked separately, **not** in this ADR: the
grandfathered entries whose stated precondition is now met should be re-examined
against Decision 3, and `templates/claude-dev` runs `hostNetwork: true` without
appearing on the list at all — see #2522.

## Amendment 2026-08-17 — an on-box client reaches ServiceBay on the app port, not through the proxy

Decision 1 tells a container how to reach *another service*. It says nothing
about reaching **ServiceBay itself** — its REST API and its `/mcp` endpoint —
from a container on the same box. That gap cost a working session, so the rule
is written down here:

> **From inside the box, address ServiceBay as
> `http://host.containers.internal:${PORT:-5888}` — the app port, directly.
> Never the public hostname, and never port 80/443.**

The reasoning is the same shape as Decision 1, one layer up. Ports 80/443 are
**nginx-proxy-manager**, and a reverse proxy necessarily routes by **vhost
name**. ServiceBay's own admin host is one of the six permanently LAN-only NPM
hosts whose access list ends in `deny all` (see
`packages/backend/src/lib/reverseProxy/lanDeniedPage.ts`), so every attempt to
reach `/mcp` through the proxy from a container fails, and each failure looks
like a *different* problem:

| Attempt from a container | What happens | Why it misleads |
|---|---|---|
| `https://host.containers.internal/mcp` | TLS handshake rejected | reads as a certificate problem |
| `https://169.254.1.2/mcp` | TLS handshake rejected | reads as a certificate problem |
| `http://169.254.1.2/mcp` | `404` | reads as "the endpoint moved" |
| `http://169.254.1.2/mcp` + `Host: admin.<domain>` | `301` to the public URL | reads as "just add the hosts entry" |
| **`http://169.254.1.2:5888/mcp`** | **`200`** | — |

The trap is that the last row is never reached by elimination: the `301` in row
four points at a real, correct-looking answer (map the name to a reachable
address via `/etc/hosts` or `--add-host`), and that answer *works*. It is simply
the wrong layer — it re-creates the proxy dependency instead of dropping it, and
it dies on the next container rebuild.

Consequences of stating it this way:

- **No DNS, no TLS, no `Host` header, no `/etc/hosts` entry, no container
  rebuild.** The traffic is host-local link-local and never touches a network
  interface, so plain HTTP is not a downgrade here.
- **Authentication is unchanged.** The app port enforces the same session-cookie
  or `Authorization: Bearer sb_…` check; bypassing the proxy bypasses only
  *routing*, never authorization. Several route handlers already reason
  explicitly about a "direct `:5888` call bypassing NPM" — this amendment names
  the path they were already defending.
- **`host.containers.internal` is the spelling**, per Decision 1. `169.254.1.2`
  is podman's fixed host address and works, but the name survives a
  reconfiguration; prefer it.
- Losing the container's LAN route does **not** break this path, which is the
  point — the public hostname resolves to the box's LAN address and is therefore
  the fragile way in.

## History 2026-09-06 — the model-server carve-out is now `llama`

Decision 2's second entry was written as **`ollama + hermes`**. Ollama is retired
(operator decision, 2026-09; solarisbay#1332) and the box's model server is
llama.cpp **`llama-server`** — the solarisbay `llama` template, host network,
port **11435**, OpenAI-compatible `/v1`, GGUF models under
`${DATA_DIR}/llama/models`. The Hermes agent runtime was likewise replaced by the
native Solaris Engine.

**The decision does not change.** This is a rename of an existing entry, not a
new carve-out: the reasoning the entry records still holds for the service that
replaced it — llama-server ships no auth and binds loopback, so a `hostPort`
would newly LAN-expose it. Two consequences worth writing down rather than
re-deciding:

- **Addressing is unchanged** (Decisions 1 and 3). A host-network service on the
  box reaches the model server at `http://127.0.0.1:11435`; an isolated pod would
  reach it at `http://host.containers.internal:11435` — **never a LAN IP**.
  Today only the first path answers: llama-server still binds loopback only, so
  the pod-facing listener — and the `blockLanAccess` flag Decision 3 pairs it
  with — lands with **mdopp/solarisbay#1344**. Until then an isolated consumer
  pointed at 11435 gets nothing, and that is a *documented deviation* in the
  consuming template (Decision 3), not grounds to join the closed list.
- **Still grandfathered, still not a precedent.** Re-examining this entry against
  Decision 3 once #1344 lands remains the open item named in the 2026-08-12
  amendment.

## Consequences

- post-deploy scripts run in the **host** netns, so their `127.0.0.1` probes
  keep working — only in-container references change. No schema bump needed
  (precedent #824).
- Increment 1 (vaultwarden + immich) shipped 4.15.0; increment 2 (media +
  radicale) shipped 4.15.2; increment 3 (file-share) and auth remain.

