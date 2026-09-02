# ADR 0010 — moved to the assist catalog

This decision has **moved**. There is one copy of it, and it lives in the
assist catalog so that agents working over MCP can actually find and read it
(#2607) — `docs/` is not reachable from an agent session, `assists/` is.

- **Assist id:** `adr-0010-node-lts-line-minor-floats`
- **File:** [`assists/adr-0010-node-lts-line-minor-floats.md`](../../assists/adr-0010-node-lts-line-minor-floats.md)
- **Over MCP:** `get_assist("adr-0010-node-lts-line-minor-floats")`, or find it with `list_assists` — its
  `whenToUse` line names the situations this decision applies to.
- **In the app:** Settings → Knowledge.

This file is a signpost only — do not edit the decision here, it will not be
the copy anyone reads.

**Why this file still says `node-20` (#2723).** The decision was amended from
the Node 20 line to Node 22 (#2329), so the *decision* was renamed after its
content: `adr-0010-node-lts-line-minor-floats`, which names the invariant (one
LTS line, floating minor) rather than whichever major it currently tracks. This
signpost keeps its original filename on purpose — `docs/adr/0010-node-20-minor-floats.md`
is cited in merged PR bodies and issue comments, and renaming it would turn
those into 404s. That is what a signpost is for.
