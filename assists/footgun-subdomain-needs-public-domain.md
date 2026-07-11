---
title: Subdomain proxy host silently skipped when the template omits {{PUBLIC_DOMAIN}}
whenToUse: Your template declares a type:subdomain variable but no proxy host / route was created, and there's no error in the install log.
kind: footgun
tags: [subdomain, proxy, npm, public-domain, install, assembler, template]
---

# A subdomain host is skipped silently without a PUBLIC_DOMAIN reference

## Symptom
Your template has a `type: "subdomain"` variable, the install succeeds, but no
NPM proxy host / route exists for `<sub>.<domain>` — and **nothing** in the
install log says why.

## Cause
`buildProxyHosts` forms the FQDN from a `PUBLIC_DOMAIN` variable in the assembled
manifest. The manifest assembler injects a global (like `PUBLIC_DOMAIN` or
`DATA_DIR`) **only if the template's YAML references it** (`{{PUBLIC_DOMAIN}}`).
If nothing references it, `PUBLIC_DOMAIN` is absent, `domain` is `undefined`, and
`ensureProxyHosts` does `if (!domain) return;` — the host is dropped with no log.

## Fix
Reference `{{PUBLIC_DOMAIN}}` somewhere in `template.yml` so the assembler
injects it. A clean, useful place is a container env var:
```yaml
env:
  - name: PUBLIC_DOMAIN
    value: "{{PUBLIC_DOMAIN}}"
```
Re-assemble → the manifest now carries `PUBLIC_DOMAIN` → `ensureProxyHosts`
creates the `<sub>.<PUBLIC_DOMAIN>` host. Re-running the install is idempotent.

## Verify
After install, confirm the host exists AND nginx loaded it (see assist
`footgun-forward-auth-acme-collision` for the `nginx_online` / `nginx_err` check).
The proper fix (auto-inject PUBLIC_DOMAIN when any subdomain var exists, or warn
loudly) is tracked as a bug.
