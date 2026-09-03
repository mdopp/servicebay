---
title: How work enters, and why it travels in batches
whenToUse: You are deciding how work reaches a repo — an idea from a conversation, a finding, something another project needs — or you are setting up a pipeline that plans and builds on its own. Also when you are about to write a fix plan into a ticket.
kind: guide
tags: [intake, issues, backlog, batching, pipeline, tickets, cross-repo, planning]
---

# Work enters as a ticket, and ships in batches

**Answer first:** the issue comes before the code, including for an idea that
surfaced mid-conversation. Work for another repository becomes a **ticket there**
and is never built here. And the expensive tail runs once per batch, not once per
issue.

The pipeline shape itself is in `autoloop-issue-pipeline`; this entry is about
what enters it and in what shape.

## Batching

Batches of up to eight issues. The expensive tail — full suite, CI, release,
hardware verify — runs **once per batch**. A run that ships a single issue as its
own PR while planned units are still open is a **failure of the pipeline**, not
diligence.

**One exception, and it is not negotiable:** a unit that trips the review gate
never rides along in a batch — it gets its own branch. A combined PR carrying
eight issues receives a review of *the whole*, not of the one place where it
matters.

## The one slot consolidation gets

A backlog held at a constant depth by a pipeline that only plans user issues has
no entrance for **consolidation** — the work the project's own measurements ask
for: a lint ratchet that stopped moving, duplicated components, invariant
exemptions nobody retired. It never arrives, because a real issue always outranks
it.

So it gets exactly one door, and the door is narrow:

- **At most one consolidation unit per batch**, and
- **only once no user issue is waiting.**

The source is a **report, not a hunch** — the ratchet/duplication/invariant checks
the repo already runs. The unit's acceptance is the report's number moving, plus
the ratchet tightened to the new number so it cannot drift back.

Put the cap in the broker rather than the playbook. A rule a fresh model re-reads
each run is a rule it can talk itself out of; a `plan` that exits non-zero with
"this batch already holds a consolidation slot" is not. Same reasoning as the
ticket rules below — the mechanism, not the intention, is what holds.

## A regression names its predecessor, and owes a gate

An issue that says "← #N" or "same as #N" is not a second bug. It is the first
bug's **missing gate**: the original fix corrected one occurrence and left the
shape. Label the class (`recurrence`), and make the acceptance a test or an
invariant covering **the whole class** — otherwise the third occurrence is
already scheduled, and it arrives with "but that was fixed" in front of it.

## Finding versus proposal — the distinction that ruins tickets

A **finding** is *measured*. It belongs in the ticket and saves a cold-starting
builder real work. A **proposal** is a *hypothesis* and must be recognisable as
one. Put both in the same paragraph and a guess becomes a specification.

- **Incident A:** the same thing failed **three times**, each attempt with a
  detailed plan in the ticket. Three builders executed the hypothesis instead of
  questioning it. The plan did not prevent the wrong diagnosis — it propagated it
  faster.
- **Incident B:** a ticket named a guess under the heading **"Cause"**. The real
  cause was unrelated. Had the builder believed the heading, the PR would have
  gone green and the bug would have returned at the next release — now with an
  "that was fixed" in front of it.
- **Incident C (here):** a ticket proposed summarising a log payload. One key had
  to stay untouched, because a leak probe uses it as its denominator. Read as a
  plan rather than a proposal, that probe would have gone green while checking
  nothing.

> **The acceptance is binding, the route to it is not.** The builder must be free
> to refute the proposal **without asking**, as long as the acceptance criteria
> are met.

How much established fact a ticket should carry is **calibrated per house** — a
cold-starting agent needs more than a person who knows the code. See
`footgun-importing-a-working-agreement-from-another-repo`.

## Four smaller rules, each from a real loss

- **Preconditions are checked before planning**, not discovered while building.
  Incident: a unit was planned whose precondition — a template variable — sat in
  someone else's *open* PR. The builder correctly aborted rather than pulling the
  variable across and pushing a conflict onto a live PR.
- **A finished green PR is not an open question, it is an unperformed action.**
  Same incident, other half: the blocking PR had been green, conflict-free and
  complete for hours, and was simply on nobody's list.
- **If another project is waiting on us, that comes first** — recognised by it
  being written in a ticket. No inferring, no separately maintained project list.
- **Cross-repo work becomes a ticket, never a local workaround**, not even
  "temporarily".
