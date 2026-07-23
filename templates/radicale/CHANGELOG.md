# Radicale — template changelog

Tracks breaking changes to the `radicale` template's pod structure /
variable shape (not Radicale itself — that's versioned by the upstream
image tag). Each H2 corresponds to a value of `servicebay.schema-version`
in `template.yml`.

The ServiceBay update flow reads the section header(s) between the
operator's installed schema-version and the current one and surfaces them
in the re-deploy dialog. Each `(breaking)` section needs an explicit
acknowledgement before the deploy can proceed.

## v2 (breaking)

**DAV port bound to loopback — no longer LAN-exposed (#2357).**

Radicale's published CalDAV/CardDAV port (`RADICALE_PORT`, default 5232)
used to be published via `hostPort` with no `hostIP`, so podman bound it
on `0.0.0.0`. That left the calendar/contacts HTTP API — web UI,
collection listing, DAV verbs — reachable **directly on the LAN** at
`http://<box-lan-ip>:5232/`, bypassing the nginx reverse proxy that
fronts `caldav.<domain>` (TLS termination + the intended single entry
point).

This release adds `hostIP: 127.0.0.1` to the port publish so podman binds
`127.0.0.1:5232` instead. nginx runs on `hostNetwork`, so it still
reaches Radicale over the host loopback; the `caldav.<domain>` proxy host
is retargeted at `127.0.0.1:5232` via the new `loopbackOnly: true` flag on
`RADICALE_SUBDOMAIN`. `caldav.<domain>` keeps working exactly as before;
only the direct-on-LAN path is closed.

Required action: **re-deploy** the radicale service so the new port bind
takes effect. Existing installs keep the old `0.0.0.0` bind until the pod
is recreated — the running container was started from the v1 manifest and
does not auto-rebind. After the re-deploy, `curl http://<box-lan-ip>:5232/`
from another LAN host is refused while `https://caldav.<domain>/` still
serves normally.
