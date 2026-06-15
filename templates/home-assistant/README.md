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
*   Home Assistant: `http://<server-ip>:8123`
*   Z-Wave JS UI: `http://<server-ip>:8091`

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
