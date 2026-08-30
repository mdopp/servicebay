# Claude Dev — template changelog

Tracks breaking changes to the `claude-dev` template's pod structure /
variable shape (not the Claude Code CLI itself — that's versioned by the
image tag). Each H2 corresponds to a value of `servicebay.schema-version`
in `template.yml`.

The ServiceBay update flow reads the section header(s) between the operator's
installed schema-version and the current one and surfaces them in the re-deploy
dialog. Each `(breaking)` section needs an explicit acknowledgement before the
deploy can proceed.

## v3

**The container now serves its own configuration UI (#2678).**

`claude.<your domain>` (the new `CLAUDE_DEV_CONFIG_SUBDOMAIN`) opens a small web
page served by the claude-dev container itself. This first release is the shell
only — the header, the sidebar and an empty content area. The pages that go into
it (your projects, adding and removing one, signing in to GitHub, restart and
repair buttons) arrive in the following updates and appear in the sidebar as
they land.

**Nothing about your SSH access, your workspace or your Claude sessions
changes.** No data is moved and there is no migration to run — re-deploy and the
new subdomain is there.

**Who can open it.** The same people who can already SSH in: the reverse proxy
sends every visitor to the box's normal sign-in page first, and the UI then
accepts only members of `CLAUDE_DEV_LDAP_GROUP` (`admins` by default). Anyone
else gets a refusal, not a page. The UI's port is published on the box's own
loopback address only, so it cannot be reached from the LAN without going
through the proxy and the sign-in.

**What it may do on your behalf.** It reuses the read-only ServiceBay token this
container was already given at install time (`SERVICEBAY_MCP_TOKEN`, v2.x) — no
new credential is created, and the token stays inside the container: it is never
sent to your browser.

## v2 (breaking)

**Moved off `hostNetwork` into an isolated network namespace (#2522).**

The pod used to run `hostNetwork: true`, so sshd bound `CLAUDE_DEV_SSH_PORT`
directly on the host. That also meant a session in this container — a general
shell with a Claude Code session running unattended in it — could reach every
other service port on the box, and ServiceBay's own control API, over
`127.0.0.1`. `claude-dev` was never on ADR 0007's closed carve-out list; per
[ADR 0007](../../docs/adr/0007-container-network-isolation-and-carveouts.md)
Decision 1 it is migrated rather than added to it.

**Your SSH access does not change.** The port is now published with an explicit
`hostPort` on the *same* port number and with no `hostIP`, so podman binds it on
`0.0.0.0` — the same reachability the `hostNetwork` bind had:

- the router/FritzBox port-forward you already have keeps working, unchanged;
- `ssh -p <port> <user>@<box>` on the LAN keeps working, unchanged;
- the Claude Code mobile app connection keeps working, unchanged;
- the SSH **host keys** live on the persistent `/workspace` volume, so there is
  no `known_hosts` warning after the re-deploy.

**LDAP login keeps working, over a different address.** The container binds
LLDAP for SSH logins. LLDAP lives in the `auth` pod, which is a named
`hostNetwork` carve-out, so it listens on the *host* — an isolated pod cannot
reach it on `127.0.0.1`, and rootless podman refuses the host's own LAN IP. The
bind target is therefore `host.containers.internal`, the name podman writes into
every container's `/etc/hosts`. This is the same address Radicale's `ldap_uri`
and the media stack's Jellyfin LDAP-Auth config already use.

Nothing in the `auth` stack has to change first: LLDAP's raw LDAP port is
deliberately left bound to every interface, and its LAN half is closed one layer
down by the `blockLanAccess: true` nftables rule, which accepts traffic arriving
on `lo` — where the pasta-proxied pod path lands — and drops physical interfaces
(#2388). ADR 0007's *siblings first, consumer second* order is already satisfied.

**Variable removed: `LLDAP_HOST`.** It is no longer a variable at all; the pod
carries `host.containers.internal` as a literal. `LLDAP_HOST` is a shared
variable owned by the `auth` stack, and ServiceBay's install assembler
force-resolves it to `localhost` for every template — correct for the
`hostNetwork` `auth` pod, but it would silently overwrite the value here and
break every LDAP login. `LLDAP_LDAP_PORT`, `LLDAP_BASE_DN`,
`LLDAP_ADMIN_PASSWORD` and `CLAUDE_DEV_LDAP_GROUP` are unchanged.

**One behavioural difference worth knowing:** sshd now sees connections arriving
from the pod's gateway address rather than the client's real LAN address, because
the connection is proxied into the namespace. Nothing in this template
authenticates or filters on source IP (logins are gated by SSH key, the LLDAP
bind, an nslcd `memberof` filter and sshd `AllowGroups`), so no access rule
changes — but `/var/log/auth.log` inside the container will show the gateway
address instead of the client's.

Required action: **re-deploy** the `claude-dev` service so podman recreates the
pod from the v2 manifest. Nothing on disk moves — `/workspace` (git checkouts,
`~/.claude` history, `gh` auth, per-user homes, SSH host keys) is untouched. The
local `dev` break-glass account is unaffected and remains the fallback if the
LDAP path ever misbehaves.
