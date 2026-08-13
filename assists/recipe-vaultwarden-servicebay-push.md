---
title: Give ServiceBay its own Vaultwarden account so credentials push automatically
whenToUse: An operator wants ServiceBay to write install credentials into Vaultwarden by itself, or the Settings page says "Automatic push is not set up" / a push failed with org_unavailable or auth_failed.
kind: recipe
tags: [vaultwarden, bitwarden, credentials, secrets, sync, setup, organization]
---

# Set up the automated credential push

ServiceBay can write the passwords it generates during an install straight
into Vaultwarden and then **delete its own copy**. To do that it needs an
identity of its own. It does **not** get yours: writing into a personal
vault needs a master password, and that key opens everything else in it —
see `footgun-vaultwarden-personal-vault-write`.

So the shape is: a **dedicated technical account** that owns nothing, and a
**shared organization collection** the humans can read.

## Why the operator does this by hand

The account, the organization and the collection are **not** created by
ServiceBay, deliberately:

- creating an account needs open signups, which is exactly the setting a
  household is told to turn off after first login;
- putting *you* into the organization afterwards needs an invitation you
  accept with your own keys — no server-side automation can complete it.

An organization only the automation can read would be worse than none: the
credentials would look "secured" while nobody could ever get at them. Four
minutes of clicking buys a vault everybody can actually open.

## Steps

1. **Create the technical account.** In the web vault, sign out and
   register a second account, e.g. `servicebay@<your-domain>`.
   - Generate a long random master password (30+ chars). No human ever
     types it; keep a copy in your *own* vault for disaster recovery.
   - Set the account's KDF to **PBKDF2** in *Settings → Security → Keys*.
     Argon2id cannot be computed by the control plane and the push refuses
     it by name rather than pushing something unreadable.
   - Turn signups back off afterwards (the template variable
     `VAULTWARDEN_SIGNUPS`).
2. **Create the organization** (from your own account, so you own it) and
   inside it a **collection**, e.g. "ServiceBay".
3. **Invite the technical account** into the organization, give it access
   to that collection with *can edit*, and confirm the member. Without
   SMTP configured, accept the invitation from the technical account's own
   session — Vaultwarden shows it on login.
4. **Copy the two ids** out of the web-vault URL while the collection is
   open: the organization id and the collection id (both UUIDs).
5. **Hand them to ServiceBay** in *Settings → Saved credentials → Set up
   automatic push*: account e-mail, master password, organization id,
   collection id. The password is write-only — it is stored encrypted and
   never sent back to a browser.
6. Press **Push to Vaultwarden now**. Every entry that lands is read back
   and decrypted before ServiceBay drops its local copy, so what the table
   says is what the vault holds.

## What each failure means

| Settings says | What is wrong |
|---|---|
| **not_configured** | steps 1–5 not finished, or Vaultwarden isn't installed on this box |
| **auth_failed** | wrong e-mail/master password for the technical account |
| **org_unavailable** | the technical account isn't a confirmed member of that organization, or the id is wrong |
| **crypto_unsupported** | the account was created with Argon2id — re-create it with PBKDF2 (step 1) |
| **unreachable** | the box's Vaultwarden isn't answering on its host port |
| **verify_failed** | the item was accepted but could not be read back — ServiceBay kept its copy on purpose |

Nothing here is a silent state: every one of them leaves the affected
entries marked **not yet secured** with their password still on the box.

## Rotating the technical account's password

Change it in the web vault, then re-save it in the same Settings form.
Already-pushed items are unaffected — they are encrypted with the
*organization* key, not with the account's password.

## Where this lives in the code

- `packages/backend/src/lib/vaultwarden/crypto.ts` — the key ladder.
- `packages/backend/src/lib/vaultwarden/client.ts` — login, upsert,
  read-back verification; addressing per ADR 0007 Decision 3.
- `packages/backend/src/lib/vaultwarden/sync.ts` — what gets pushed and
  when the local copy is dropped.
- `config.credentialVault` — the stored account (the `password` field is
  inside `SENSITIVE_KEYS`, so it is encrypted at rest and redacted from
  scoped-token reads).
