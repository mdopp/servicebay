# open-webui — template changelog

## v2 (breaking) — #1030 follow-up

Routes Open WebUI through Hermes' OpenAI-compatible API instead of
talking directly to Ollama. The v1 wiring sent chats straight at
`OLLAMA_BASE_URL=http://127.0.0.1:OLLAMA_PORT` — that gave the
family a working chat surface, but every request bypassed Hermes'
agent loop, so:

- No `cloud_audit` rows for any chat (#921 audit logging was inert
  for this path).
- No holographic / honcho memory (intent #2 + #4 of #926
  unrealized for the chat surface).
- No OSCAR skill set available to the chat.

### What changed

- `template.yml`:
  - `OPENAI_API_BASE_URL=http://127.0.0.1:{{HERMES_API_PORT}}/v1`
    and `OPENAI_API_KEY={{HERMES_API_KEY}}` — Open WebUI now treats
    Hermes as a standard OpenAI-compatible backend.
  - `OLLAMA_BASE_URL=""` + `ENABLE_OLLAMA_API=false` — direct
    Ollama integration disabled so a stray Ollama tile in the
    settings UI can't re-create the bypass.
  - `servicebay.dependencies` adds `hermes` (was just
    `ollama,nginx,auth`).
- `README.md` updated to match.

### Required action for existing installs

None on disk — data (sessions, sessions, prompt presets) lives in
`/app/backend/data` (= `{{DATA_DIR}}/open-webui` on the host) and
is unaffected.

Re-deploying the template via the wizard's Configure → Save flow
re-renders `template.yml` with the new env, restarts the pod, and
the chat surface comes back routed through Hermes. Pre-existing
chat history stays visible; new turns flow through Hermes from
that point on.

## v1 — #1030

Initial release. Open WebUI behind NPM + Authelia at
`chat.<publicDomain>`, talking directly to Ollama. Replaced in
v2 by the Hermes-routed wiring above.
