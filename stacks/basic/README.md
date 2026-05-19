# Basic stack

ServiceBay's core platform services — the three templates every feature
stack depends on.

## Included Services

- [x] nginx — Nginx Proxy Manager: reverse proxy + Let's Encrypt certs
- [x] auth — LLDAP + Authelia: identity provider, SSO, family-account management
- [x] adguard — AdGuard Home: LAN DNS with split-horizon rewrites for `<sub>.<public-domain>`

This stack is `tier: core` — every feature stack's install is gated on
it being healthy. Wiping is gated behind FACTORY RESET (Settings → System
→ Factory Reset) so identity state and Let's Encrypt cert quota can't be
lost by accident.

Per-template details live in `templates/nginx/`, `templates/auth/`,
`templates/adguard/`.
