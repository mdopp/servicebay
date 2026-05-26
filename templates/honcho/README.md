# Honcho — per-user memory store for Hermes / OSCAR

[Honcho](https://github.com/plastic-labs/honcho) is a FastAPI service
that exposes a *peer isolation* API on top of a Postgres + pgvector
backend. ServiceBay deploys it alongside Hermes so each LLDAP user
gets a private memory partition — voice + chat sessions for one
family member never leak context into another's.

## What ships in this template

Two containers in a single hostNetwork pod:

1. **honcho** — `ghcr.io/plastic-labs/honcho:latest`, bound to
   `127.0.0.1:{{HONCHO_PORT}}` (default `8652`).
2. **honcho-postgres** — `docker.io/pgvector/pgvector:pg16`, bound to
   `127.0.0.1:{{HONCHO_POSTGRES_PORT}}` (default `5532`). Honcho is
   the only consumer.

Both are loopback-only by design. No subdomain, no NPM proxy: the
intended consumer is Hermes' memory plugin reaching `127.0.0.1` from
inside another hostNetwork pod on the same box.

## How Hermes picks it up

`templates/hermes/post-deploy.py` probes
`http://127.0.0.1:{{HONCHO_PORT}}/health` at deploy time:

- **Reachable** → writes `memory.provider: honcho` plus the
  `honcho:` block (api_url + api_key) into `hermes/config.yaml`.
- **Unreachable** → falls back to `memory.provider: holographic`
  (the default, suitable for a single-resident install).

Hermes already supports `memory.provider: honcho` via its own
`plugins/memory/honcho/` module. ServiceBay's gateway/platforms
modules inject a per-session `user_id` derived from the Authelia /
LLDAP claims; the honcho plugin maps that to `peer_id`, so two
family members chatting in two browser tabs (or two voice
satellites) get independent memory.

## Out of scope

- **Migration from `holographic`** — first install only. The
  operator decides whether to wipe the holographic store after
  switching, since there's no clean per-user mapping in the
  shared store.
- **Admin UI for Honcho** — the upstream project doesn't ship one
  by default. If a future Honcho release adds one, a follow-up
  template can issue a real subdomain + NPM entry.
