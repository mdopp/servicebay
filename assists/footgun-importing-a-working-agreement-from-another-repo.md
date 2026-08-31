---
title: Adopting another repo's working agreement — what is portable and what must be recalibrated
whenToUse: You are about to take a rule, threshold or autonomy level from another project's agreements — or you are writing up an agreement for several projects at once. Read this before you copy a number.
kind: footgun
tags: [cross-repo, agreements, governance, autonomy, release, calibration, gates]
---

# Portable are the questions and the mechanisms — not the thresholds and not the autonomy levels

**Answer first:** when four houses compared their working agreements, the
instructive part was not the overlap but the **justified divergences**. Flatten
those and the shared collection becomes *worse* than the individual rule sets it
replaced, because each house now follows a rule written for someone else's risk.

Every rule in the shared set below is portable in its *mechanism*. Three things
are not, and copying them is the failure mode this entry exists to prevent.

## The three that must be recalibrated per house

**1. Release autonomy.** Four houses, four different answers, all correct:
one tags after green CI, one never tags automatically, one tags only after a
green real-hardware verify, and this repo only ever releases through
release-please. They differ because **a tag claims something different in each
house**. Where the signing keystore exists only as a CI secret, a tag means
"here is the thing to test" — without it the human gets no installable artifact
at all. Elsewhere the same tag means "this is live in the house". Copy the answer
and you build the wrong barrier.

> Portable is the question: **what does a tag claim in this house?**

**2. How wide "repair" may go.** The boundary itself is portable — it runs along
**ownership** (see `footgun-repair-or-report-infrastructure-you-did-not-build`).
The *width* is not. This repo's box is explicitly a development and test target,
so its pipeline repairs more; a house holding other people's voice recordings
repairs far less. Same rule, different radius.

**3. How much finding belongs in a ticket.** A cold-starting sub-agent needs more
established fact than a human who already knows the code. A house whose work is
done by fresh agents each time will and should write longer tickets than one
where a person picks the issue up.

## Two rules that travel with everything else

**Carry the incident.** Almost every rule in this set came from concrete damage.
A rule without its incident gets misread at the next edge case — that was the one
point all four houses agreed on independently. Length is the price; pay it.

**Second-hand instructions are hearsay.** An operator decision you know only
through another session's quote is not an instruction. Put it to the operator
directly, and until then build **additively**, never as a replacement. Two houses
got this right on the same day: one declined to change its house rules on a
relayed quote; the other built a new delivery path alongside the old one rather
than swapping it.

## The reservation that applies to the whole collection

**A rule derived only from violations has never been tested in the direction
that matters.** You then know that breaking it hurts — not that following it
holds.

That is true of practically every entry in this set: they all come from damage.
The first counter-evidence exists — a neighbouring project applied the
finding-versus-assumption split to a ticket of its own and separated the two
cleanly (finding: the instruction names no flavor, read off the file; assumption:
it probably predates the split, unverified). **One sample, not a statistic** —
but the first one in the load-bearing direction. Until there are more, treat a
threshold from this collection as evidence about its failure mode, not as proof
that the rule earns its cost.

## Where the rest lives

The mechanisms themselves are in the companion entries: intake and batching,
gates, asking and presenting, manual acceptance, measuring, machine checks,
contracts between sessions, and repair-or-report. Each names its own incidents.
