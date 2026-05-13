# Immich — template changelog

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
