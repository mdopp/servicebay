# auth template changelog

## Unversioned — the admin-only rule now covers the claude-dev surfaces (#2936)

No schema bump: nothing on disk moves and no variable changes, so this reaches
an installed box on the next **Reconfigure / redeploy of `auth`**, which
re-renders `configuration.yml`. Until then the running rules are whatever is on
disk — on a box that already publishes `pi.<domain>` or `claude.<domain>`, edit
the two rules by hand first and let the redeploy converge later.

`claude.<domain>` (claude-dev's own configuration UI) and `pi.<domain>` (its pi
web chat) were named in neither the admins-only rule nor its explicit-deny twin,
so both fell to the `*.<domain>` `one_factor` catch-all: **any** household
`family` account reached them from the internet with a password and no second
factor. `pi` carries no sign-in of its own, so that verdict was the entire
authorization decision for an interactive coding agent with a bash tool running
as `dev` inside the claude-dev container — beside the box's ServiceBay token and
the operator's Claude and GitHub credentials. Both hosts are now in the
admins-only `two_factor` rule **and** in the deny twin.

The rule table is also now a checked contract rather than a remembered one: a
template declares a subdomain's reach with `"audience": "admin" | "family" |
"anonymous"` in its `variables.json`, and the build fails if a declaration and
these rules disagree, or if a `subdomain` variable declares nothing at all.

## Unversioned — session lifetime is one month (#2830)

No schema bump: nothing on disk moves and no variable changes, so this reaches
an installed box on the next **Reconfigure / redeploy of `auth`**, which
re-renders `configuration.yml`. The session secret is unchanged, so nobody is
kicked out by the redeploy itself; a session already open keeps whatever expiry
it was issued with, and the next sign-in gets the new one.

`session.expiration`, `session.inactivity` and `session.remember_me` were unset,
so Authelia's defaults applied — **1 hour** total and **5 minutes of
inactivity**. A household dashboard is used exactly the way that punishes:
open it, glance, put the phone down, pick it up after dinner, sign in again.
All three are now `1M`.

**This is an operator trade-off, not a hardening oversight** (decided
2026-09-06). With a month-long session the phone's *device lock* is the
effective protection in front of Solaris — door lock and garage door included —
rather than the Authelia login. It is written down here so nobody later reads
the long session as a mistake and "fixes" it.

One footgun for whoever revisits this: `inactivity: 0` looks like the way to
switch the inactivity check off, and Authelia's request path does skip the check
at 0 — but its config validator rewrites any `inactivity <= 0` back to the
5-minute default before that path ever sees it. Setting 0 would quietly restore
the original bug. `inactivity: 1M` is what actually retires it.

## v4 (breaking)

**The `servicebay` OIDC client secret is now generated per install (#2417).**

Required action: **re-deploy** the `auth` service. The rotation happens during
that deploy; nothing on disk moves.

Authelia's `servicebay` OIDC client — the one behind ServiceBay's own
"Login with Authelia" button — shipped a **hardcoded** `client_secret` baked
into `configuration.yml.mustache`. Every install in the world had the same
value, and anyone could read it out of the public repository. That client is
`authorization_policy: two_factor` and redirects to the admin panel, so the
secret guarding the box's control plane was a published constant. Every other
SSO-wired template (`HA_OIDC_SECRET`, `IMMICH_SSO_SECRET`,
`VAULTWARDEN_SSO_SECRET`) already did this correctly; this one was the outlier.

v4 adds `SERVICEBAY_OIDC_SECRET`, a `type: "secret"` variable generated once
per box, stored encrypted in `config.installedSecrets`, and reused verbatim on
every later deploy.

**How the two sides stay in agreement.** The secret has to match in two places
or the SSO button fails with `invalid_client`: Authelia's `configuration.yml`,
and ServiceBay's own `config.oidc.clientSecret` (the value the callback route
posts to the token endpoint). There is no transaction spanning both, so the
ordering is chosen so that no failure can lock anyone out:

1. The fresh render owns the `servicebay` client, so the new value replaces the
   old literal in `configuration.yml`. (`mergeAutheliaOidcClients` never rotates
   an *incrementally registered* client's secret — the #1559 invariant — and
   `servicebay` is the one deliberate exception, because this template declares
   it.) Other services' clients are preserved untouched, secrets included.
2. **Only after** that file has landed and the pod is back does ServiceBay read
   the secret back out of it and copy it into `config.oidc.clientSecret`.

ServiceBay follows the file; it never leads it. So a deploy that fails before
the config lands changes nothing — the box keeps its old, still-consistent pair
and SSO keeps working. A crash in the narrow window between the two steps leaves
a mismatch that is recoverable, not sticky: the copy is idempotent and re-runs
on every `auth` deploy.

**Break-glass.** `/login` also offers a local admin username/password form that
has nothing to do with OIDC — that is the second door, and it is unaffected by
this change. ServiceBay refuses to start the rotation at all (aborting the
deploy before writing anything) on a box that has neither a stored admin
password hash nor `SERVICEBAY_PASSWORD` set, since SSO would then be the only
way in.

Existing browser sessions stay valid; only new SSO logins use the new secret.
Other services' users are unaffected.

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
