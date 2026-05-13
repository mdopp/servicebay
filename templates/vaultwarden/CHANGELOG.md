# Vaultwarden — template changelog

## v2 (breaking) — #408

Vaultwarden now runs under `hostNetwork: true` instead of Podman's
bridge network. This is required for the SSO sign-in flow to work:
under bridge networking, the container resolves
`https://auth.<PUBLIC_DOMAIN>/.well-known/openid-configuration` to the
router's WAN IP and the OIDC-discovery request fails (most home
routers don't hairpin NAT). Under `hostNetwork` Vaultwarden inherits
the host's DNS resolver — AdGuard rewrites `*.<PUBLIC_DOMAIN>` to the
LAN IP, so discovery goes through NPM → Authelia and succeeds.

Operator impact: nothing on disk moved; the redeploy applies the new
pod definition and the SSO login starts working again. If you don't
use SSO (`VAULTWARDEN_SSO_ENABLED=false`), the change is still safe —
Vaultwarden now binds `VAULTWARDEN_PORT` directly on the host instead
of via Podman's port-forwarding shim, which is what NPM already
proxies to.
