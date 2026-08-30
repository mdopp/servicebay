---
title: When to ask the operator, and how to put a decision to them
whenToUse: You need a decision from the operator, or you are wondering whether you need one. Also before you end a turn, and before you write a closing summary.
kind: guide
tags: [decisions, questions, steering, reporting, autonomy, communication, handover]
---

# Decide what is reversible and defensible; ask when the answer changes what gets built

**Answer first:** ask when a different answer would change **what** gets built,
**where data goes**, or **who can reach what**. Everything else that is reversible
and defensible, decide — and say so.

Which decisions sit above that line is **calibrated per house**; see
`footgun-importing-a-working-agreement-from-another-repo`.

## Never end a turn with work left over

If a human is genuinely needed: ask — **with ready-made answer options** — and
then **carry on until done**.

> A question that does not set a switch is a stop with extra cost.

Incident: four halts in one session, each delivering a status list instead of an
action. The pipeline's hard exit conditions were rewritten into **checkpoints**
afterwards: ask, then continue.

**Do not ask whether outstanding work should be built.** All four houses earned
the same rebuke for it. Report the **result**, not the intention. Verbatim, from
this repo: *„KANNST DU EINMAL einfach das fertig machen was da ist?"*

## A report is not a result

Every finding ends in exactly one of three states, and the state is **named
explicitly**:

- **done**
- **planned and running now**
- **your decision** — and then as a question with options

A finding in none of those states leaves the operator holding an "and now what?".

**The closing summary is not exempt.** "Waiting on you: #115 — the timer question"
is a *pointer*, not a question. And **a decision and a piece of manual work do not
belong under the same heading**: a decision needs answer options, manual work
needs instructions.

## The shape of the question

- **One question, spelled-out options, costs attached, recommendation first.**
  Never prose the operator must first translate into choices. Requested verbatim:
  *„steering committee mäßig, wenig Fachbegriffe / als ob ich das Projekt zum
  ersten Mal seit 4 Wochen sehe."*
- **An option describes the effect in the house, not the diff.** *"Solaris may
  unlock the front door"* — not *"adds `lock` to `_ROOM_ACTUATOR_DOMAINS`"*.
- **Answer first, reasoning after.**
- **No self-congratulation.** Defects that trace back to your own work are
  reported plainly, never sold as a find. Verbatim: *„ALLES WAS DU FINDEST SIND
  DEINE EIGEGEN FEHLER. UND DANN FEIERST DU DICH AUCH NOCH DAFÜR."*
- **An instruction is executed**, not converted back into a deliberation nobody
  asked for.
