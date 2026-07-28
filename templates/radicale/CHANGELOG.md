# Radicale — template changelog

Tracks breaking changes to the `radicale` template's pod structure /
variable shape (not Radicale itself — that's versioned by the upstream
image tag). Each H2 corresponds to a value of `servicebay.schema-version`
in `template.yml`.

The ServiceBay update flow reads the section header(s) between the
operator's installed schema-version and the current one and surfaces them
in the re-deploy dialog. Each `(breaking)` section needs an explicit
acknowledgement before the deploy can proceed.

## v3 (breaking)

**Rights model swapped from `owner_only` to `from_file` (#2411).**

Radicale's access rules used to be the built-in `owner_only` module: every
authenticated user may touch their own `/<user>/` tree and nothing else. That
module cannot express a single cross-principal exception, so the household
automation account (`solaris`) had no way to write the shared calendar and
address book it maintains for each resident — and the rule that granted it had
to be hand-patched onto the running pod, where every re-render (an
`AutoUpdate=registry` image pull re-running `podman kube play --replace`) wiped
it again.

The `[rights]` section now reads `type = from_file` with `file = /config/rights`,
and the pod's `write-config` initContainer seeds that ruleset alongside
`/config/config` on every deploy — so it is part of the manifest and survives a
re-render. The ruleset is:

| Section | Who | What it grants |
|---|---|---|
| `[root]` | any authenticated user | read the root collection (`.well-known` discovery) |
| `[owner]` | any authenticated user | full read/write on their OWN `/<user>/` subtree |
| `[solaris-subcal]` | `solaris` only | read/write `<resident>/solaris` (shared calendar) |
| `[solaris-contacts]` | `solaris` only | read/write `<resident>/solaris-contacts` (shared address book) |

`[root]` + `[owner]` together are the equivalent of the old `owner_only`
module, so **a normal user's access is unchanged**: they still see exactly
their own collections, and no user can read another user's tree. The two
`solaris` sections are the only additions — a service account named `solaris`
(if one exists in LLDAP) can read/write those two named collections under any
principal, and nothing else. On a box with no such LLDAP account they grant
nothing.

Required action: **re-deploy** the radicale service so the initContainer writes
the new `/config/rights` and Radicale starts with `from_file`. Existing installs
keep `owner_only` until the pod is recreated. If you hand-edited
`/config/rights` on a running pod, note that it is now generated from the
template on every deploy — that copy is replaced (which is the point: a
hand-patched file did not survive a re-render either). Collections on `/data`
are untouched.

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
