# Home Assistant Stack

This stack combines the core components of a modern smart home into a single, highly integrated unit:

1.  **Home Assistant**: The core automation hub
2.  **Z-Wave JS UI**: Driver for Z-Wave USB sticks
3.  **Matter Server**: Connectivity layer for Matter/Thread devices
4.  **Faster Whisper**: Local speech-to-text (Wyoming protocol, CTranslate2-accelerated)
5.  **Piper**: Local text-to-speech (Wyoming protocol)
6.  **openWakeWord**: Wake-word detection ("Hey Jarvis", "Ok Nabu")

## Features
*   **Host Network**: All services run on the host network for optimal auto-discovery (mDNS, UPnP, Thread)
*   **Integrated Storage**: All data is persisted under `${DATA_DIR}/home-assistant/`
*   **USB Passthrough**: The Z-Wave stick is mapped via the `ZWAVE_DEVICE` variable
*   **Voice Pipeline**: Faster Whisper + Piper + openWakeWord provide a fully local voice assistant (no cloud)

## Variables
*   **DATA_DIR**: Base directory for stack data (default: `/mnt/data`)
*   **ZWAVE_SECRET**: A random string for Z-Wave JS session security
*   **ZWAVE_DEVICE**: Absolute path to the USB device (e.g., `/dev/serial/by-id/usb-0658_0200-if00`)
*   **WHISPER_MODEL**: Faster Whisper model size (`tiny-int8`, `base-int8`, `small-int8`, `medium-int8`, `tiny`, `base`, `small`, `medium` — default: `base-int8`)
*   **WHISPER_LANGUAGE**: Language code for speech recognition (default: `de`)
*   **PIPER_VOICE**: TTS voice (default: `de_DE-thorsten-high`)

## Ports
*   Home Assistant: `http://<server-ip>:8123`
*   Z-Wave JS UI: `http://<server-ip>:8091`
*   Faster Whisper (Wyoming): `10300`
*   Piper (Wyoming): `10200`
*   openWakeWord (Wyoming): `10400`

## Voice Setup
After installation, go to Home Assistant > Settings > Voice Assistants and add:
1. Speech-to-text: Wyoming > `localhost:10300`
2. Text-to-speech: Wyoming > `localhost:10200`
3. Wake word: Wyoming > `localhost:10400`

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
