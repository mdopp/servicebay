# open-webui

[Open WebUI](https://github.com/open-webui/open-webui) — the
self-hosted, ChatGPT-style frontend that talks to Ollama (and any
OpenAI-compatible endpoint). Closes #1030: gives every household
resident a working "chat with the local LLM" path at
`https://chat.<publicDomain>/` without standing up Discord, Telegram,
or Signal gateways.

## What it does

1. **Runs Open WebUI's pod** behind NPM + Authelia at the operator's
   `<OPEN_WEBUI_SUBDOMAIN>` (default `chat`). One-factor login via
   Authelia is enough — there's no second auth wall once you're in.
2. **Routes through Hermes** via the OpenAI-compatible API:
   `OPENAI_API_BASE_URL=http://127.0.0.1:<HERMES_API_PORT>/v1` with
   the auto-generated `HERMES_API_KEY` as the bearer token. Every
   chat goes through Hermes' agent loop — tool calls, holographic /
   honcho memory, `cloud_audit` logging (#921), the OSCAR skill
   set. Hermes in turn talks to the local Ollama; the underlying
   model is whatever Hermes' `config.yaml` has set.
3. **Bootstraps the admin account** on first visit — the first user
   to create an account becomes the in-app admin. Subsequent users
   are added from Settings → Users.

The direct-to-Ollama Open WebUI integration is explicitly disabled
(`ENABLE_OLLAMA_API=false`, `OLLAMA_BASE_URL=""`) so the chat
surface can't accidentally bypass Hermes — that bypass would skip
the audit log, the memory layer, and any OSCAR-authored skill.

## Why we ship this

The household stack's first-class chat surface was the Hermes
dashboard at `hermes.<domain>` (operator-flavored, not the URL a
family member would guess) plus the messaging gateways (Discord /
Telegram / Signal — each one a third-party API + bot-token chain
that can break independently of the home server). Open WebUI sits
purely inside the box and reuses the Authelia layer every other
internal service already trusts, so it's the smallest possible
"works on day one" chat path. See #1030 for the design discussion.

## Variables

| Variable | Type | Purpose |
|---|---|---|
| `OPEN_WEBUI_PORT` | text | Host loopback port (default 8081). |
| `OPEN_WEBUI_SECRET` | secret | WEBUI_SECRET_KEY — signs the session cookie. Auto-generated. |
| `OPEN_WEBUI_SUBDOMAIN` | subdomain | `chat` by default. Internal exposure via NPM + Authelia forward-auth. |

## Dependencies

- `hermes` (agent loop; the actual backend Open WebUI talks to)
- `ollama` (Hermes uses it underneath; included for topo-sort sanity)
- `nginx` (NPM proxy)
- `auth` (Authelia + LLDAP)

## First-run notes

- On first visit at `https://chat.<publicDomain>/` Authelia challenges
  for a 1FA login; once authenticated, Open WebUI asks for an admin
  account name + password. The first account created is the admin.
- `ENABLE_SIGNUP` ships **on** because Open WebUI's first-account
  bootstrap requires it — there's no headless admin-create API.
  After your admin lands, flip "Enable New Sign Ups" off via the
  in-app Settings → Users panel if you want the operator-provisions-
  members policy. The Authelia layer gates the URL regardless.
- The model dropdown inside Open WebUI surfaces whatever Hermes'
  `/v1/models` returns — today that's a single `hermes-agent` entry.
  Hermes' `config.yaml` controls the underlying ollama model; change
  it via `hermes config set model.model <ollama-tag>` and restart
  Hermes. The Open WebUI side doesn't need a restart.

## Out of scope

- OIDC integration with Authelia. The forward-auth layer is enough
  for the "chat at chat.<domain>" use case; OIDC SSO would let Open
  WebUI auto-create accounts from Authelia, but it's an extra moving
  part we don't need on day one. Track as a follow-up if anyone
  wants single-sign-on inside the chat app too.
- Per-user model permissions. Operator-set today via Open WebUI's
  Settings → Models UI; the template doesn't pre-seed any
  per-resident policy.
