# Solaris System Directives & Reinstallation Guidelines

**Target System:** `mdopp/servicebay` & Solaris Stack  
**Document Type:** Binding System Architecture & Configuration Standard

---

## 1. 🏷️ Identity & Naming Directive: Solaris

> **CRITICAL RULE FOR ALL AI AGENTS & DEVELOPERS:**  
> The AI Assistant and Voice/Chat stack is named **Solaris** (`solaris-chat`, `solaris-gatekeeper`, `solaris-whisper`, `solaris-tts`).  
> Any legacy references to "hermes" or `/stacks/hermes` are deprecated historical internal path aliases and **must not** be used or referenced as active system components. The stack name is **Solaris** (`mdopp/solaris`).

---

## 2. 🔌 Resilient Network Architecture & Reinstallation Safety

To guarantee that after a **full system reinstallation** or **IP address change**, all connections between Home Assistant, Jellyfin, Solaris, and Voice Speakers automatically work without manual intervention:

### A. Zero Hardcoded IPs in cross-service references

The rule is **no hardcoded LAN or static IP in a cross-service reference** — that
is what breaks after a reinstall or a DHCP change. **Which name to use instead is
set by [ADR 0007](adr/0007-container-network-isolation-and-carveouts.md), not by
this document**; there is no shared podman DNS network, so a bare service name
(`http://media-jellyfin:8096`) does **not** resolve between services:

| Reference | Use | Not |
|---|---|---|
| **Between containers of the same service** (one kube pod → one netns) | `http://127.0.0.1:<containerPort>` | a service name ❌ |
| **Across services** (e.g. Home Assistant ➔ Jellyfin, Solaris Gatekeeper ➔ Wyoming) | `http://host.containers.internal:<hostPort>` | `{{LAN_IP}}` / a static IP ❌ |

A sibling that must stay off the LAN binds wider and carries `blockLanAccess:
true` on its port variable (ADR 0007 Decision 3; contract in
`TEMPLATE_AUTHORING.md`) — it does **not** get `hostNetwork: true` on the
consumer's behalf.

### B. Host / Network Device Connections (Speakers, Voice PE, Cast)
For external network devices (ESPHome Voice PE speakers, Google Cast, mobile apps):
1. **Dynamic Environment Variable `${SERVER_IP}`:**  
   ServiceBay's deployment wizard resolves the host's LAN IP (`${SERVER_IP}`) or mDNS hostname (`atHome-Server.local`).
2. **Automated Template Injection:**  
   ServiceBay's `post-deploy.py` injects `${SERVER_IP}` into `core.config_entries` and client configurations upon first boot.
3. **DHCP / Router Reservation:**  
   Recommend static DHCP reservation for the host server in the local router (Fritz!Box / AdGuard).

---

