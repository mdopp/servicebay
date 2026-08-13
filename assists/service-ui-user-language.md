---
title: Service UI language & state design — speak the user's language
whenToUse: You're writing any text a service UI renders — status lines, empty states, error messages, onboarding, settings labels — and need the rule for who the reader is, what a state must offer, and what must never leak into rendered HTML.
kind: guide
tags: [ui, ux, language, copy, states, empty-state, onboarding, settings, frontend, standard]
---

# Service UI language & state design

The companion to `service-ui-design-standard`. That one is about **how it
looks** (tokens, palette, focus states, mobile); this one is about **what it
says**. A service can pass every token rule and still be rejected by the
operator because its status texts quote a CLI command, name an env variable, or
describe a state the user cannot act on.

## The principle already exists — this is how it applies to a service UI

ServiceBay's own rule is **`docs/UX_PHILOSOPHY.md` §5 "User-facing language, not
infra language"**, plus the locked decision *"Progress and capacity displays
answer the household question"* in `docs/UX_DECISIONS.md`. Read those first —
they carry the bad/good pairs and the reasoning, and they are the source this
assist points at, not a parallel version of it. (Both ship inside the ServiceBay
image under `/app/docs/`.)

The short form: **the reader is a family-homelab operator, not the person who
wrote the service.** They are deciding something household-shaped ("is this
hung or normal?", "do I need a bigger disk?", "can I upload more photos?").
Every rendered string exists to answer that.

## What "honest status" means — and what it does not

"Honest" is not "technically transparent". A builder who reads *be honest about
state* as *print the state the code is in* ships exactly the UI this standard
exists to prevent. Honest means: **do not claim success you don't have, and do
not hide a stuck state** — it does not license leaking implementation nouns into
the page.

## The rules

### 1. Every state text says what the user can do and what happens next

A state that only reports the machine's condition is unfinished. Name the thing
in the user's world, then the next step.

- Bad: *"No batch entries found — run `python -m chronicle.compose`."*
- Good: *"Nothing has been composed yet. New entries appear here within a few
  minutes of the first import."* (…or a button that starts it.)

### 2. Implementation nouns never reach rendered HTML — and that is test-enforced

Banned in any string the browser renders: **CLI commands** (`python -m …`,
`podman …`, `systemctl …`), **env-var names** (`SCREAMING_SNAKE_CASE`), **HTTP
header names** (`Remote-User`, `X-Forwarded-*`), container/unit/table names, and
file paths inside the container. They belong in logs and in a diagnostics panel,
never in a user-facing state.

Make it a test, not a review habit — the same way ServiceBay machine-enforces
its token rule with `sb/no-raw-color-literal` (see
`docs/ARCHITECTURE_INVARIANTS.md` § *UI-primitive and design-token reuse*). The
cheap version, in the service's own suite:

```
render every page/state that has user-visible copy → assert the rendered text
matches none of: /\b(python|podman|systemctl|docker|npm) /, /\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/,
/\b(Remote-User|X-Forwarded-[A-Za-z-]+)\b/
```

Keep the allow-list explicit and small (a product name like `PostgreSQL` is
fine); a new leak then fails the suite instead of the operator's second review.

### 3. A named action the user cannot trigger is a product gap, not a text problem

If the empty state says "run the composer" and there is no button that runs the
composer, the fix is the button, not a reword. Rewording it to "the composer has
not run" ships the same dead end with better grammar. Either give the user the
control, or state the automatic condition that will resolve it ("this runs every
night; nothing to do").

### 4. Onboarding shows while its condition holds, not only on virgin state

Gating a wizard on "no data at all" means a real instance — one with a half-done
setup, or one that got data before it got configured — never sees it. Gate on
**the condition the wizard resolves** (no source configured, no destination
picked) and hide it when that condition clears. Same rule ServiceBay applies to
its own setup entry: visible while something is pending, hidden once acknowledged
(`docs/UX_DECISIONS.md` § *Primary sidebar is a user-task list*).

### 5. Settings group by user questions, not by config structure

Group by *"what do I want to do?"* — not by which file or object the value lives
in. A settings page that mirrors the config schema forces the user to learn the
implementation to change one thing. (ServiceBay's own settings IA decision:
goal-based groups with tiered disclosure, `docs/UX_DECISIONS.md`.)

### 6. Progress and capacity answer the household question

Raw counters (`7/12 images pulled`, `42.7 GB / 256 GB · 16.7%`) are the
*details* view, not the headline. Lead with the decision the user is making
("about 2 minutes to go", "~3 years of photos left at your current rate") and
keep the raw numbers one expand away for whoever wants them.

## Before you ship a frontend

Read your own rendered strings as the operator: for each one, name the question
it answers and the action it enables. Anything that fails that pass is either
copy to rewrite, a control to add, or a line that belongs in the log. If a rule
here was missing, ambiguous, or wrong when you needed it, report it back —
`get_assist("report-standards-gaps")`.
