# Beets — changelog

## v2 (breaking)

**Required action, if `beets` was installed from a local (file-dropped)
template:** delete `DATA_DIR/local-templates/templates/beets` before
re-deploying, otherwise that copy keeps overriding this one — local templates
win over built-ins by name. Removing the directory does not touch the running
service; the deployed unit is independent of the template it was rendered from.

**Then check `DATA_DIR/beets/config/config.yaml` before you run an import.**
This template never rewrites an existing config. A config carried over from an
earlier install commonly has `move: yes` under `import:` plus a `paths:` rename
scheme — with those set, *any* import moves and renames every file it touches,
across your whole music library. Set `move: no` and `copy: no` first unless
relocating the collection is genuinely what you want. `post-deploy.py` prints a
warning in the install log when it finds this.

What v2 changes (#2581):

- **The web UI is reachable.** v1 declared no ports at all — not even a
  `containerPort` — so `beet web` answered only on a container-internal
  address. v2 publishes it on the host via `hostPort`, LAN-only: no subdomain,
  no SSO, because beets' web plugin has no authentication of any kind and this
  UI fronts a service that can rewrite a music library.
- **The container runs as UID 0 instead of PUID/PGID 1000.** Under rootless
  podman, UID 1000 in the container maps to a sub-UID with no write access to
  the `core`-owned music files, so v1 could not have written a single tag even
  if an import had been triggered. `migrations/v1-to-v2.py` re-owns
  `DATA_DIR/beets/config` accordingly (`podman unshare chown -R 0:0`) — nothing
  is moved or deleted, and the music library is not touched.
- **A safe config is seeded when there isn't one** (`copy: no`, `move: no`,
  `write: yes`, `web.readonly: yes`), by an initContainer that leaves any
  existing config alone.
- **A health check that goes red on an empty library** is registered, so a
  beets that is running but has never imported anything stops looking green.
- **Still no automatic import.** v1 shipped a nightly-import helper that never
  ran; had it worked it would have restructured the whole collection
  unattended. v2 does not replace it — imports are operator-triggered, one
  documented command. The reasoning is in `README.md`.

Data paths are unchanged from v1 (`DATA_DIR/beets/config`, the file-share
music and audiobook folders), so the library database and your music stay
exactly where they are.

## v1

Initial release — local template. Ran `beet web` with no published ports, no
import trigger, and a UID that could not write to the music library.
