# auth template changelog

## v3 (breaking)

**LLDAP's admin web UI bound to loopback — no longer LAN-exposed (#2380).**

Required action: **re-deploy** the `auth` service so podman recreates the pod
from the v3 manifest. Existing installs keep the old `0.0.0.0` bind until the
pod is recreated — the running container was started from the v2 manifest and
does not auto-rebind.

LLDAP defaults its HTTP server (`http_host`) to `0.0.0.0`, and because the
`auth` pod runs `hostNetwork: true` that means **every host interface**. So
LLDAP's admin web UI *and* its `/api/graphql` user-management API answered
directly at `http://<box-lan-ip>:17170/`, never reaching nginx and therefore
never reaching Authelia's forward-auth gate (admin group + two-factor). Any
device on the LAN — a compromised IoT gadget, guest Wi-Fi, malware on a shared
laptop — could enumerate or brute-force the identity store's admin account
regardless of how correctly forward-auth was configured, and Fedora CoreOS
ships with no firewall enabled.

This release sets `LLDAP_HTTP_HOST=127.0.0.1` on the lldap container. That is
the `hostNetwork` equivalent of the `hostIP: 127.0.0.1` port publish radicale
got in #2357 — a `hostNetwork` pod publishes no ports, so the bind address has
to come from the app's own config. The downstream half is the same as #2357:
nginx also runs on `hostNetwork`, so it still reaches LLDAP over the host
loopback, and `LLDAP_SUBDOMAIN` now carries `loopbackOnly: true` so
`ldap.<domain>` forwards to `127.0.0.1:17170`. An existing `ldap.<domain>`
proxy host is re-pointed automatically on this deploy by ServiceBay's core
reconcile (#2364) — no manual proxy edit.

`ldap.<domain>` keeps working exactly as before, and so do ServiceBay's own
LLDAP calls (its container uses host networking and talks to
`http://localhost:17170`) and the template's `post-deploy.py` / migration
scripts (they run in the host netns, ADR 0007). Only the direct-on-LAN path is
closed. After the re-deploy, `curl http://<box-lan-ip>:17170/` from another LAN
host is refused while `https://ldap.<domain>/` still serves normally.

**Not covered:** the raw LDAP port (`LLDAP_LDAP_PORT`, default 3890) is
unchanged and still bound to every interface. It cannot be loopback-bound
without breaking radicale's `ldap_uri` and Jellyfin's LDAP-Auth plugin —
isolated pods reach it via `host.containers.internal`, which rootless
podman/pasta maps to the host's LAN address rather than loopback. Restricting
it needs host-level packet filtering and is tracked separately as #2388.

## v2

Portal-direct login now has a landing page (#1742).

Added a per-cookie `session.cookies[].default_redirection_url` pointing at
`https://www.<domain>/`. Without it, a login started from the portal itself
(logout then login, with no originating `rd` parameter) had nowhere to go
after 1FA/2FA and left the user sitting on the portal. The target is a
`*.<domain>` subdomain authorized for `group:family` under the wildcard
access_control rule — not the bare apex, which is default-deny (ADR 0006) and
would 403. App-originated logins that carry an `rd` parameter still honour it;
`default_redirection_url` is only the no-`rd` fallback, so this is
non-regressive. Config-only — no pod/variable/data change, no schema bump.

LLDAP-readiness gate on the Authelia container (#1737).

Authelia and LLDAP are containers in the same pod, which podman starts in
parallel — so Authelia could win the race, fail its startup LDAP check
against a not-yet-listening LLDAP, and exit fatally. systemd `Restart=`
recovered it, but every restart/reboot/redeploy opened a brief SSO outage
window.

The Authelia container now waits for LLDAP's LDAP socket to be open before
starting, then hands off to the image's normal entrypoint. The probe is
`nc -w 1 localhost <port> </dev/null` (the authelia image's BusyBox `nc` has
no `-z` flag, so the original `nc -z` probe never succeeded and just stalled
to the cap): it breaks the loop on the first successful connect, so a ready
LLDAP proceeds in ~1s. Bounded to ~120 attempts so a genuinely-down LLDAP
surfaces a clear failure (and systemd `Restart=` retries) rather than hanging.
No fatal startup crash, no outage window on restart.

Transparent to the operator — no action required, no data move.
