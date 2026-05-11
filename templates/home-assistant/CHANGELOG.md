# Home Assistant — template changelog

Tracks breaking changes to the `home-assistant` template's pod
structure / variable shape (not Home Assistant itself — that's
versioned by the upstream image tag). Each H2 corresponds to a value
of `servicebay.schema-version` in `template.yml`.

The ServiceBay update flow reads the section header(s) between the
operator's installed schema-version and the current one and surfaces
them in the re-deploy dialog. Each `(breaking)` section needs an
explicit acknowledgement before the deploy can proceed.

## v2 (breaking)

**Voice extracted into the `voice` template.**

`Faster Whisper`, `Piper`, and `openWakeWord` used to live as
containers inside this pod. They now ship in a separate template
(`templates/voice/`) so other Wyoming consumers (Rhasspy, custom
agents, GPU-Whisper deployments) can share the same local voice
pipeline.

Required action: deploy the `voice` template alongside this one. The
voice template's `post-deploy.py` migrates the legacy data paths
automatically:

  - `${DATA_DIR}/home-assistant/whisper` → `${DATA_DIR}/voice/whisper`
  - `${DATA_DIR}/home-assistant/piper` → `${DATA_DIR}/voice/piper`

No re-download of Whisper models or Piper voices. The Wyoming
endpoints stay on the same loopback ports (10300 / 10200 / 10400),
so Home Assistant's existing voice-pipeline configuration keeps
working without changes.

If you skip the `voice` deploy, HA continues to run — only the voice
features go silent until you install voice or wire HA at a different
Wyoming endpoint.

Migration tracked in #348.

## v1

Initial release. Bundled HA + Z-Wave JS + Matter Server + Faster
Whisper + Piper + openWakeWord into a single pod.
