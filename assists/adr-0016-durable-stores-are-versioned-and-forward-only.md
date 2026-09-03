---
title: ADR 0016 — Durable JSON stores declare a version; migrations are forward-only and a newer file is refused loudly
whenToUse: You are about to add or change a durable JSON store under DATA_DIR — a new file, a renamed or removed field, a shape that has to hold both the old and the new form — or you are wondering why a store refuses to load with "only understands version N", why a reader is full of ad-hoc "if the old shape, then…" branches, or whether to stamp a schema-version number into a config document.
kind: adr
tags: [adr, decision, backend, storage, persistence, migration, schema, versioning, data-loss, durability, upgrade, downgrade]
---

# ADR 0016 — Durable JSON stores declare a version; migrations are forward-only and a newer file is refused loudly

## Status

Accepted (2026-09-03, #2739).

## Context

ServiceBay keeps roughly 28 small JSON documents under `DATA_DIR`: the config,
the node list, health checks, manual network edges, approval queues, boot
breadcrumbs, install jobs. They are the operator's data — losing one re-onboards
the box or drops every configured check — and they are the only copy.

Two halves of the problem, and only one of them was solved.

**Writing them was made crash-safe** in #2414: `lib/util/atomicWrite.ts` (tmp →
fsync → rename) is the sanctioned primitive, and `check-invariants.ts` holds a
`DURABLE_STATE_BARE_WRITE_BUDGET` of 0 over the modules that own durable state.
A crash mid-write leaves the previous file intact.

**Changing their shape had no mechanism at all.** Schema validation was one
`.passthrough()` shape in `lib/store/schema.ts`; there was exactly one migration
in the whole backend (`config.ts`'s `migrateConfig`). Every other shape change
was either caught ad hoc in the reader — a scatter of "if the field is missing,
assume…" branches whose provenance nobody can reconstruct a year later — or not
caught at all, which shows up on a box as a page that renders empty or a
subsystem that quietly starts from scratch.

The obvious-looking fix had already been tried and had already failed. A
`CURRENT_SCHEMA_VERSION` ledger stamped a `schemaVersion` into `config.json`; the
constant was `1` for its entire life and **nothing ever branched on it**. It was
deleted in #2725. That is the instructive part: a version number is worthless
unless something *reads* it and *acts*. The number is not the mechanism; the
migration chain is.

The second failure mode is quieter and worse. A box that is rolled back — a
downgrade, a restore, a `:dev` channel flip back to `:latest` — runs an older
build against a file a newer build wrote. Without a version check, the old build
reads what it can, ignores what it does not recognise, and then **saves**. The
fields it did not understand are gone. That is silent, permanent data loss
performed by a piece of software behaving exactly as written.

## Decision

**A durable store declares itself. `defineStore({ name, schema, version, migrations })`
(`packages/backend/src/lib/store/defineStore.ts`) is the only sanctioned way to
own a JSON document under `DATA_DIR`.** Stores are adopted onto it one at a
time; the adopted set is a forward-only ratchet in `check-invariants.ts`
(`VERSIONED_STORE_MODULES`), not a big-bang conversion.

Four rules, in the order they matter:

1. **Older is migrated forward.** A file at version *f* is pulled through
   `migrations[f+1] … migrations[version]`, in order, and only then validated
   against the schema. Every step from 1 to the current version must exist; a gap
   is an error naming the missing step, not a skip.

2. **Migrations are forward-only.** There is no down-migration and none will be
   added. A downgrade path doubles the number of transformations to write and
   test, and it is exercised approximately never — so it would be the code that
   is wrong when it finally runs, on the box, during a rollback, on the
   operator's only copy.

3. **Newer is refused, loudly.** A file at a version this build does not
   understand throws `StoreVersionError` on read **and on write**. The write
   guard is the one that actually prevents the loss: a reader that degrades
   gracefully still destroys the file on the next save. The message names the
   store, the file, both versions, and the way out (upgrade, or restore a backup
   this version wrote).

4. **A file with no envelope is version 0.** Every store file that exists on a
   box today predates this mechanism. Adopting a store therefore always means
   registering a `migrations[1]` that says, in code, what the pre-adoption
   on-disk shape was. Adoption is not a flag day: the old file keeps loading, and
   the next write re-stamps it.

The on-disk form is an envelope — `{ "__store": <name>, "version": <n>, "data": … }` —
so the version travels with the data rather than living in a side-channel or a
field inside the payload (which is what made the `CURRENT_SCHEMA_VERSION` ledger
both invisible and unremovable). A file stamped with a different store's name is
refused rather than reinterpreted.

Writes stay on `atomicWriteFile` / `atomicWriteFileSync`; `defineStore` wraps
them, it does not replace them. An adopted store therefore stays inside
`DURABLE_STATE_MODULES` and its bare-write budget of 0 — the invariant check
enforces that pairing.

**What degrades and what does not.** A missing file reads as the store's
declared fallback; a byte-corrupt file reads as the fallback with a warning,
because random corruption is not a downgrade. A newer version, a missing
migration step, a payload that fails the schema after migration — all three
throw. They are bugs in the migration chain or in something that hand-edited the
file, and quietly starting over is precisely the outcome this ADR exists to
prevent.

## Consequences

- **Adding a field is free; removing or renaming one costs a migration.** Bump
  `version`, add `migrations[n]`, done. If you find yourself writing "if the old
  field is present, use it" in a reader, that branch belongs in a migration
  instead — the reader should only ever see the current shape.

- **A rollback fails visibly.** An operator who downgrades onto a newer store
  file gets a clear refusal instead of a subsystem that comes up empty. This is
  the intended trade: loud beats convenient when the alternative is silent data
  loss. Box-verify for any store change should check both directions — an old
  file still boots and its data survives; a hand-bumped future version makes the
  app refuse rather than reset.

- **Adoption is incremental and ratcheted.** `VERSIONED_STORE_MODULES` may only
  grow, and a listed module that stops calling `defineStore`, moves without
  updating the list, or drops out of `DURABLE_STATE_MODULES` fails
  `npm run check:arch`. Un-adopting a store requires lowering
  `VERSIONED_STORE_MIN` — a visible, deliberate edit, not a quiet deletion.

- **Do not stamp a version into a payload again.** `CURRENT_SCHEMA_VERSION` /
  `config.schemaVersion` is a settled question (#2725): a number nobody branches
  on is decoration in the operator's data. The envelope is where a version goes.

- **Not everything under `DATA_DIR` is a store.** Log files, the audit ring,
  SQLite databases, per-run directories and delivered caches (the assist catalog)
  are outside this decision. It covers documents that hold operator state whose
  shape can change.
