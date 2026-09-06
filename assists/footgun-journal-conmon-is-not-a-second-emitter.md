---
title: "`_COMM=conmon` in ServiceBay's journal is ServiceBay's own stdout, not a second emitter"
whenToUse: You are reading or MEASURING `journalctl --user -u servicebay` (or `DATA_DIR/logs.db`) — hunting a secret leak, chasing a truncated line, counting entries, or about to report that a logging fix works. Read this before splitting on `_COMM`, before filing "not our code", and before trusting a probe that found zero of something.
kind: footgun
tags: [journal, journalctl, conmon, podman, quadlet, logging, secrets, redaction, logs.db, box-verify, troubleshooting]
---

# `_COMM=conmon` tells you nothing about who wrote the line

**Answer first:** ServiceBay itself runs from its own `.container` Podman
**Quadlet** unit, which systemd generates into `servicebay.service`. Its
stdout/stderr is relayed into the journal by **conmon**, podman's container
monitor. So *every* entry in `journalctl --user -u servicebay` carries
`_COMM=conmon` — the healthy ones and the leaking ones alike.

Splitting the journal on `_COMM` therefore separates nothing. It only invents a
second emitter that does not exist, and the natural next sentence — "that's
podman's own behaviour, not ours to fix" — is how a live leak from our own code
gets closed as out of scope.

The same applies to any managed service: a container's stdout reaches the
journal through conmon, so `_COMM` identifies the *relay*, never the author.
The author is in the payload — ServiceBay's own log prefix
(`<date> <time> LEVEL [Source]`, e.g. `[Agent:<node>]`, `[Server]`).

## Trap 2: conmon chunks a long line at 8192 bytes

One large log message — the agent's state sync is comfortably 150 KB — does not
arrive as one journal entry. conmon splits it into ~8192-byte pieces and each
piece becomes its own entry, with only the first carrying ServiceBay's log
prefix. Consequences, all of which have produced wrong numbers:

- **Counting entries mis-measures.** "3 entries carried X" can mean three
  fragments of a single message, or three whole messages. They are not
  comparable.
- **A line-wise `grep` sees fragments.** A key and its value can land either
  side of a chunk boundary, so a regex that matches "key=value" finds nothing
  while the value is plainly there.
- **`JSON.parse` fails on any single entry.** You must rejoin the chunks first:
  a message starts at the next line whose body matches ServiceBay's log prefix;
  every line without one continues the current message.

## Trap 3: `-o json` cannot show you a control character

journald stores a field whose value is not clean UTF-8 — anything carrying an
ANSI escape, for instance — as an **array of byte values**, not as a string. So
a text pattern searching `-o json` output for `\u001b` or a literal ESC finds
**zero** on a journal that is full of them. That false zero has already been
reported as "the fix works" for a fix that had not shipped yet.

Count escapes on `-o cat`, where the bytes are the bytes:

```bash
journalctl --user -u servicebay --since "<t>" --no-pager -o cat \
  | awk '{ if (index($0, sprintf("%c",27))>0) a++ } END{ print a+0 }'
```

## Trap 4: the blank line after every entry is podman's, and is not a defect

Podman's journald log driver keeps the line terminator **inside** `MESSAGE`:

```
"MESSAGE":"1788097613: New connection from 10.89.0.36:57340 on port 1883.\n"
```

`journalctl -o cat` appends its own newline on top, so every entry is followed
by a blank line — for `radicale`, `mosquitto` and every other service on the
box, not just ServiceBay. Counting those blanks once produced "96,409 of
202,055 lines (47.7%) are blank", read as a ServiceBay bug, fixed, released,
and then found to be nobody's bug at all.

If you are measuring the *application*, count entries (`-o json | wc -l`) or
bytes; `-o cat` line counts are for finding escapes and reading context.

## Before you trust an absence, prove the probe can find the thing

Every one of the traps above produced a **green** reading on a broken box. So a
journal probe is only evidence once it has failed on purpose:

1. Run it against the **known-broken** version first (on `:latest`, before the
   flip). It must come out RED. A probe that cannot fail cannot pass.
2. Give it a **minimum denominator**. Zero hits over zero lines is not an
   absence — after a `:dev` flip the journal starts empty, so wait for traffic
   (bounded) and treat "too few lines" as RED, not as green.
3. Derive the time cut **locally**. `podman inspect` prints
   `2026-08-30 14:05:25.720478223 +0000 UTC`, which `date -d` refuses; the empty
   string that fell out of it made `journalctl --since ""` match nothing and
   "prove" a fix three times over.

## Do this instead

Use the committed probe rather than an ad-hoc `journalctl` pipeline — it does
the rejoining, keys on the structural signal, and prints shape only:

```bash
npm run autoloop:journal-redaction -- --since <unix seconds>
```

It asserts one invariant: in a structured agent log line, a `content` field must
be a `<N chars redacted>` size marker, never a systemd unit body. Source:
`scripts/check-journal-redaction.ts`.

Two things to know before you read its verdict:

- **You cannot see the secret from a read tool, and that is fine.** The
  read-scoped MCP `get_logs` masks secret values on the way out
  (`packages/backend/src/lib/mcp/redact.ts`), so a value you fetch may already
  read `<redacted>` while the journal on disk holds the plaintext. Judge the
  *structure* ("a unit body sits where a size marker belongs"), never the
  presence of a visible secret — and never reach for `exec_command` to see the
  raw bytes.
- **Always pass `--since`.** A red result over an old window is history: the
  journal still holds what a pre-fix image wrote, and no code change undoes
  that. Scope the probe to after the box picked up the image under test to
  answer "is it leaking *now*". If the old entries are the ones that lit up,
  the action is credential rotation
  (`assists/recipe-rotate-a-service-secret.md`), not a code fix.

## Where the redaction actually lives

Four sinks, two independent families — don't stop at the first family when
you're chasing a leak or clearing one as fixed.

**Agent-payload sinks** — the structured `content` field, and keys shaped like
`TOKEN|SECRET|PASSWORD|API_KEY`. Deliberately redundant so a stale agent cannot
reopen the hole:

- `packages/backend/src/lib/agent/v4/agent.py` — `_redact_for_log`, applied
  inside `log_structured` (the sink, not the call sites).
- `packages/backend/src/lib/agent/handler.ts` — `redactForLog` /
  `redactStructuredLogLine`, applied to every structured line the backend
  writes, so a box running an older agent is still covered.

Both replace every `content` string with `<N chars redacted>` at any depth.

**`Environment=` assignment sinks (#2833/#2836)** — a different shape entirely:
a quadlet/unit body travels as a flattened shell ARGUMENT (`Received command: …
Payload: {…}`, or a `Command failed: <command>` error), with no `content` key
to walk to. This is the shape that got measured as "10 leaking lines, 0
redacted `content` fields" — the agent-payload sinks above cannot see it at
all:

- `packages/backend/src/lib/log-format.ts` — `redactEnvironmentAssignments`
  (using `isSecretEnvName` from `mcp/redact.ts`), applied inside
  `toSingleJournalLine`. This is the **console/journal** sink: every line
  either logger funnels through here before it reaches journald.
- `packages/backend/src/lib/logger.ts` — `Logger.insertLog` (#2836) applies the
  same redactor to the row **before** it reaches `DATA_DIR/logs.db`. This is
  the **DB** sink, and it's a separate fix on purpose: `insertLog` used to
  write the raw message straight into logs.db, where it sits for the full
  7-day retention window and is read back by `queryLogs` and the log viewer —
  masking only the console funnel left that row (and the `onLog` socket
  broadcast built from it) holding the plaintext.

Both `Environment=` sites replace the value with `<N chars redacted>` and are
**idempotent** (`isRedactedMarker`) — load-bearing, because the console path
runs the same redactor a second time over a message `insertLog` already
masked, and re-redacting a marker as if it were a fresh secret would corrupt
the reported length.

Adding a new place that logs an agent payload means routing it through the
agent-payload sinks; adding a new place that could log a quadlet/unit body (or
anything else shaped like `Environment=NAME=value`) means routing it through
`toSingleJournalLine`/`insertLog`, never adding a redaction call at the new
call site.

**Probes, one per shape:**

- Agent-payload `content` shape: `npm run autoloop:journal-redaction`
  (`scripts/check-journal-redaction.ts`'s structured-content scan, described
  above).
- `Environment=` shape, journal side: the same script's `BARE_ENV_ASSIGNMENT`
  pass — flags any bare `Environment=<NAME ending in
  PASSWORD|PASS|TOKEN|SECRET|KEY>=<value>` in a message body (structured or
  plain prose) that isn't already a `<N chars redacted>` marker.
- `Environment=` shape, DB side: `tests/backend/logdb_env_redaction.test.ts`
  asserts against the **stored logs.db row** (read back through `queryLogs`),
  not a console spy — that's the only way to catch a leak that reaches the row
  directly and never touches the console funnel at all.

**Measuring rule for the DB sink:** the same `--since` discipline as the
journal probe above, extended to `logs.db` — a row written before the box
picked up the fix is history a pre-fix deploy already wrote at rest, and it
survives the full retention window regardless of any later code change.
Compare row timestamps against the deploy under test, not against "now": a
pre-fix row lighting up means rotate the credential
(`assists/recipe-rotate-a-service-secret.md`), not re-chase the code.
