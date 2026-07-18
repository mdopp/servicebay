---
title: Generic project standards — platform-agnostic dev discipline
whenToUse: You want the provider- and platform-agnostic development standards (commit convention, release discipline, coverage floor, secret hygiene, scripts-over-prose) for any new project, without the ServiceBay-specific ADRs or template details.
kind: checklist
tags: [standards, generic, commit-convention, release, coverage, secret-hygiene, index]
---

# Generic project standards

Platform-agnostic development discipline for building any new project. No
ServiceBay-specific ADRs or template details — those live in the `servicebay`
flavor of `get_service_standards`. Fetch that flavor when you're inside this
repo; use this one for a fresh, unrelated project.

## commitConvention — Conventional Commits

Commit subjects follow `type(scope): description` (e.g. `fix(api): reject empty
body`). Keep the subject parser-clean — no extra parentheses beyond the
conventional `(scope)`, since release tooling parses these.

## releaseDiscipline — never hand-bump versions

Releases are automated from the commit history (the release-please principle):
never edit a version, changelog, or release manifest by hand. Let the release
tool derive the next version from the Conventional Commits since the last tag.

## testAndCoverage — a diff-coverage floor

New and changed code carries tests. Hold a **diff-coverage floor of 70 %** on
changed lines — a change that drops coverage on the lines it touches doesn't
merge. Prefer a test that encodes each acceptance criterion so it can't silently
regress later.

## secretHygiene — no literal secrets in the repo

Committed files (source, tests, fixtures, docs) contain **no** real secrets: no
private keys, API tokens, passwords, or bearer credentials. Express secrets as
typed variables injected at deploy/runtime; placeholders are fine, concrete
values are not. Assume any secret-scanning backstop won't catch every shape —
be careful at the source.

## scriptsOverProse — deterministic steps belong in scripts

Deterministic, repeatable steps belong in a checked-in script, not in prose an
agent re-interprets each run. Reserve human/LLM judgment for what to verify and
why a failure happened; let a script run the mechanics (fixed flags, hard-capped
polls, guaranteed cleanup) — cheaper and zero-variance.
