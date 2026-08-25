# Nginx Proxy Manager — template changelog

Tracks breaking changes to the `nginx` template's pod structure /
variable shape. Each H2 corresponds to a value of
`servicebay.schema-version` in `template.yml`.

## v3

**`hostPort:` mappings removed — the v2 pod could not start.**

v2 put NPM on `hostNetwork: true` but left the `hostPort:` entries
from v1 in place. Podman rejects that combination outright:

    Error: PortMappings can only be used with Bridge, slirp4netns,
    or pasta networking

so the pod crash-loops and the install sits on "Still waiting for
Nginx Proxy Manager..." until it times out. Every other
`hostNetwork` template (adguard, auth, media, …) already used the
form this release adopts: `containerPort:` only, with the port list
carried for the UI and the network graph by the
`servicebay.ports` annotation.

Under `hostNetwork` the container binds its ports directly on the
host, so NPM listens on the 80/443/81 its image is built around.
`NGINX_PORT` / `NGINX_SSL_PORT` / `NGINX_ADMIN_PORT` therefore only
take effect as written when they are left at those defaults — a
changed value is reflected in ServiceBay's metadata but not inside
the container.

Required action: re-deploy the `nginx` template. Nothing moves on
disk — NPM's data directory (proxy hosts, certs, settings) is
untouched, which is why this hop ships no migration script.

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
