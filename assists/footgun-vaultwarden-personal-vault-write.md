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
2. **No server-side write.** Hand the list to the human as a file, and drop your
   own copy in the *same operation* — so "they have it" and "we still hold it"
   are never both true. Repeat installs/rotations replace the entries and put
   them back into the not-yet-handed-over state, which is the honest one: the
   fresh secret has not reached the human yet.

**Never take the third option** — prompting for, storing, caching or deriving the
*operator's own* master password. It replaces one credential-hoarding problem
with a strictly worse one: that secret unlocks everything else in their vault too,
not just what you put there.

## ServiceBay tried shape 1 and reverted to shape 2 — read this before proposing it again

Shape 1 was built (#2519) and removed the same week (#2560). It works on paper;
what sank it is what shape 1 actually costs:

- **You end up re-implementing Bitwarden's key ladder.** PBKDF2/Argon2 → master
  key → stretched key → the protected symmetric key → per-item encryption. There
  is no server-side shortcut, because the whole point of the protocol is that the
  server can't do it. That is a lot of bespoke cryptography sitting at the exact
  point where a mistake means unreadable or unrecoverable credentials.
- **A faithful fake proves nothing.** The implementation passed against a mock
  vault and was never once run against a real Vaultwarden. Crypto that has only
  ever talked to your own test double is unvalidated crypto.
- **Shape 1 does not remove the read-back check either.** An HTTP 200 from the
  vault is not evidence a *readable* item exists — you still have to re-fetch and
  decrypt before deleting your copy, or the "posting plaintext is worse than an
  error" case above becomes silent data loss.

The generalisable lesson: when the failure mode is *lost credentials*, prefer the
hand-off that cannot break over the one that is convenient. Automation is worth
less than a delivery you can prove.

## If you take shape 2, gate the delete on evidence, not on a click

The trap in shape 2 is deleting your copy because the user pressed Download. A
click is not delivery — the browser can refuse the save, the transfer can
truncate, the tab can close. Issue the file with a one-shot token, have the
client send back a checksum **it computed over the bytes it saved**, and delete
only when that matches what you handed out. Every failure then leaves the secret
exactly where it was.

## Reference in this repo

- `packages/backend/src/lib/stackInstall/credentialsHandover.ts` — the
  issue/redeem pair, and the write-up of what the receipt does and does not prove.
- `packages/backend/src/lib/stackInstall/credentialsManifest.ts` —
  `isCredentialSecured` (state derived from the absent password, not a separate
  marker), `dropDeliveredPasswords`, `credentialReceipt`.
- `packages/frontend/src/components/CredentialHandoverGate.tsx` — the blocking
  hand-over, and why it lives in the layout so a headless install is covered.
- `templates/vaultwarden/` — the deployed instance. Note it sets no `ADMIN_TOKEN`.
