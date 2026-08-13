---
title: You cannot write into a personal Vaultwarden/Bitwarden vault with an API key
whenToUse: You are about to build automation that pushes credentials into Vaultwarden (or Bitwarden) — a sync job, an install hook, a "store this password for the user" feature.
kind: footgun
tags: [vaultwarden, bitwarden, credentials, secrets, api, sync, password-manager]
---

# Writing into a Vaultwarden vault is not an API-key problem

The obvious plan — "issue an API key, POST the login item, done" — does not work
for a **personal** vault, and the failure is at the protocol level, not a config
you can flip. Establish this *before* designing the feature; it changes the shape
of the whole thing.

## What an API key actually gets you

A personal API key (`client_id` / `client_secret`) exchanges for an access token
via `grant_type=client_credentials` on `/identity/connect/token`. That token
**authenticates** you. It does **not** unlock the vault.

Vault items are encrypted client-side with a symmetric user key. The user key is
itself wrapped by a key derived from the **master password** (PBKDF2/Argon2 over
password + email). The server never sees either. So to create an item that the
web vault can later read, the writer must possess the master password (or a
session key derived from it in a prior unlock).

The Bitwarden CLI states the same thing operationally: `bw login --apikey`
succeeds and leaves the vault **locked**; you still need `bw unlock` with the
master password before `bw create item` works. Vaultwarden reimplements this
protocol, so it behaves identically.

Two dead ends worth naming so nobody re-explores them:

- **The admin API is not a way in.** `/admin` (behind `ADMIN_TOKEN`) manages
  users, orgs, collections and policies. It cannot create cipher items — there is
  no server-side path to a decryptable item, by design.
- **Posting plaintext "works" and is worse.** Vaultwarden stores cipher fields as
  opaque strings and will accept an unencrypted `name`/`password`. The web vault
  then fails to decrypt them — you get garbage rows in the user's real vault
  rather than an error you can catch.
- **SSO does not help.** Vaultwarden's OIDC login still requires the master
  password to decrypt the vault; there is no Key Connector equivalent.

## The consequence for design

There are exactly two shapes, and the choice is the operator's, not yours:

1. **A dedicated service account.** Generate a master password for an account
   your system owns, hold it as a `type: "secret"` variable, unlock per sync, and
   write into an **organization collection** shared with the humans. Blast radius
   is bounded: that vault holds only what the automation put there. This is the
   only shape with real automated writes.
2. **No server-side write.** Export (Bitwarden CSV) + the vault's import
   deep-link, but make it **tracked**: persist a per-entry `securedAt` marker, and
   have the hand-off confirmation drop your local copy of the secret in the *same
   write* so "secured" and "we still hold it" are never both true. Repeat
   installs/rotations replace the entries and therefore clear the marker, which is
   the honest state: the fresh secret is not in the vault yet.

**Never take the third option** — prompting for, storing, caching or deriving the
*operator's own* master password. It replaces one credential-hoarding problem
with a strictly worse one: that secret unlocks everything else in their vault too,
not just what you put there.

Shape 2 is a real deliverable on its own: dropping the password column and
tracking hand-off state is most of the security win, and its state model is the
same one shape 1 would write into later.

**ServiceBay took shape 1** (owner decision 2026-08-13). The operator-facing
setup is `recipe-vaultwarden-servicebay-push`; the implementation lives under
`packages/backend/src/lib/vaultwarden/`. One thing shape 1 does *not* remove:
the read-back check. An HTTP 200 from the vault is not evidence that a
*readable* item exists — re-fetch it and decrypt it before deleting your own
copy, or the "worse than an error" case above becomes a silent data loss.

## Reference in this repo

- `packages/backend/src/lib/stackInstall/credentialsManifest.ts` — `Credential.securedAt`,
  `markCredentialsSecured`, `summarizeCredentialSecurity`.
- `packages/frontend/src/app/api/system/credentials/secured/route.ts` — the
  hand-off confirmation that drops the local secrets.
- `templates/vaultwarden/` — the deployed instance. Note it sets no `ADMIN_TOKEN`.
