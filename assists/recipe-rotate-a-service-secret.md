---
title: Rotate a service password or secret
whenToUse: A device cannot handle a generated password, a credential leaked, or you need a service's generated secret changed to a value you choose.
kind: recipe
tags: [secret, password, rotate, credentials, install, mqtt, device]
---

# Rotate a service password or secret

Every `type: "secret" | "bcrypt" | "rsa-private"` variable is generated at install
and saved in `config.installedSecrets`. On a later install a secret **nobody
supplied** comes back from that store, so a service whose data volume survived a
reset can still authenticate. That reuse is deliberate — but it fills a **gap**,
it does not overrule **input**.

## How to rotate

Supply the new value on an install of the template that owns it:

```
install_template(names=["<template>"], variables={ "<VAR>": "<new value>" })
```

The supplied value wins over the saved one, deploys, and is written back to the
store, so every later install without an explicit value reuses the **new** one.
The install log says so explicitly:

```
🔁 Applying the value you supplied for 1 secret variable (<VAR>) — it replaces
   the previously saved one. Anything still using the old credential will be
   rejected until you update it (#2574).
```

The wizard's Configure step behaves the same way: a secret field you type into
(or regenerate) is treated as supplied input, not a display of the stored value.

## After rotating

**Every client keeps using the old credential until you update it.** Rotate the
service first, then the consumers — a smart-lock/Zigbee bridge/Home Assistant
integration on the old password shows up in the service log as a rejected
connection (mosquitto: `Client <id> disconnected: not authorised`), not as an
error on the ServiceBay side.

## Gotchas

- **Never send back a read-masked value.** Reads mask secrets as `<redacted>`; a
  caller that re-sends that literal is refused (the stored secret is kept, or the
  deploy fails when there is none). Send the real value or omit the variable.
- **Pick a device-safe value when a device is involved.** Some firmware mangles
  punctuation in a password field. Plain alphanumeric, reasonable length, is the
  safe shape for locks, plugs and bridges.
- **A rotated encryption key is not a password.** Secrets that key an on-disk
  store (Authelia's storage encryption key, an OIDC signing key) cannot be
  rotated in isolation — the existing data was encrypted/signed with the old one.
  Treat those as a re-provision, not a rotation.
- **NPM (nginx-proxy-manager) is the one exception where the stored value wins.**
  Its admin password lives bcrypt-hashed inside its own restored database and it
  ignores `INITIAL_ADMIN_*` once seeded, so a supplied password cannot
  authenticate; the install says which credentials it kept. Change that one in
  NPM's own UI.
- `update_config` cannot do this — it exposes `logLevel`, `serverName`, `domain`,
  `autoUpdate` and `templateSettings` only. Rotation happens on the install path.
