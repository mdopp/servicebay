---
title: The systemd journal is a rotating buffer, not an archive — a service that must reconstruct its own past writes its own log
whenToUse: You are about to rely on `journalctl` as the record of something that happened more than a few days ago (a failed run, an audit trail, "what happened to my request last week"), or you are sizing/quoting a journal retention window before you've checked the actual knobs.
kind: footgun
tags: [journal, journalctl, retention, logging, durable-logging, observability, systemd-journald]
---

# The journal is a buffer, not an archive

**Answer first:** `journalctl` retention is governed by two config knobs —
`SystemMaxUse=` and `MaxRetentionSec=` in `journald.conf` (or a drop-in) —
**not by an assumed calendar window**. The commonly-quoted default cap (a few
GB) is a **size ceiling**, not a promised number of days. Whichever limit is
hit first — the size cap or the retention period — rotates the oldest entries
out. Check the actual values with `journalctl --disk-usage` and the unit's
config, rather than assuming a number.

## Why "the journal goes back N days" is the wrong question

The journal is **one shared ring buffer for every unit on the box**. It does
not allocate retention per-service — every unit's entries compete for the same
capped space. A high-volume unit therefore evicts its **own** oldest entries
long before a quiet unit's entries fall off the same buffer, even though both
live in the identical journal with the identical nominal cap.

Concretely, on a real size-capped box: the whole-box journal's oldest entry
was roughly **10x further back** than the oldest entry belonging to one
high-volume unit — same physical ring buffer, wildly different *effective*
retention depending on how noisy the unit was. Asking "how far back does the
journal go?" without naming a unit gets you the noisiest denominator's answer,
not yours.

This has bitten more than one service on this box independently: each assumed
the whole-box retention window applied to its own history, and each found out
— only when it needed the evidence — that its own entries were gone at a
small fraction of that window.

## The rule

**A service whose actions must be reconstructable later writes its own
durable log.** Anything a user, an operator, or another agent might need
explained after the fact — a failed build/compose/import run, an audit trail,
"what did my job actually do three days ago" — cannot depend on `journalctl`
still holding it. The journal is a debugging buffer: it rotates by size and/or
age, with no regard for which entries matter. Relying on it for anything that
must survive is relying on something that was never promised to.

Write the durable record **outside** the journal (a file under the service's
own data directory, a database row, whatever your recipe already uses for
persistent state) and size/rotate it on your own terms, independent of the
box's journald configuration.

## Where to look / change it

- `journalctl --disk-usage` — current consumption against the cap.
- `journalctl -u <unit> --reverse | tail -1` (or `--since`) — the *actual*
  oldest entry for **your** unit, not the box-wide figure.
- `SystemMaxUse=` / `MaxRetentionSec=` in `journald.conf` or a drop-in under
  `journald.conf.d/` — the retention is a set value someone chose, not a law
  of nature; document it as a deliberate setting (and where to change it) if
  you depend on it at all.

## See also

- `assists/footgun-journal-conmon-is-not-a-second-emitter.md` — how to
  **measure** the journal correctly once you're reading it (count entries, not
  `-o cat` lines; four more traps that fake a green reading).
- Issue tracking the journal *volume* itself (what's filling it) is a separate
  concern from this footgun (retention behavior) — don't conflate the two when
  triaging.
