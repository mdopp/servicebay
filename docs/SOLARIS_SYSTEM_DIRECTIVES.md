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

### A. Container-to-Container Internal DNS (Zero Hardcoded IPs)
All inter-container communication in ServiceBay templates **must** use container DNS hostnames instead of hardcoded `127.0.0.1` or static IP addresses:

| Integration / Link | Correct Service Name URL | Legacy Incorrect Hardcoded URL |
|---|---|---|
| **Home Assistant ➔ Jellyfin** | `http://media-jellyfin:8096` (or `http://media:8096`) | `http://127.0.0.1:8096` ❌ |
| **Home Assistant ➔ Solaris Chat** | `http://solaris-chat:8787/ollama` | `http://127.0.0.1:8787` ❌ |
| **Solaris Gatekeeper ➔ Wyoming** | `http://solaris-whisper:10300` | `http://127.0.0.1:10300` ❌ |

### B. Host / Network Device Connections (Speakers, Voice PE, Cast)
For external network devices (ESPHome Voice PE speakers, Google Cast, mobile apps):
1. **Dynamic Environment Variable `${SERVER_IP}`:**  
   ServiceBay's deployment wizard resolves the host's LAN IP (`${SERVER_IP}`) or mDNS hostname (`atHome-Server.local`).
2. **Automated Template Injection:**  
   ServiceBay's `post-deploy.py` injects `${SERVER_IP}` into `core.config_entries` and client configurations upon first boot.
3. **DHCP / Router Reservation:**  
   Recommend static DHCP reservation for the host server in the local router (Fritz!Box / AdGuard).

---

