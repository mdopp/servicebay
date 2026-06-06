# auth template changelog

## v2

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
