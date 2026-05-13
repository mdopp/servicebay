# Home Assistant Stack

This stack combines the core smart-home components into a single pod:

1.  **Home Assistant**: The core automation hub
2.  **Z-Wave JS UI**: Driver for Z-Wave USB sticks (only when `ZWAVE_DEVICE` is set)
3.  **Matter Server**: Connectivity layer for Matter/Thread devices

The voice pipeline (Faster Whisper + Piper + openWakeWord) lives in the separate `voice` template since #348 — deploy it alongside HA when you want a local voice assistant. HA's voice-pipeline config points at `localhost:10300/10200/10400` regardless of which pod hosts those services.

## Features
*   **Host Network**: All services run on the host network for optimal auto-discovery (mDNS, UPnP, Thread)
*   **Integrated Storage**: All data is persisted under `${DATA_DIR}/home-assistant/`
*   **USB Passthrough**: The Z-Wave stick is mapped via the `ZWAVE_DEVICE` variable

## Variables
*   **DATA_DIR**: Base directory for stack data (default: `/mnt/data`)
*   **TZ**: Timezone (default: `Europe/Berlin`)
*   **ZWAVE_SECRET**: A random string for Z-Wave JS session security (auto-generated)
*   **ZWAVE_DEVICE**: Absolute path to the USB device (e.g., `/dev/serial/by-id/usb-0658_0200-if00`)

Voice-related variables (Whisper model, Piper voice, language) now live in the `voice` template.

## Ports
*   Home Assistant: `http://<server-ip>:8123`
*   Z-Wave JS UI: `http://<server-ip>:8091`

## Voice Setup

Deploy the `voice` template alongside this one, then in HA go to *Settings → Voice Assistants* and add:

1. Speech-to-text: Wyoming → `localhost:10300`
2. Text-to-speech: Wyoming → `localhost:10200`
3. Wake word: Wyoming → `localhost:10400`

Because voice runs on host network on the same node, `localhost` resolves to the voice pod directly — no Wyoming-over-LAN setup needed.

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
