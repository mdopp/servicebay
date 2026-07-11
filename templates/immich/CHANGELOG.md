# Immich — template changelog

## v4 — pgvecto.rs → VectorChord (breaking)

immich v3 removed the deprecated **pgvecto.rs** vector extension. The template
pinned the old `docker.io/tensorchord/pgvecto-rs:pg14-v0.2.0` DB image while
`immich-server:release` auto-updated past it, so the microservices worker
crash-looped with *"No vector extension found. Available extensions: vchord,
vector"*.

Changes:

1. **DB image** → `ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0`
   (immich's own image; bundles VectorChord + pgvector + pgvecto.rs and sets
   `shared_preload_libraries` internally).
2. **No postgres `args`** — the old `-c shared_preload_libraries=vectors.so`
   / `listen_addresses` override is removed (the image handles preload; a
   partial override would drop it — the #410 trap). Postgres stays pod-internal
   (no ports), so the localhost-only bind isn't needed for isolation.
3. **`DB_VECTOR_EXTENSION=vectorchord`** on immich-server.

**Operator impact (breaking):** immich migrates the existing `vectors` data to
VectorChord **in place** on its next startup (reindex takes seconds-to-minutes
by library size). **Back up pgdata before redeploy** — the migration rewrites
the vector column. The new image bundles pgvecto.rs too, so an old backup can
still be restored. **Do not downgrade immich below 1.133.0 after migrating.**
Photo files are untouched (they live in the upload volume, not the DB).

## v3 — #1904

Disk-import photos become keyless External Libraries (Decision A):

1. **Read-only photo-area mount.** immich-server gains a new mount of
   the file-share data root (`${DATA_DIR}/file-share/data → /mnt/photos`,
   `readOnly: true`). Disk-import copies photos into
   `data/<owner>/photos` (or shared `data/photos`) like every other
   category — no CLI upload, no per-user API keys — and Immich indexes
   them in place via per-user External Libraries
   (`/mnt/photos/<user>/photos`) plus a "Shared" one (`/mnt/photos/photos`).
   The libraries are auto-provisioned via a single stored Immich **admin**
   API key, and the owning library's scan is triggered after an import.

2. **`file-share` dependency.** Added to `servicebay.dependencies` so its
   data root exists before Immich mounts it.

Operator impact: redeploy adds the read-only mount; no data moves and
nothing is deleted. The photo areas are read-only **inside Immich**
(curation/deletion happens on the filesystem / Filebrowser). External
libraries reference files in place, so there's no double storage.

## v2 (breaking) — #410

Three changes land together because they all sit on the same SSO path:

1. **Admin seed.** A new `post-deploy.py` waits for Immich to become
   ready, then creates the initial admin user via
   `/api/auth/admin-sign-up` using the new `IMMICH_ADMIN_NAME`,
   `IMMICH_ADMIN_EMAIL`, and `IMMICH_ADMIN_PASSWORD` variables. The
   password is surfaced in the post-install credentials banner. Before
   v2 the operator landed on Immich's first-run sign-up screen
   themselves.

2. **OIDC client secret + auto-config.** `variables.json` now declares
   `IMMICH_SSO_SECRET` (auto-generated) and pins it via
   `clientSecretVar`, so the same secret is in Authelia's `clients[]`
   entry and in Immich's system config. The post-deploy logs in as the
   seeded admin and PUTs `/api/system-config` to enable OAuth against
   `https://auth.<PUBLIC_DOMAIN>` with `autoRegister: true` and
   button text "Login with Authelia". Before v2 the wizard generated
   a secret on Authelia's side but Immich never learned what it was.

3. **`hostNetwork: true`.** Same hairpin-NAT trap as Vaultwarden (#408):
   under bridge networking the container resolved `auth.<PUBLIC_DOMAIN>`
   to the router's WAN IP and OIDC discovery failed. Under hostNetwork
   Immich uses the host resolver and AdGuard rewrites send the
   discovery request to NPM → Authelia. Side-effect: redis + postgres
   sidecars are now pinned to `127.0.0.1` via `--bind` / `-c
   listen_addresses=127.0.0.1` so they remain accessible to
   immich-server over loopback without being exposed on the LAN.

Operator impact: redeploy regenerates the env file, the wizard fills
in the new admin + SSO variables (or you set them manually). After
the redeploy the post-deploy script runs once and emits the admin
credential — fold that into your password manager and you can either
sign in locally or click *Login with Authelia* on the Immich login
page.
