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

To enable OIDC login via Authelia, add this client to your Authelia `configuration.yml`:

```yaml
      - client_id: 'homeassistant'
        client_name: 'Home Assistant'
        client_secret: '$plaintext$<your-secret>'
        public: false
        authorization_policy: 'one_factor'
        redirect_uris:
          - 'https://ha.<your-domain>/auth/oidc/callback'
        scopes: ['openid', 'profile', 'email', 'groups']
        response_types: ['code']
        grant_types: ['authorization_code']
        token_endpoint_auth_method: 'client_secret_post'
```

Then add the OIDC integration in Home Assistant's `configuration.yaml`.
