# ADR 0015 — lives in the assist catalog

This decision lives in the **assist catalog**, not here. There is one copy of it,
and it sits where an agent working over MCP can actually find and read it
(#2607) — `docs/` is not reachable from an agent session, `assists/` is.

- **Assist id:** `adr-0015-template-deletions-need-a-delivered-files-manifest`
- **File:** [`assists/adr-0015-template-deletions-need-a-delivered-files-manifest.md`](../../assists/adr-0015-template-deletions-need-a-delivered-files-manifest.md)
- **Over MCP:** `get_assist("adr-0015-template-deletions-need-a-delivered-files-manifest")`,
  or find it with `list_assists` — its `whenToUse` line names the situations this
  decision applies to.
- **In the app:** Settings → Knowledge.

**In one line:** a deploy may delete a file only if it recorded delivering that
exact path itself, because runtime-created files (a resident's notes,
`solaris.db`, `.paperless-token`) live in the same directories — so the record is
a delivered-files manifest, never a mirroring sync and never an exclusion list.

This file is a signpost only — do not edit the decision here, it will not be the
copy anyone reads.
