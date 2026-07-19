---
title: Placing a Local template must be done as uid 1000 (write_file EACCES leaves a root-owned stray dir)
whenToUse: You are dropping a Local template under the box's local-templates dir and the write fails with EACCES, or a previous failed attempt left a root-owned empty dir that now blocks retries.
kind: footgun
tags: [local-template, write_file, uid, permissions, eacces, mcp, box]
---

# Local templates must be placed as uid 1000

## Symptom
Writing a Local template file under
`{{DATA_DIR}}/local-templates/templates/<name>/…` (e.g. via the MCP `write_file`)
returns `EACCES`, **and** leaves a **root-owned empty directory** behind. That
stray dir then blocks retries, because your non-root writer can't create files
inside a root-owned dir.

## Cause
The `local-templates` tree is owned by the box's `servicebay` user (**host uid
1000**) — the same ownership as any existing Local template (e.g. `buerolicht`).
A write path that runs as root (or a mismatched uid) can create the parent dir as
root before it fails, so ownership diverges and the retry is wedged.

## Fix / avoid
- **Place Local template files as uid 1000**, matching the existing templates'
  ownership. Over MCP, prefer a write path that runs as the `servicebay` user; if
  a stray root-owned dir already exists, remove it (as root) and recreate it owned
  by uid 1000 before retrying.
- Verify the new tree's ownership matches a sibling template
  (`ls -ln local-templates/templates/`) before assuming the drop took.

The clean fix (have the write path create these as uid 1000 automatically, or
fail without leaving a stray dir) is tracked in servicebay#2344. Until then,
uid-1000 placement is the reliable path.
