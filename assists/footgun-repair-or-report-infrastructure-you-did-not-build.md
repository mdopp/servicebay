---
title: Repair or report — infrastructure you did not build
whenToUse: You have found something broken on infrastructure you do not own — a service that will not start, wrong permissions, a failing database, a container someone else is working in. Read this before you fix it.
kind: footgun
tags: [operations, ownership, self-healing, diagnosis, incident, box, credentials]
---

# The boundary runs along ownership, not along the kind of fault

**Answer first:** the pipeline changes what **it** owns — its release channel, its
own units and branches. It reports what the **operator** owns — credentials, backup
targets, a running container other people are working in.

That is the portable part. **How wide "repair" may go is calibrated per house** —
a box that is explicitly a development and test target permits far more than one
holding other people's recordings. See
`footgun-importing-a-working-agreement-from-another-repo`.

## Diagnose; do not touch while the cause is unclear

**A repair can erase the trail.** Incident: during a database outage, ownership and
permissions looked exactly like the cause. A `chown` would have **looked like a
solution and changed nothing** — the real cause was SELinux MCS categories — and it
would have destroyed the evidence.

This is the half a structural undo does not cover. Placing a rollback in a
`finally` protects against the *stuck state*; it does not protect against the *lost
proof*.

## Self-healing is wrong for configuration faults: say it once, then leave it

Incident: a restart loop turned a configuration fault into a thousand login
attempts within minutes and burned a token. Another house holds the other half of
this in the unit file itself — the service exits with 0 so that nothing restarts
it.

## The third case: noticing, not touching

All of the above is about **touching**. The case that keeps getting missed is
**noticing** — and there the structural answer is not a repair at all, it is
visibility.

> "Structural instead of disciplinary" does not replace the action — it only
> makes sure nobody overlooks it.

Incident: a RAID1 whose second disk had not failed but was **never there**. What
can be caught structurally is only that nobody notices it: a probe that
recognises `[U_]`. It does not buy the disk. Report it and build the probe; do
not confuse having built the probe with having fixed the array.

The harder half of the same case is **normal operation under a missing
capability**, not an outage. A neighbouring project produces its chronicle even
when no language model is reachable — but then **explicitly ordered rather than
narrated, and that sentence stands in the record.** It becomes visibly thinner
instead of invisibly worse. This is the more common shape by far: *the outage is
seen, the degraded normal operation is not.* A record that does not show what is
missing gets read weeks later as complete.

## In practice here

- Read tools before exec tools (`footgun-exec-last-resort`).
- Do not reinstall, restart or mutate the running development container that other
  agents are working in. Incident: a builder probing a live server reached the real
  session manager and created a stray window. It reported and removed it — and the
  orchestrator **counted independently** rather than believing the cleanup claim.
- If a check would have to *write* in order to prove something, leave the criterion
  **owed** and say why. An honest "could not check" is a clean result; an invented
  pass is not.
- Never force a failure on a live machine to re-prove something already proven in
  process.
