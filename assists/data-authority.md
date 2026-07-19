---
title: Data authority — consume the canonical index, one writer per store
whenToUse: You are building a service that reads or writes a dataset another on-box service already owns (the media library, photos, calendars/contacts, notes) and want the standard so you don't become a redundant reader/writer of the same ground truth.
kind: checklist
tags: [data, authority, canonical, index, one-writer, reuse, cross-service, standard]
---

# Data authority

A dataset on the box usually has an **authoritative owner** — the service that
indexes and manages it. This standard steers a new service away from becoming a
redundant Nth reader/writer of the same ground truth. It complements
`new-service-architecture`'s "reuse what's there" (which is about *capabilities*)
with the equivalent for *data*.

1. **Consume the canonical index, don't re-scan.** If another on-box service is
   already authoritative for a dataset — Jellyfin for the media library, Immich
   for photos, Radicale for cal/contacts — read *its* index/API rather than
   re-deriving from the raw files. Re-scanning duplicates work, re-implements the
   messy parsing (tags, compilations, dedupe) the owner already solved, and
   diverges from the owner's view over time.

2. **One writer per store, or an explicit coordination model.** Don't become a
   second writer to a shared store without an ownership/locking story. Prefer the
   owning service's API; if you must touch its filesystem, document the
   ownership/permission contract — this is exactly where the uid/lock friction in
   the `footgun-cross-service-uid-writes` assist bites.

3. **State the data-authority map in the design.** For each dataset the service
   reads or writes, name **who is authoritative** and **how you reach it** (its
   API/protocol, or the filesystem contract if there's no other way). If the map
   shows you re-deriving or double-writing data an existing service owns, that's a
   signal the capability might belong *in* that service (or in Solaris) rather
   than as a new service — decide that before building.

Related: `new-service-architecture` (where should it live / reuse what's there),
`footgun-cross-service-uid-writes` (the write-side permission contract), and the
`report-standards-gaps` convention.
