# voice template changelog

## v2 (#1809)

- Whisper (STT) moved out of the kube pod into a companion
  `voice-whisper.container` Quadlet written by `post-deploy.py`:
  `podman kube play` silently drops CDI GPU device requests (#1026) and
  `privileged: true` exposes /dev without the host driver libraries, so a
  GPU whisper is only reachable via the `.container` path (same fixup as
  ollama). On CDI boxes the unit runs `lscr.io/linuxserver/faster-whisper:gpu`
  (auto-upgrading a default `base-int8` choice to `medium-int8`); without
  CDI it runs the previous CPU image with identical args. The Wyoming
  endpoint stays `tcp://localhost:10300`, so Home Assistant pipelines and
  the pod healthcheck are unchanged.
- No data migration: the CPU model cache stays at
  `${DATA_DIR}/voice/whisper`; the GPU image caches separately under
  `${DATA_DIR}/voice/whisper-gpu` (different layout, linuxserver `/config`).

## v1

- Initial split out of the home-assistant pod (#348): faster-whisper,
  piper and openWakeWord as one kube pod on the standard Wyoming ports.

## v2.1 (#1815)

- GPU boxes additionally get Sol's German voice: `voice-tts.container`
  (`ghcr.io/mdopp/solilos-tts`, Kokoro-Martin ONNX on the CUDA provider,
  OpenAI API on :8881) and `voice-tts-bridge.container`
  (`wyoming_openai` streaming bridge on :10203 → HA entity
  `tts.openai_streaming`). CPU-only boxes keep piper unchanged; the
  Assist-pipeline TTS selection (solbay post-deploy) prefers the bridge
  entity when present. No schema change — purely additive companion
  units.
