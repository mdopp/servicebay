---
title: Walking a human through a manual acceptance
whenToUse: A person has to confirm something on a device, a phone or an installation that you cannot check yourself — a release check, a device test, an on-site observation. Read this before you write "please check whether it works".
kind: recipe
tags: [acceptance, manual-test, release, human-in-the-loop, questions, device-test, household]
---

# Lead the walk-through; do not ask for an assessment

**Answer first:** both failed questions of one release round were **assessment
questions**. The reactions: *„woher soll ich wissen was du meinst? ich bekomme
einige infos...aber was willst du hier von mir??"* and *„ich weiss nicht was ich
hier machen soll."* A person can describe what they see. They cannot know what
you consider correct.

## The seven steps

1. **Block overview first** — every check, grouped by **where** it happens, not by
   ticket number. So they do not jump between screens.
2. **Preconditions and caveats before they start** — what triggers the check, what
   *cannot* trigger it, how long it takes, and what is deliberately different from
   what they expect.
3. **Numbered instructions with concrete objects** — described from *their*
   surface, never in ticket jargon.
4. **Say what should happen** — not "check whether it works", but "two test
   messages should arrive".
5. **Ask about the observation, not the verdict** — *"what does the icon look
   like?"* rather than *"is the icon right?"*.
6. **Answer options cover the failure shapes**, plus an exit for "can't find it"
   or "don't have that".
7. **Act on the answer.** Confirmed → close. Deviation → file a defect.
   **Ambiguous → follow up, never guess.**

## Five rules around the walk-through

- **Testability belongs in the planning.** A unit whose effect is only visible on
  a device needs a nameable trigger. If none exists, it gets **built**. Incident:
  a ticket had been open since July because its path could not be triggered on
  command; a purpose-built diagnostic button closed it in one round.
- **Every check names its precondition.** Incident: a threshold sat at 90 minutes
  while the operator's test lasted minutes. They *could not* show anything. One
  sideload wasted.
- **One release, one list** — not eleven separate questions in sequence.
- **After three failures at the same spot, change direction** rather than guessing
  a fourth attempt — and say so beforehand.
- **"Unverified" is a valid result, and so is "not asked".** Both get reported out
  loud. A release may ship with a **named** remainder; it may not pretend there is
  none.

## The installation is an inhabited home

No device switching in the evening or at night, **anywhere**; at any other time,
ask first and name the device and the room.

Incident: *„in dem raum schläft jemand!"* — and when the rule was narrowed to that
one room: **„nirgends!!"**. The old rule had governed *which* room gets disturbed.
Never *whether*.
