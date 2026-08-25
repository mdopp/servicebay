# ADR 0012 — moved to the assist catalog

This decision has **moved**. There is one copy of it, and it lives in the
assist catalog so that agents working over MCP can actually find and read it
(#2607) — `docs/` is not reachable from an agent session, `assists/` is.

- **Assist id:** `adr-0012-repair-is-reconciliation-not-reinstallation`
- **File:** [`assists/adr-0012-repair-is-reconciliation-not-reinstallation.md`](../../assists/adr-0012-repair-is-reconciliation-not-reinstallation.md)
- **Over MCP:** `get_assist("adr-0012-repair-is-reconciliation-not-reinstallation")`, or find it with `list_assists` — its
  `whenToUse` line names the situations this decision applies to.
- **In the app:** Settings → Knowledge.

## This one also changed number

It was filed as a **second** ADR 0009 and never entered the index (#2617).
ADR number **0009** belongs to *Tokens & trust between services*
([`docs/adr/0009-service-tokens-and-trust.md`](0009-service-tokens-and-trust.md));
this record is now **ADR 0012**. Both old and new paths point here, so
existing references from code comments, PR bodies and issues keep resolving.

This file is a signpost only — do not edit the decision here, it will not be
the copy anyone reads.
