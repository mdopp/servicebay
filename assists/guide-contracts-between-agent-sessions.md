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
