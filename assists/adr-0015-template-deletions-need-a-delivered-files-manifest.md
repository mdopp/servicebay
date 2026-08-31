---
title: ADR 0015 — A template deletes only what it demonstrably delivered; the record is a delivered-files manifest
whenToUse: You are about to make a deploy, sync or reconcile pass remove files from a box — a mirroring sync, an rsync --delete, a "clean up what the template no longer ships", a stale-file cleanup — and need the rule for what may be deleted; or you are wondering why a file removed from a template's source tree is still on the node, or why an existing install did not converge after the fix.
kind: adr
tags: [adr, decision, install, deploy, templates, assets, deletion, destructive, manifest, user-data]
---

# ADR 0015 — A template deletes only what it demonstrably delivered; the record is a delivered-files manifest

## Status

Accepted (2026-08-31, #2703).

## Context

Asset transport — the mechanism that ships a template's `skills/` subtree to
`{{DATA_DIR}}/<service>/skills/…` — had **no deletion concept at all**. Adding
and updating a file worked; removing one from the source tree did nothing.

The measurement, taken on the live box after a deploy: two directories that had
been deleted from the template's source tree three commits earlier still stood
at mtime `2026-06-15`, while their siblings from the **same deploy** carried
`2026-08-31`. Same run, same directory: it updated the siblings and did not
apply the removals. Structurally confirmed — the only delete paths under
`packages/backend/src/lib/install/` are in `performStackReset.ts` (full stack
reset). **The deletion was never written, so it could never fail.**

Why this weighs more than "some stale files lie around": the two withdrawn
skills had been retired precisely because they told the model to confirm a write
it could not perform — a resident says "turn on debug", the answer is "it's on",
and nothing happens. They kept declaring `/audit` and `/debug` on the deployed
box after their retirement. **A template cannot retract its own malfunction**,
and that is true of every template on this platform, not just this one.

The obvious fix — mirror the source tree, `rsync --delete` or its equivalent —
is the wrong one, and the reason is specific rather than cautious. Files created
**at runtime live next to delivered ones**, in the very same directories: the
residents' notes, `solaris.db`, `.paperless-token`. In the affected project's
own words:

> A leftover stale file we can overwrite; a deleted note we cannot. Rather slow
> with a manifest than fast with `--delete`.

An exclusion list ("delete everything except these names") does not satisfy this
either: it becomes incomplete again with every new runtime file, and its failure
mode is a *deleted user file* rather than a leftover one.

## Decision

**Delete only what was demonstrably delivered.** The design priority is
inverted from the obvious one: not "delete as completely as possible, then add
exceptions", but "delete nothing that this mechanism did not itself put there".

1. **The delivered-files manifest is the entire delete authority.** After a
   complete delivery, `writeExtraConfigFiles`
   (`packages/backend/src/lib/services/extraConfigFiles.ts`) records the set of
   target paths it wrote, per node and service, at
   `DATA_DIR/delivered-files/<node>__<service>.json`. The next deploy deletes a
   path if and only if it is **in the previous manifest** and **absent from the
   current delivered set**.
2. **No live directory listing is ever consulted.** A listing cannot tell a
   stale template file from a file the running application created five minutes
   ago; consulting one is how a user file gets deleted. A path that was never
   recorded is not a delete candidate *by construction*, not by a per-filename
   exclusion.
3. **Deletion is per path.** A targeted `rm -f -- '<exact path>'` per stale
   entry — never a directory-wide `rm -rf`, never a `--delete` sync of the
   asset dir. The recorded path must still satisfy the same rule the boundary
   applies to a *write* target (`HostFilePath`: absolute, no `..`, no shell
   metacharacter, and at least three segments deep); a recorded path that does
   not is reported and kept, never removed.
4. **Only a caller that resolved the template's complete artifact set may
   prune.** The install runner sets `completeDelivery: true` on its
   `POST /api/services`; every other entry point (`update_service_yaml` sends no
   files, a hand-rolled `deploy_service` may send one config file for a template
   that also ships a skills tree) delivers a subset and must not have it read as
   "everything that still exists".
5. **Three refusals, each of which loses a deletion rather than risk a file:**
   - *No prior manifest ⇒ delete nothing.* See Consequences.
   - *An empty delivery never empties a non-empty manifest.* Template
     resolution degrades to `[]` on error, so "this template delivers no files
     at all" is far more often a failed registry read than a real removal of
     everything.
   - *Seed-only files are never recorded.* Their content belongs to the
     application or the operator from first install onward (ADR 0004, #2590), so
     dropping the declaration must not delete the file.
6. **A failed delete stays in the manifest** so the next deploy retries it,
   rather than being forgotten. A delete failure is logged, never fatal — a
   leftover file is the status quo, and the delivery already succeeded.

## Consequences

- **A retired file really is retired.** Deleting it from a template's source
  tree removes it from the node on the next install/redeploy of that template,
  so a withdrawn skill stops declaring its command. Template authors retire a
  file by deleting it — not by shipping an empty "tombstone", which is still a
  delivered file and would go on being offered by anything that lists the dir.
- **Existing installs do not converge on their own, and this is deliberate.**
  On the first deploy after this ships, no manifest exists for anything already
  on disk. Treating that as "everything not in the source was delivered" is
  `--delete` wearing a different hat and would take `solaris.db` with it. So the
  bootstrap deploy **only records**, and says so in the install log. Files
  orphaned by earlier deploys — on the box that prompted this, `audit-query` and
  `debug-set` — stay until an operator removes them. **That is a named unfixed
  case, not a fixed one:** from the recording deploy onward the mechanism
  converges, but the pre-existing orphans need a deliberate, operator-visible
  step.
- **The manifest is ServiceBay-side state, and losing it is safe.** It is not
  backed up separately and not reconstructible from the box; if it disappears,
  the next deploy sees "no prior manifest" and deletes nothing. Degradation is
  always toward *leaving a file*.
- A caller that starts sending `completeDelivery` without actually resolving the
  full artifact set would turn a partial delivery into a delete pass. That flag
  is the one place where a mistake becomes destructive, so it stays off by
  default and is set in exactly one place.

## Related

- [ADR 0004](adr-0004-installs-are-non-destructive.md) — installs are
  non-destructive to other data; this is the same rule applied inside a single
  service's own directory.
- [ADR 0012](adr-0012-repair-is-reconciliation-not-reinstallation.md) — a
  reconciler must know what it owns before it converges anything.
- `docs/TEMPLATE_AUTHORING.md` (asset directories) and `templates/CLAUDE.md`
  carry the template-author-facing half of this contract.
