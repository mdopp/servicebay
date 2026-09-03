---
title: Writing another service's files — container→host uid mapping, foreign ownership, and locks
whenToUse: Your service needs to write into a store another on-box service owns (a CalDAV/CardDAV tree, a notes vault, another app's data dir) and the writes silently fail, files come out foreign-owned or root-owned after a sudo retry, the owning app can't see/manage them, or the consuming pod's next kube play --replace fails to relabel with lsetxattr "operation not permitted".
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

## The escalated-write repair, and its blind spot
A writer that retries a failed unprivileged write **with sudo** succeeds, but
leaves the file — *and every parent directory the escalated write had to create*
— owned by **root**. A root-owned path inside a rootless pod's volume breaks that
pod's next `podman kube play --replace`: rootless podman cannot `lsetxattr`
(relabel) a path it does not own, so the volume relabel fails with `operation not
permitted` and the pod will not restart. Often masked by `Restart=on-failure`
retrying five seconds later — which is why it is usually found as "the first
start attempt always fails".

The repair is to chown the escalated write's leftovers back to the uid the
siblings carry, and the sharp edge is **choosing the reference**:
`chown --reference=<the file's parent dir>` is a **no-op** exactly when it
matters, because for a newly created subdirectory the same sudo write created
that parent as root too. Walk **up past every root-owned ancestor**, take the
first non-root directory as the reference, and repair the whole chain from below
it down to the file. That also heals a directory an earlier run left root-owned,
instead of adopting its ownership. Bound the walk (refuse a reference above the
service's own tree) so a probe that keeps walking cannot chown a shared parent.

Rule: **one writer per store.** If two services write the same tree without a
coordination model, the uid/lock friction above is guaranteed. See the
`data-authority` standard for the read-side equivalent (don't re-derive data the
owning service already indexes).
