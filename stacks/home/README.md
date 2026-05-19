# Home stack

Smart-home automation + local voice pipeline:

- **home-assistant** — HA core + Z-Wave + Matter bridges
- **voice** — Wyoming protocol services: faster-whisper (STT) +
  piper (TTS) + openWakeWord (wake detection)

## Why a single stack

Voice was extracted from home-assistant in #348 to keep the HA
container slim, but the two are inseparable in practice — HA's
voice-assistant integration points at `localhost:10300/10200/10400`
on the same node. Bundling avoids the broken middle-state where
the operator has one but not the other.

## Dependencies

Requires the `basic` stack (nginx + auth + adguard) — HA's web UI
is proxied at `home.<domain>` and authenticates against LLDAP for
family accounts.
