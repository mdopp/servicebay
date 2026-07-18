# Template logging

ServiceBay already stores every log entry it emits into a SQLite-backed
log store (`src/lib/logger.ts`), queryable via `/api/logs/query`. Each
entry has the shape:

```
{
  timestamp: ISO-8601 string,
  level:     'debug' | 'info' | 'warn' | 'error',
  tag:       string,            // source / component identifier
  message:   string,            // free-form text
  args:      unknown[]          // JSON-serialised payload
}
```

That covers the four things a log line needs: **when**, **who**,
**level**, **source**, plus free-form structured data. Templates whose
containers emit JSON-lines on stdout matching the same shape land in
the same searchable surface once the JSON-ingester is wired up.
Templates whose containers emit raw stdout work today via
`get_logs` (source="container" / source="podman", which stream stdout
verbatim) — they're just not searchable by structured fields.

## What to emit

One JSON object per line, on stdout, no log framework required:

```json
{"ts": "2026-05-16T10:24:18.512+02:00", "level": "info", "tag": "ollama-pull", "message": "model gemma3:4b ready", "args": {"trace_id": "8f12…", "bytes": 2810421824}}
```

| Field     | Required | Notes |
|-----------|----------|-------|
| `ts`      | yes      | ISO-8601 with offset. UTC works, local-with-offset is fine too. |
| `level`   | yes      | One of `debug`, `info`, `warn`, `error`. |
| `tag`     | yes      | Stable short identifier — typically the container name, or a sub-component (e.g. `nginx-proxy-manager:bootstrap`). Operators filter logs by tag, so make it predictable. |
| `message` | yes      | Short human-readable description of the event. |
| `args`    | optional | Any JSON-serialisable payload — `trace_id`, request body excerpts, durations. Goes into the queryable `args` column. |

Newlines inside `message` are fine but discouraged — split into
multiple entries when the message would span more than one screen
line.

## Levels

- `debug` — verbose, off by default. Templates that ship a debug
  toggle (env var, config file) flip this on themselves; ServiceBay
  doesn't impose a global debug switch on running services.
- `info` — normal operational events (deploys, completions, state
  transitions).
- `warn` — recoverable problems, retries, deprecations.
- `error` — unrecoverable failures that need attention. The diagnose
  panel surfaces error-level entries from the last 24h.

## Tags

A `tag` should describe **what produced the log line**, not what it's
about. Good tags:

- `ollama` — the Ollama container itself
- `ollama-pull` — the post-deploy.py model-pull step
- `nginx-proxy-manager` — the NPM container
- `hermes:gateway:signal` — Hermes' Signal gateway sub-component

Bad tags:

- `error`, `warning` — that belongs in `level`
- `request-12345` — that belongs in `args.trace_id`
- `Tue May 16 10:24` — that belongs in `ts`

## Secrets

**Components do their own redaction.** Bearer tokens, API keys,
passwords, OAuth secrets, OIDC client_secrets, JWT signing keys, and
PII (email addresses outside of the user's own SSO context, voice
recordings, biometric vectors) must never appear in cleartext in
logs. Two acceptable patterns:

- **Omit.** If a value isn't load-bearing for debugging, drop it.
  `args: {"token_present": true}` beats `args: {"token": "ey…"}`.
- **Hash.** When you need to correlate without leaking the value,
  log `args: {"token_hash": "<sha256-prefix-8>"}`.

The wizard's credential-banner machinery
(`__SB_CREDENTIAL__ {json}` markers in `post-deploy.py` stdout) is
the legitimate path for surfacing passwords; that pipeline is
separate from the log store.

## What ServiceBay does with the output today

- `get_logs` (source="container" / source="podman") MCP tool streams the raw
  stdout of a service's containers to the operator on demand.
- The journald shipper indexes by service name and timestamp, so
  searches by container + time window work without any structured
  parsing.
- A future follow-up will promote JSON-shaped stdout lines from
  templates into the same searchable SQLite log store ServiceBay's
  own logger writes to — at that point the `tag`, `level`, and
  `args.*` fields become queryable in the UI. Until that ships,
  emitting JSON costs nothing and unblocks adoption later.

## Worked example — bash one-liner from `post-deploy.py`

```python
def jlog(level: str, tag: str, message: str, **args: object) -> None:
    import json, sys, datetime
    sys.stdout.write(json.dumps({
        "ts": datetime.datetime.now().astimezone().isoformat(),
        "level": level,
        "tag": tag,
        "message": message,
        "args": args,
    }) + "\n")
    sys.stdout.flush()

jlog("info", "ollama-pull", "starting model pull", model="gemma3:4b")
```

No helper package. No dependency. Eight lines of Python that any
post-deploy.py can paste.

## See also

- [TEMPLATE_AUTHORING.md](TEMPLATE_AUTHORING.md) — the template
  contract; the `## Health checks` section there is the matching
  platform-level concern.
- `src/lib/logger.ts` — ServiceBay's own logger, the
  reference shape this contract mirrors.
