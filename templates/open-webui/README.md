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
2. **Pre-wires the LLM backend** to the local Ollama on host
   loopback (`OLLAMA_BASE_URL=http://127.0.0.1:<OLLAMA_PORT>`). The
   model list in the chat UI mirrors whatever's in `ollama list`.
3. **Bootstraps the admin account** on first visit — the first user
   to create an account becomes the in-app admin. Subsequent users
   are added from Settings → Users.

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

- `ollama` (LLM backend)
- `nginx` (NPM proxy)
- `auth` (Authelia + LLDAP)

## First-run notes

- On first visit at `https://chat.<publicDomain>/` Authelia challenges
  for a 1FA login; once authenticated, Open WebUI asks for an admin
  account name + password. The first account created is the admin.
- `ENABLE_SIGNUP` is `false` by default, so subsequent visitors can't
  self-register — the admin adds them from Settings → Users. Flip it
  back on (env var on the pod) if you want self-service; the
  Authelia layer still gates the URL either way.
- The model list inside Open WebUI is whatever `ollama list` returns
  at the time of the chat session start. Pulling a new model from
  Ollama (`ollama pull <name>`) makes it available without a UI
  restart.

## Out of scope

- OIDC integration with Authelia. The forward-auth layer is enough
  for the "chat at chat.<domain>" use case; OIDC SSO would let Open
  WebUI auto-create accounts from Authelia, but it's an extra moving
  part we don't need on day one. Track as a follow-up if anyone
  wants single-sign-on inside the chat app too.
- Per-user model permissions. Operator-set today via Open WebUI's
  Settings → Models UI; the template doesn't pre-seed any
  per-resident policy.
