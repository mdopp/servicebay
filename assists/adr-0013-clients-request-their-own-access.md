---
title: "ADR 0013 — Clients request their own access; the human only confirms"
whenToUse: "You are about to hand an agent, script or companion app a hand-minted API token, add a scope to apiScope.ts, wire the token-request/approval queue, or you found a built feature nobody ever used because no token carries the scope it needs — this decides how a machine credential comes into existence (client requests, human confirms), which scopes may be self-requested at all, and why the scope vocabulary must exist exactly once."
kind: adr
tags: [adr, decision, tokens, scopes, approvals, mcp, least-privilege, propose]
---
# ADR 0013 — Clients request their own access; the human only confirms

- **Status:** Accepted (2026-08-25). The six points the draft left open were
  delegated by the operator; they are recorded below as *decided per
  recommendation*.
- **Date:** 2026-08-25
- **Deciders:** @mdopp
- **Concerns / supersedes:** #2609 (return channel unusable), #2139 (token request
  queue), #2245 (one-shot elevation), #2326 (learning return channel), #2325
  (scope visibility), #2606/#2608 (token inventory, bulk revoke)
- **Related ADRs:** [0009](adr-0009-service-tokens-and-trust.md) (the token and
  trust model — this ADR adds the *issuance path* to it and changes nothing about
  the scope ladder, the storage format or the resolution order),
  [0011](adr-0011-app-integrations-aggregate-server-side.md) (companion app, pairing)

> Format: Status / Context / Decision / Consequences, like the other ADRs. What
> is recorded is what is **not derivable from the code** — including the incident
> that forced the decision.

## Context

### The trigger

The learning return channel from #2326 was built over four slices — submit,
checklist, retrieval, drift detection — and was **never used**:
`list_learning_proposals` returned an empty list, permanently. The reason was not
disinterest. `propose_learning` requires the `propose` scope, and of 34 tokens on
the reference box **none** carried it. Because tools have been visible by scope
since #2325, the tool appeared in *no* session. The write side existed and was
unreachable.

That is the failure shape this ADR is about: **something is ineffective and looks
like nothing.** There was no error message, no red build, no empty spot in the
UI — only a function nobody ever called.

### What already exists — and where it breaks off

The request/approval path from #2139/#2245 is **largely built**: filing a request
(`request_token`, deliberately requiring only `read` — otherwise you would need the
rights you are requesting), a request store under `DATA_DIR` at `0600`, a
narrowing guarantee (an approval can only *restrict*, never widen), a TTL cap,
one-time hand-over of the secret on collection (`poll_token_request`), inspection
via `list_requests`, a session-protected admin route for approve/reject, the
approval core with its self-approval lock, the approval-card UI, the SSE push to
the phone, one-shot elevation for `destroy`/`exec`, and the delegated child mint
with ⊆ scopes.

It breaks off at three places — all three the same build type: *mechanism
finished, decision surface missing.*

**Gap 1 — the plain request has no user interface.** The admin route exists, but
no frontend module calls it. The request text literally promises the agent an
approval under *Settings → MCP*; what is there are only the approvals for
destructive tool calls. Documented on the running box: nine requests, **eight
`pending` for weeks**, the oldest about seven weeks old. Exactly one was ever
approved — the one-shot request, and that one went through the **approval card**,
not the route. *The path that has a surface gets used; the one without stays put.*

**Gap 2 — requests never expire.** A `pending` entry stays forever and counts
against the cap on open requests. On that same approved request: approval three
days after filing, at a 300 s TTL — the token was dead five minutes after the
approval, and would not have been handed out anyway. **An approval that comes
too late is worthless** — an argument for expiry *and* for push over pull.

**Gap 3 — `propose` was offered nowhere.** The backend accepted the scope
(`apiTokenRoutes.ts` uses the complete `ALL_SCOPES` from `apiScope.ts`). But the
creation UI kept its **own, shortened copy** of the list, and the frontend type was
a second copy without `propose`. The checkbox was never there. And because the
badge mapping was a `Record` over the *local* type, widening the backend type
would **not even have turned the build red**.

Neither issuance nor verification was broken. What was missing was (a) the
*offer* of the scope at creation and (b) the *approval surface* for the request
path.

**Side finding, same class:** the review path for learning proposals also has
routes, but no frontend calls them. A `propose` token alone therefore produces
proposals nobody sees in the dashboard.

### Why now, and in this direction

The small fixes (offer the scope at creation / grant it automatically / show its
absence) would have repaired exactly this one scope. The direction set instead is
structural: *clients should be able to obtain their own keys for development,
which then only need confirming.*

Added to that is the principle from the token-hygiene rework (#2606/#2608):
**friction scales with blast radius, not with repetition** — a typed confirmation
whose wording grows with the blast radius of the selection. A self-service path
that opened a second, low-friction approval surface beside it would devalue that
work.

## Decision

**The issuance path for machine access is inverted: the human no longer issues
and hands over; the client requests and the human confirms.** The existing request
path is not replaced for this but **wired up completely, made visible, classified,
and given expiry.**

### The flow

0. **Minimal initial access.** The client identifies itself with one of the three
   credentials that already exist: the LAN-only bootstrap token (ADR 0009 §4, the
   normal case for a fresh development session), an existing narrow token, or a
   session when a human is at the device.
1. **The client requests** — `request_token(scopes, reason, ttl_seconds)`, extended
   by a mandatory field **`client_label`**: a self-chosen, stable identifier of the
   application. It becomes the name of the eventual token and the line the human
   reads. The origin (`requestedBy`) stays beside it, **set server-side and not
   client-writable**.
2. **The request parks as an approval card.** The central change: **every** request
   now takes the path that today only the one-shot request takes. The plain request
   thereby inherits, with no new infrastructure, the card in the dashboard, the
   self-approval lock, persistence across restarts, and the **SSE push to the
   phone**. The admin route remains as a secondary path for scope narrowing but is
   no longer the only path.
3. **What the human sees.** The card names, in this order: *who* (`client_label` +
   origin), *what* in plain words instead of scope names ("may create and change
   services — not delete, no shell"), *why*, *for how long* (as a date, not as
   seconds), and the **risk class**. Plus two facts that do not exist today and that
   make the decision possible in the first place: *does this `client_label` already
   hold tokens?* and *was a request of the same kind recently rejected?*
4. **The key reaches the client** — unchanged, via collection, **exactly once**, then
   deleted from the store. The secret never travels over the approval surface, never
   by e-mail, never in a list. **The human copies nothing.** That is precisely the
   gain over today.
5. **Rejection is a terminal state** with a **cooldown**: a request *of the same
   shape* (same `client_label`, same scope set) is admissible again only after it
   elapses. Without that, "reject" is only a delay, and a persistent client trains
   the human to click it away.
6. **Expiry** — a `pending` request **expires**. An expired request can no longer be
   approved; the client has to ask again, with a fresh reason. That fixes Gap 2 and
   prevents an approval from minting a grant that died long ago.

### Which rights may be requested on this path

Self-service lowers the bar to acquiring rights — that is its purpose **and** its
risk. The scope space is therefore split into three classes, and the class
determines the friction. The classification belongs **next to `apiScope.ts`**, so
that it cannot drift apart between UI and backend — that is the lesson of Gap 3.

| Class | Scopes | Self-service | Confirmation | TTL cap |
|---|---|---|---|---|
| **A — harmless** | `read`, `propose` | yes | one click | 30 d |
| **B — constructive** | `lifecycle`, `mutate` | yes | one click, but the card lists the effect in plain words and the button is active only after expanding it | 7 d |
| **C — elevated** | `destroy`, `exec`, `reboot` | **never as standing access** | only as a **one-shot**, bound to one operation, single-use, plus a typed confirmation | 10 min |

With that, the question "what stops a compromised client from asking itself for
`destroy`?" is answered structurally: **it cannot.** A class-C request for standing
access is rejected at filing time, not at approval time. At most it can request a
*single, named* destructive operation, bound to exactly this tool and this service,
burned after first use, and dead after ten minutes regardless.

The typed confirmation for class C follows the pattern from #2608 to the letter: the
phrase **names the operation**, not just a number. Whoever types it has read what
they are typing. That is the difference between a decision and a reflex — and the
reason the friction does *not* apply to class A: **a confirmation that always hurts
soon does nothing at all.**

The **over-eager** (not compromised) client is the more common case. Against it work
the cooldown, the cap on open requests, request expiry, and the note on the card
whether this `client_label` already holds tokens.

**Explicitly untouched:** the session-cookie bridge with full scopes (ADR 0009) and
the delegated child mint, which needs no human. The delegated mint can never widen
(`scopesAreSubset`), so it is no detour around the classification — but no
substitute for it either, because it presupposes an already broad parent token.

### Expiry and renewal

The inventory on the box came about because every access was minted by hand and
never touched again. A path that makes issuing *easier* makes that worse unless it
sets something against it:

1. **No self-requested token without expiry.** "Never expires" is not selectable on
   this path; the TTL cap per class is the ceiling, not the suggestion.
2. **Renew instead of re-issue.** When a token enters its grace period, the client
   files a **renewal request**: same `client_label`, same or narrower scopes, a
   reference to the expiring token. The card shows it as a renewal — an unchanged
   renewal in classes A/B is a lighter decision than a first request. The old token
   is revoked on approval instead of lying beside the new one.
3. **The inventory stays readable.** The hygiene overview from #2606 gets
   self-requested access as an origin of its own (`createdBy` is already set), so
   it is visible how much of the inventory came about this way.

### The scope enumeration exists exactly once

Gap 3 was not carelessness in one place but **a copy nobody could turn red**. From
here on: `apiScope.ts` is the sole source of the scope list; every surface, every
type and every explanation derives from it, and a test pins that rather than
trusting the type checker — which proved here that it does not notice.

### Settled parameters

Delegated by the operator and decided per the draft's recommendation (2026-08-25);
open to revision at the first implementation experience.

1. **Does self-requested access get `propose` automatically?** → **Yes, but visibly
   on the card** ("additionally: may submit knowledge proposals"). The scope is
   low-privilege and independent; granting it along revives the return channel in
   one move. Visibility is the condition — *silent* widening of rights is exactly
   what this ADR otherwise avoids. This is an explicit recommendation of the draft.
2. **How long may a request stay open?** → **48 h for classes A/B, 30 min for
   class C.** Shorter means more re-requests, longer means dead entries again.
3. **May a `read` token request `mutate` access, or only a human at the device?**
   → **Today's behaviour stays** (the request requires only `read`). A compromised
   session is thereby one click away from more rights — but from a *human* click,
   on a card that names effect and origin in plain words. The draft gave no explicit
   recommendation here; the weighing in the text carries the status quo.
4. **Is `client_label` free-form or from a list?** → **Free-form.** It is forgeable,
   but it does not stand alone: the non-forgeable origin (`requestedBy`) is placed
   beside it server-side. A curated list would be more honest and again manual work
   at setup — the price is not worth it as long as the hard fact stands beside it.
5. **What happens to the legacy requests?** → **Let them expire.** Some of them are
   test requests that explicitly ask to be rejected; there is nothing to review.

### Implementation

Delivered incrementally. State and order live in the linked issues (#2609, #2139,
#2245, #2326, #2325, #2606/#2608), not here — a build table in an ADR is stale by
the first merge. What carries this ADR is the decision above; what of it is built,
the tracker says.

## Consequences

- **The human copies no more secrets.** The token comes into existence after the
  approval and is collected by the client — the operator never sees it. That is
  safer than today's path (secret once in the browser, then handed on by hand) and
  more convenient besides.
- **Confirming becomes a frequent action.** With that, the quality of the card
  becomes a security property: a card that shows only a scope list produces
  reflexes. Hence the plain-words effect and the class tiers — and hence class-A
  requests must *not* hurt.
- **Elevated rights are available on this path only case by case.** Whoever needs
  standing `destroy` access still mints it by hand under *Settings → Access* —
  deliberately less convenient than the self-service path. Convenience thereby
  sits on the safe side.
- **ADR 0009 stays valid and is extended.** Scope ladder, storage format, LAN gate
  and resolution order are untouched; this ADR describes only *how a token comes
  into existence*. `propose` is the first scope not on the blast-radius ladder —
  the classification above accommodates that, a pure ladder would not.
- **Duplicate scope lists are a defect from now on.** Candidate for
  [`ARCHITECTURE_INVARIANTS.md`](../docs/ARCHITECTURE_INVARIANTS.md): the scope
  enumeration exists exactly once.
- **The general lesson, beyond tokens:** a built capability whose *access* is
  offered nowhere is not "unused" — it is unreachable, and from the outside it
  looks exactly like one nobody needs. Whoever introduces a return channel, a tool
  or a role delivers in the same move the way to it **and** a place where its
  absence can be read off.
