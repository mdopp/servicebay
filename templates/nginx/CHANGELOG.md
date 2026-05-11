# Nginx Proxy Manager — template changelog

Tracks breaking changes to the `nginx` template's pod structure /
variable shape. Each H2 corresponds to a value of
`servicebay.schema-version` in `template.yml`.

## v2

**NPM moved to `hostNetwork: true`.**

NPM used to run in its own pod netns with `hostPort` mappings for
80/443/81. That broke the reverse-proxy upstream path for every
service template that runs in `hostNetwork: true` mode (adguard,
auth, file-share, home-assistant, media, radicale, voice): under
rootless podman, a bridge-netns container cannot reach the host's
LAN IP (hairpin NAT), so `proxy_pass http://<lan-ip>:<port>` never
landed on the upstream and every such proxy host returned 502.

Putting NPM on `hostNetwork: true` matches the network model of the
other infrastructure templates and removes the hairpin entirely.
Ports 80/443/81 are now bound directly on the host — no behavior
change from the outside, but cross-pod traffic now works.

Required action: re-deploy the `nginx` template. NPM's data
directory is preserved (proxy hosts, certs, settings all intact).

## v1

Initial release. Nginx Proxy Manager in own pod netns with hostPort
mappings.
