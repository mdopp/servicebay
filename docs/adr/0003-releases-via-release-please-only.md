# ADR 0003 — Versioning and releases go through release-please only; commit subjects stay parser-clean

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** operator (mdopp)
- **Related:** [ADR 0004](0004-installs-are-non-destructive.md), CONTRIBUTING.md

## Context

Versions are owned by **release-please**, which bumps `package.json`,
`package-lock.json`, `.release-please-manifest.json`, the `CHANGELOG.md`, and
cuts the GitHub release + tag when its release PR is merged. Two recurring
failure modes motivated writing this down:

1. **Manual version bumps** drift from release-please's manifest and corrupt
   the next release PR.
2. **release-please silently cuts no PR** when a merged commit message can't be
   parsed: a non-numeric parenthetical like `(#credential-loss)`, or
   parens-heavy code in the body (`JSON.parse(x.slice(...))`), makes the
   conventional-commit parser log *"commit could not be parsed … unexpected
   token '('"* and report `0 commits`. The workflow runs **green** but opens no
   release PR (hit 2026-05-22, PR #828). GitHub squash-merge of a single-commit
   PR uses that commit's message verbatim, so a sloppy local subject reaches
   `main`.

## Decision

1. **Never hand-edit version fields.** release-please is the only path that
   changes versions/changelog/tags. The only release action is **merging the
   release-please PR** (branch `release-please--branches--main--components--servicebay`).
2. **Commit subjects are `type(scope): description`** with at most a **numeric**
   `(#NNN)` PR reference. No `(#word)` tokens; no parens-heavy code snippets in
   commit bodies — they break release-please's parser.
3. **Batch coupled work into one PR/release.** Run CI/release/rebuild gates once
   at the end and release at the box's reinstall/update boundary, not per step.
   Split only genuinely independent or risky work.

## Consequences

- If a release PR never appears after a merge to `main`, **check the
  release-please workflow log for "could not be parsed"** before assuming the
  merge was fine. `main` is **not** branch-protected, so the fix is to reword
  the offending commit (`git commit --amend`, parens-free body) and force-push,
  which re-triggers release-please.
- Per-step releasing is avoided because the CI + release + sb-tui-rebuild tax
  dominates for coupled changes.
