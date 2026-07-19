---
title: Writing another service's files — container→host uid mapping, foreign ownership, and locks
whenToUse: Your service needs to write into a store another on-box service owns (a CalDAV/CardDAV tree, a notes vault, another app's data dir) and the writes silently fail, files come out foreign-owned, or the owning app can't see/manage them.
kind: footgun
tags: [uid, subuid, userns, podman, permissions, cross-service, mount, ownership, lock, rootless]
---

# Writing another service's files: the uid-ownership reality

## Symptom
Your service writes a file into another service's store (say Radicale's
collection dir), the write appears to succeed or fails with `EACCES`, and then:
the owning app can't manage the file (it's foreign-owned), or a mode-644 lock
file (`.Radicale.lock`) blocks your writer, or the owning app's rights model
(`rights = owner_only`) rejects the record even though the file is on disk.

## Cause — container uid → host uid mapping under rootless Podman
Each service can run in its own user namespace, so the same in-container uid maps
to a **different host uid** per service:

- an app container running as **root** commonly maps to **host uid 1000** (the
  box's `servicebay` user);
- another service in its own userns maps to a **subuid range** — e.g. Radicale's
  container-root landed at host uid **527286**.

So a file your service writes into Radicale's tree is owned by *your* host uid,
which is **foreign** to Radicale. Radicale (running as its subuid) then can't
rewrite/lock/delete it, and combined with an owner-only rights model the record
silently never appears. The tree looks written; the owning app disagrees.

## The pattern — prefer the API, and if you must touch the filesystem, state the contract
1. **Prefer the owning service's protocol/API.** Radicale speaks CalDAV/CardDAV;
   write through DAV (as an authorized principal) instead of poking its files.
   Jellyfin/Immich/etc. have their own ingest APIs. The API respects the app's
   own ownership + rights model, so nothing is foreign-owned.
2. **If you must write its filesystem, make ownership explicit.** Either align
   uids (write as the owning service's host uid / subuid), or make the target
   tree **world-writable** and document that requirement in the template. Never
   assume "just write the file" — it depends on both userns maps matching.
3. **Watch the lock files.** A mode-644 `.<App>.lock` (or a flock the owning app
   holds) can block a foreign writer even when the dir permits writes. Honor the
   app's locking protocol rather than racing it.
4. **Disable relabel + pre-create the dir.** When mounting a foreign-owned tree
   under SELinux, prefer `type: Directory` over `DirectoryOrCreate` and disable
   the per-container SELinux relabel (relabel rewrites the owning service's
   labels). See `new-service-architecture` "Data storage".

Rule: **one writer per store.** If two services write the same tree without a
coordination model, the uid/lock friction above is guaranteed. See the
`data-authority` standard for the read-side equivalent (don't re-derive data the
owning service already indexes).
