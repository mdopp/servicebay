---
title: Report standards gaps back — close the loop when the standards made you guess
whenToUse: While building or deploying a service you had to guess, were corrected, or found a missing/ambiguous standard or a wrong/incomplete assist. Read this to know that reporting the gap back is itself expected, and how to do it.
kind: guide
tags: [standards, gaps, feedback, convention, issue, drift, meta, report-back]
---

# Report standards gaps back

The standards, ADRs, and assist catalog only improve if the friction real
builders hit flows back. **Reporting a standards gap is itself a standard** — not
optional politeness. Whenever you (agent or human) building a service had to
**guess**, got **corrected** afterwards, or found a standard that was **missing,
ambiguous, or wrong**, close the loop:

1. **File an issue in `mdopp/servicebay`** with the `standards-gap` label. Body =
   what you were doing, where the standard was silent/ambiguous/wrong, what you
   guessed, and (if known) what the right answer turned out to be. Reference the
   files/functions by path, not one deployment's values.
2. **If you already worked out the right answer,** propose it concretely — a new
   or updated assist, a docs line, or an addition to `get_service_standards`. A
   Local assist drop on the box (`DATA_DIR/local-assists/`) is a good first home
   for a proposal; it's discoverable via `list_assists` immediately and can be
   **promoted** into a built-in `assists/*.md` (shipped in the image) once
   accepted — this drift-report -> promotion flow is the intended path (see
   servicebay#2345 for a worked promotion).
3. **Abstract, don't transcribe** (CLAUDE.md). Turn "how I fixed X on my box
   today" into "the general pattern + the footgun to avoid," scrubbing tokens,
   hostnames-with-auth, and any live-box value.

`get_service_standards` surfaces this pointer at the start of a build so the loop
is discoverable, not folklore. Standards that improve from real friction beat
each builder re-deriving or getting corrected.
