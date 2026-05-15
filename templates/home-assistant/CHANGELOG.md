# Home Assistant — template changelog

Tracks breaking changes to the `home-assistant` template's pod
structure / variable shape (not Home Assistant itself — that's
versioned by the upstream image tag). Each H2 corresponds to a value
of `servicebay.schema-version` in `template.yml`.

The ServiceBay update flow reads the section header(s) between the
operator's installed schema-version and the current one and surfaces
them in the re-deploy dialog. Each `(breaking)` section needs an
explicit acknowledgement before the deploy can proceed.

## v6

**Z-Wave JS WS server pinned via `ZWAVE_EXTERNAL_SETTINGS`.**

Z-Wave JS UI needs its HA WebSocket server enabled and bound to a
port other than 3000 — port 3000 on the host is occupied by NPM's
internal admin backend (NPM uses `hostNetwork`, so its container's
`127.0.0.1:3000` listener takes the host's `127.0.0.1:3000`). The
previous post-deploy patched `gateway.wsServer` / `gateway.wsServerPort`
via the REST API; those field names don't exist in zwave-js-ui, so
the patch silently did nothing and operators had to enable the
server in the UI by hand.

This release adds a `ZWAVE_EXTERNAL_SETTINGS` env var on the
`zwave-js` container pointing at
`/usr/src/app/store/sb-external-settings.json`. The post-deploy
seeds that file with `serverEnabled: true`, `serverPort: 3001`,
`serverHost: "0.0.0.0"` on first install and restarts the zwave-js
container so the values take effect immediately. Subsequent deploys
detect the file and skip; if you'd rather manage the WS server
yourself via the UI, set a `zwave.serverPort` in
`/usr/src/app/store/settings.json` *before* re-deploying and the
post-deploy will skip writing the override.

Required action: nothing. Existing installs continue to work — if
you'd previously configured the WS server manually in the UI, that
config wins because the seeding step honours your existing
`settings.json`.

## v5 (breaking) — #493

**OIDC SSO via the `auth_oidc` custom component.**

Home Assistant has no native OIDC auth provider, so this release
adds the `auth_oidc` HACS-style integration directly into
`<config>/custom_components/auth_oidc/`. The `post-deploy.py` hook
downloads the pinned release tarball
(https://github.com/christiaangoossens/hass-oidc-auth — version
`HA_OIDC_AUTH_VERSION`, default `v0.6.0`) on every deploy and skips
the network round-trip when the on-disk `.sb_installed_version`
stamp already matches.

The rendered `configuration.yaml.mustache` ships an `auth_oidc:` block
pointing at the Authelia `discovery_url`, with
`features.automatic_user_linking` + `automatic_person_creation` on
and a roles mapping for `HA_OIDC_ADMIN_GROUP` / `HA_OIDC_USER_GROUP`
(default `lldap_admin` / `lldap_strict_readonly`).

Required action: re-deploy. After the deploy, the HA login screen
shows a *Sign in with Authelia* button — click it, log in via SSO,
and the LLDAP user lands as HA admin (when in `lldap_admin`) or
regular user. The Companion app captures a HA-native long-lived
token on first OIDC login and keeps working independently of
Authelia from that point.

**If you customised `/config/configuration.yaml` by hand**, back it
up before re-deploying — the deploy step renders the template's
`.mustache` over the live file. After re-deploy, merge your custom
keys back in, leaving the new `auth_oidc:` block in place.

Bumping `HA_OIDC_AUTH_VERSION` between deploys upgrades the
component in place: the post-deploy detects the version mismatch,
re-downloads the tarball, and restarts the HA container so the new
code loads.

## v4 (breaking) — #420 / #422

**Z-Wave JS UI always runs + reachable at `zwave.<lanDomain>`.**

Previously the Z-Wave JS UI container only started when `ZWAVE_DEVICE`
was set; without a stick the container was absent entirely and the UI
unreachable. Adding a stick later meant editing the pod yaml by hand.

The container now starts unconditionally. Without a stick the UI runs
in "no serial device configured" mode — the operator points it at a
stick later via the UI's own *Settings → Z-Wave → Serial Port* picker
(or re-runs the install wizard once #421 lands). The device mount +
zwave-stick hostPath volume are still guarded by `{{#ZWAVE_DEVICE}}`
so podman doesn't crash-loop on a missing host path.

Also adds `ZWAVE_JS_SUBDOMAIN` (default `zwave`, LAN-only) so the UI
is reachable at `https://zwave.<lanDomain>` through NPM. Subdomain is
created unconditionally because the container is too — visiting it
without a stick configured just opens the UI's empty state.

Required action: redeploy Home Assistant. Pre-existing zwave-config
data under `${DATA_DIR}/home-assistant/zwave-js` is preserved.

## v3

**Seed `configuration.yaml` with `http.trusted_proxies` so NPM can talk to HA.**

Home Assistant's first-boot wrote a minimal `configuration.yaml`
without an `http:` block. Behind NPM (which forwards `X-Forwarded-For`),
HA's `http.forwarded` component then rejected every proxied request
with HTTP 400 ("request from reverse proxy but HTTP integration is
not set up for reverse proxies").

The template now ships `configuration.yaml.mustache` that gets
written to `/config/configuration.yaml` on install. Trusts the
private RFC1918 ranges + loopback — covers any LAN ServiceBay sits
on without per-install variable injection.

Required action: nothing, unless you already customized
`configuration.yaml`. Schema bump triggers a re-deploy prompt; the
new file ships next to your existing one, you decide whether to
overwrite. After a HA backup-restore the snapshot's
`configuration.yaml` takes over — re-add the `http:` block manually,
otherwise `home.<domain>` will start returning 400 again.

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
