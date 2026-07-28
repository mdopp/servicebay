# Home Assistant Stack

This stack combines the core smart-home components into a single pod:

1.  **Home Assistant**: The core automation hub
2.  **Z-Wave JS UI**: Driver for Z-Wave USB sticks (only when `ZWAVE_DEVICE` is set)
3.  **Matter Server**: Connectivity layer for Matter/Thread devices

## Features
*   **Host Network**: All services run on the host network for optimal auto-discovery (mDNS, UPnP, Thread)
*   **Integrated Storage**: All data is persisted under `${DATA_DIR}/home-assistant/`
*   **USB Passthrough**: The Z-Wave stick is mapped via the `ZWAVE_DEVICE` variable

## Variables
*   **DATA_DIR**: Base directory for stack data (default: `/mnt/data`)
*   **TZ**: Timezone (default: `Europe/Berlin`)
*   **ZWAVE_SECRET**: A random string for Z-Wave JS session security (auto-generated)
*   **ZWAVE_DEVICE**: Absolute path to the USB device (e.g., `/dev/serial/by-id/usb-0658_0200-if00`)

## Ports

The pod runs on the host network, so an app that binds `0.0.0.0` is reachable
from every LAN device with no proxy and no SSO in front of it. Since template
**v7 (#2416)** only Home Assistant itself is exposed that way — it has its own
login. Everything else is bound to the host loopback and reached either through
the reverse proxy or from inside the pod:

| Port | Service | Bind | How you reach it |
|------|---------|------|------------------|
| 8123 | Home Assistant | all interfaces | `https://home.<domain>` (or `http://<server-ip>:8123`); HA's own login + Authelia OIDC |
| 8091 | Z-Wave JS UI | `127.0.0.1` (`HOST` env) | `https://zwave.<domain>` — LAN-only proxy host, Authelia forward-auth |
| 3001 | Z-Wave JS control websocket | `127.0.0.1` (`serverHost` setting) | Home Assistant only, over `ws://localhost:3001` |
| 5580 | Matter server websocket | `127.0.0.1` (`--listen-address`) | Home Assistant only, over `ws://localhost:5580/ws` |

Ports 3001 and 5580 are unauthenticated control channels — anything that can
open them can actuate every paired Z-Wave/Matter device — which is why they are
loopback-only. Binding the Matter websocket to the loopback does **not** affect
Matter commissioning or device traffic: `--listen-address` binds only the
websocket API server, never the CHIP/Matter stack (that is
`--primary-interface`). mDNS/UPnP/Thread discovery keeps using the real
interfaces.

## SSO (Authelia)

ServiceBay registers an OIDC client for Home Assistant in Authelia automatically. The client secret is stored in the `HA_OIDC_SECRET` variable and can be retrieved from **Settings → Integrations → Saved credentials**.

Home Assistant does not ship a native OIDC auth provider. To wire up SSO you have two options:

**Option A — HACS custom integration (recommended)**

Install [homeassistant_auth_oidc](https://github.com/christiaangoossens/hacs-oidc-client) via HACS, then add to `configuration.yaml`:

```yaml
homeassistant_auth_oidc:
  client_id: homeassistant
  client_secret: "<HA_OIDC_SECRET from saved credentials>"
  discovery_url: "https://auth.<your-domain>/.well-known/openid-configuration"
```

**Option B — Authelia forward-auth at the proxy level**

Configure NPM to forward-authenticate every request to `home.<domain>` via Authelia before it reaches HA. Users log in to Authelia once; HA sees them as coming from a trusted proxy. No changes to `configuration.yaml` needed, but HA still maintains its own user accounts.
