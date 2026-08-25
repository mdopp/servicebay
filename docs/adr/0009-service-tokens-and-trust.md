# ADR 0009 — moved to the assist catalog

This decision has **moved**. There is one copy of it, and it lives in the
assist catalog so that agents working over MCP can actually find and read it
(#2607) — `docs/` is not reachable from an agent session, `assists/` is.

- **Assist id:** `adr-0009-service-tokens-and-trust`
- **File:** [`assists/adr-0009-service-tokens-and-trust.md`](../../assists/adr-0009-service-tokens-and-trust.md)
- **Over MCP:** `get_assist("adr-0009-service-tokens-and-trust")`, or find it with `list_assists` — its
  `whenToUse` line names the situations this decision applies to.
- **In the app:** Settings → Knowledge.

This file is a signpost only — do not edit the decision here, it will not be
the copy anyone reads.
