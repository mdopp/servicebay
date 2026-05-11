# Voice Stack

Wyoming-protocol voice services — runs as a standalone pod so Home Assistant (or any other Wyoming consumer) can talk to a shared local voice pipeline.

Three containers:

1. **Faster Whisper** — speech-to-text, CTranslate2-accelerated. Bound on `tcp://0.0.0.0:10300`.
2. **Piper** — text-to-speech. Bound on `tcp://0.0.0.0:10200`.
3. **openWakeWord** — wake-word detection ("Hey Jarvis", "Ok Nabu"). Bound on `tcp://0.0.0.0:10400`.

## Why a separate template

These three were originally bundled inside `home-assistant/template.yml`, but they're not HA-specific:

- The Wyoming protocol is consumed by Rhasspy, custom conversation agents, and pre/post-processing pipelines (speaker-ID, diarization, custom wake-word training).
- Voice has its own update cadence — new Whisper models, fresh Piper voices, wake-word releases shouldn't block HA updates and vice versa.
- Voice has different hardware requirements — running Whisper on a GPU shouldn't drag HA along.
- Replacing voice with a different stack (e.g. a speaker-ID pre-hook in front of Whisper) shouldn't require forking the HA template.

See #348 for the design rationale.

## Variables

- **WHISPER_MODEL**: Faster Whisper model size (default: `base-int8`). int8 variants are noticeably faster with minimal quality loss; the bigger non-int8 models are higher quality but RAM-heavy.
- **WHISPER_LANGUAGE**: Language code for speech recognition (default: `de`).
- **PIPER_VOICE**: Text-to-speech voice (default: `de_DE-thorsten-high`). Format is `<locale>-<voice-name>-<quality>`.

## Ports

All three services use the Wyoming protocol over TCP, bound to host network:

- Faster Whisper: `10300`
- Piper: `10200`
- openWakeWord: `10400`

## Wiring with Home Assistant

After both the `voice` and `home-assistant` pods are running:

1. In HA, go to *Settings → Voice Assistants*.
2. Add a Wyoming integration for each of:
   - **Speech-to-text**: `localhost:10300`
   - **Text-to-speech**: `localhost:10200`
   - **Wake word**: `localhost:10400`
3. Build a voice pipeline that ties them together.

Because both pods share `hostNetwork: true` on the same host, `localhost` resolves to the voice endpoints directly — no Wyoming-over-LAN config required. Multi-host setups need to swap `localhost` for the voice node's reachable IP.

## Migration from the old in-HA-pod voice

If you previously had voice bundled inside the HA pod, your data lived under:

- `{{DATA_DIR}}/home-assistant/whisper`
- `{{DATA_DIR}}/home-assistant/piper`

The new voice template uses:

- `{{DATA_DIR}}/voice/whisper`
- `{{DATA_DIR}}/voice/piper`

`post-deploy.py` handles this automatically on first install: if the old paths exist and the new ones don't, it moves them — no model re-download needed. The operation is idempotent; subsequent runs see the new paths already populated and skip.

HA's existing voice-pipeline configuration keeps working without changes — the endpoints are still `localhost:10300/10200/10400`, the only thing that moved is which pod hosts them.
