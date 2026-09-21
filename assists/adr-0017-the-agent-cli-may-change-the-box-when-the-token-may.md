---
title: "ADR 0017 — The agent CLI may change the box when the token may; named verbs, never a passthrough"
whenToUse: "You are adding a verb to the agent CLI (agent-cli/servicebay.mjs), refusing to add one because 'the CLI is read-only', considering a generic `call <tool>` passthrough, or writing a handbook line that tells a shell session to fall back to a raw HTTP call when no verb exists — this decides whether the CLI may change the box at all, that it does so through one named verb per real route rather than a passthrough, and which tiers no verb may ever reach."
kind: adr
tags: [adr, decision, agent-cli, cli-verbs, handbook, mutation, passthrough]
---
# ADR 0017 — The agent CLI may change the box when the token may; named verbs, never a passthrough

- **Status:** Accepted (2026-09-20)
- **Date:** 2026-09-20
- **Deciders:** @mdopp
- **Concerns:** #2990 (named mutating verbs), #2983 (a 200 that moved nothing),
  #2984 (`whoami`), #2994 (no way to request a removal). Builds on
  [ADR 0009](adr-0009-service-tokens-and-trust.md) (what a token means) and
  [ADR 0013](adr-0013-clients-request-their-own-access.md) (how one comes into
  existence).

## Context

The agent CLI (`agent-cli/servicebay.mjs`, #2906) was deliberately read-only. At
the time that cost nothing: agent tokens carried `read`, so a verb that changed
something would have been refused anyway, and "the CLI cannot change the box"
was a property worth having written down and gated
(`tests/scripts/agent_cli_mutation_gate.test.ts`).

That premise expired. The pi-web token now carries `read,propose,lifecycle,mutate`
— granted deliberately, through the request-and-confirm path ADR 0013 describes.
The CLI kept refusing.

What a refusal by a *client* actually buys, when the *token* already holds the
tier, is nothing. The handbook had a section titled **"When the CLI has no verb
for it"**, and it pointed at the raw `/mcp` endpoint. On 2026-09-20 a pi session
followed it for forty minutes:

- `curl -H "Authorization: Bearer $(cat /data/servicebay/parent-token)" …/mcp` —
  the token in `argv`, world-readable through `/proc/<pid>/cmdline` on a
  container with real user logins, two paragraphs after the same handbook
  forbids exactly that;
- `servicebay delegate test --scopes read,lifecycle,mutate` "to see what MCP
  tools exist" — a live child token with mutation rights, minted as a probe and
  left alive;
- and, having no verb for a removal either, it "freed" a port by redeploying the
  service it was replacing with a placeholder image. Two broken services, the
  domain dark.

Every one of those is worse than the mutation the CLI declined to carry. The
read-only rule was not preventing change; it was choosing the door change came
through, and choosing the worse one.

## Decision

**1. The token decides; the door only has to say what it is.** The agent CLI may
carry verbs that change the box. Whether a given call succeeds is settled where
it was always settled — by the scope the presented token holds, checked by the
route's own guard.

**2. Named verbs, one per real REST route, never a generic passthrough.** A
`call <tool>` escape hatch was rejected: it leaves the route contract, puts raw
tool JSON back on the shell, and turns the mutation gate into a formality that
can no longer read what a verb does. Each verb declares the `tokenScope` its
route really carries, and the CLI quotes that scope back in every refusal — so
an agent that is refused is told what to ask for, which a flat
`401 {"error":"Authentication required"}` never did.

**3. A route that something other than a browser calls declares a tier.**
`POST /api/services/[name]/action` was cookie-only. It now carries
`tokenScope: 'lifecycle'` — the tier its MCP twin `manage_service` has held
since #2397, and the one `/api/install/start` already carried. `POST
/api/install/template` is new and carries `mutate`, the tier `install_template`
has held since #2141. Neither is a widening: both tiers already existed and were
already reachable, through MCP.

**4. The gate changes what it defends, and defends it in both directions.** The
class gate no longer asserts "no verb reaches a mutating tier". It asserts:

> A verb may only reach a route whose tier it declares, and it declares the tier
> the route really carries.

Fail-closed both ways — a `read` verb on a mutating route and a `mutate` verb on
a read route are each red, as is a `mutate` verb whose declared `scope` is not
the word the route demands. The last one matters because the declared scope is
what the CLI prints on a refusal: a mismatch sends the agent after a grant that
would still not work.

**5. Destroy, reboot and exec stay out.** No verb may reach those tiers, even
declared honestly. A token that may change a service is not thereby a token that
may end one: removal, reset and shell are *requested* and an operator executes
what was approved (ADR 0013, #2994). This is the line the read-only rule was
really protecting, and it is the one worth keeping.

**6. A success must be provable.** `update` speaks the `force-update` action,
not the plain `update`: the plain one restarts without showing whether the image
moved, and a 200 that moved nothing read as success is #2983. The verb returns
per-image before/after digests and **exits non-zero on `stale`**, because an
exit code is the only part of this a shell script reads.

## Consequences

- The handbook section "When the CLI has no verb for it" is deleted, and with it
  the instruction to hand-roll MCP. `agent-docs/AGENTS.md` no longer names
  `/mcp`. (It also removes ~470 tokens from every pi prompt.)
- The honest reading of "least privilege" moves from the client to the grant: if
  an agent should not be able to update a service, do not give its token
  `lifecycle`. That is now the only place the answer lives — which is where
  ADR 0013 always said it should be.
- A verb whose route has no `tokenScope` at all is red. That is deliberate: an
  absent tier is a hole, not a permission.
- The gap this does **not** close: there is still no way for an agent to *ask*
  for a removal (#2994). Until there is, a session told "the old one can go" has
  nowhere to put that, and the improvisation that follows is the failure this
  ADR is a reaction to. The verb table is not finished.
- `assembleManifest → applyVariableDefaults → createJob → startJob` had three
  hand-kept copies (MCP tool, approved install request, and now a route); they
  are folded onto one `startTemplateInstall`, because three copies of a
  four-call sequence is how one of them quietly stops applying defaults.
