---
title: Contracts and handovers between agent sessions
whenToUse: Two agent sessions are agreeing a contract, handing over work, or relaying an operator decision. Also when you are about to change something another session already builds against.
kind: guide
tags: [cross-session, handover, contracts, tickets, api-contract, coordination, hearsay]
---

# The channel carries the message; the ticket carries the content

**Answer first:** session messages are volatile. When the session dies, the
agreement dies with it. **The message must name a durable anchor** — a ticket or
PR number.

> Content without an anchor is not a handover, it is a leak.

- **Incident:** a contract was negotiated across roughly fifteen messages, reversed
  three times and built wrong once. The only durable part was what someone wrote
  into a ticket comment.
- **And the other direction:** information that exists but sits in no place anyone
  queries is as good as absent. Here, a post-deploy review list reported **zero**
  entries while four sat on it — the label is applied when an item *ships*, and by
  then its PR has closed the issue, while the query listed only open ones.

## The test that finds what only exists in the conversation

Saying a thing is not recording it, and the difference is invisible from inside the
conversation — you remember having dealt with it either way.

> **Ask: if this session ended right now, what would be lost?**

It is a real check, not a slogan. When a session was warned that its container was
about to be redeployed, a neighbouring one went looking and found **three** items it
would have called done — a walkthrough written out for the operator, a status another
project was waiting on, and a verify finding that lived only in a volatile pipeline
cache. Its own words:

> until your warning I would have considered all three finished, because they had been
> **said**.

Run the check at any natural boundary — before a long-running step, before handing
over, before ending a turn. What survives is what got an anchor.

## The rules

- **Work is done where it belongs.** No building around another repository, not
  even "temporarily". Cross-repo work becomes a ticket there.
- **Every condition with its reason.** A condition without its incident gets
  misread at the next edge case — the same rule that applies to rules.
- **Literals go out before the merge.** An agreement has to be quotable before it
  is load-bearing.
- **Whoever changes a promise tells the other side — immediately, unprompted.**
  Incident: a contract was promised as `POST /napi/gpu-lease {model, ttl_s}`, built
  internally as `/api/model-lease {model, ttl}`, and nobody was told. The other side
  had already built and shipped against the promise. **The costs are asymmetric:**
  saying it costs one message, not saying it costs someone else's release.
- **The promise to get in touch is content, not channel.** An "I'll tell you when
  it works" is exactly as volatile as the agreement it accompanies: it lives in a
  session that will end before the condition is met. Write the notification into
  the ticket as part of the work, next to the acceptance — then whoever finishes
  the work sends it, whether or not the session that promised it still exists.
  Incident: the cross-repo notification owed once a catalog entry answered on the
  running box stood in the ticket, not in a session's memory; the other side
  formulated the rule after seeing it done that way.
- **A measurement that contradicts a decision goes to the architect as a
  *question*, not as a reversal.**
- **An operator decision you know only second-hand is hearsay.** Put it to them
  directly rather than adopting it on a quote — and until then build **additively**,
  never as a replacement. Two houses did this correctly on the same day: one
  declined to change its rules on a relayed quote, the other built a delivery path
  alongside the existing one pending confirmation.
- **When to adopt an outside proposal, and when to push back.** The test: **does
  the proposal attack the mechanism, or a symptom that resembles it?**
  *An ineffective fix is worse than none — it looks like a solution and misleads
  everyone two weeks later.*

## Related

`checklist-a-measurement-carries-its-own-limits` for the fields a measurement must
carry when it enters one of these conversations.
