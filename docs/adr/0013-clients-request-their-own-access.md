# ADR 0013 — lives in the assist catalog

This decision lives in the **assist catalog**, not here. There is one copy of it,
and it sits where an agent working over MCP can actually find and read it
(#2607) — `docs/` is not reachable from an agent session, `assists/` is.

- **Assist id:** `adr-0013-clients-request-their-own-access`
- **File:** [`assists/adr-0013-clients-request-their-own-access.md`](../../assists/adr-0013-clients-request-their-own-access.md)
- **Over MCP:** `get_assist("adr-0013-clients-request-their-own-access")`, or find it
  with `list_assists` — its `whenToUse` line names the situations this decision
  applies to.
- **In the app:** Settings → Knowledge.

**In one line:** machine credentials are no longer handed out by the operator —
the client requests, the human confirms, the secret goes straight to the client,
and which scopes may be self-requested at all is decided by a three-class table
next to `apiScope.ts`.

This file is a signpost only — do not edit the decision here, it will not be the
copy anyone reads.
