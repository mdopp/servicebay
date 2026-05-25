# Hermes Agent

[Hermes Agent](https://hermes-agent.nousresearch.com/) is a
self-improving autonomous AI agent runtime by Nous Research. This
template wraps the upstream image
(`docker.io/nousresearch/hermes-agent:latest`) into a single
ServiceBay pod that:

- runs the gateway (`gateway run`) so messaging-platform gateways
  (Signal, Telegram, Discord, …) and the API server are live on
  first start;
- depends on the `ollama` template — Hermes' default LLM provider
  points at `127.0.0.1:11434`;
- ships **no operator-facing `podman exec` setup step.** Per
  `docs/UX_PHILOSOPHY.md` § 2, first-boot configuration is driven
  non-interactively from `post-deploy.py` — see below.

## Variables

- `HERMES_API_PORT` — host port. Default `8642`. Loopback-only.
- `HERMES_API_KEY` — bearer token, auto-generated, surfaced as
  a credential.
- `HERMES_LLM_PROVIDER_URL` — OpenAI-compatible LLM endpoint.
  Default `http://127.0.0.1:11434/v1` (the `ollama` template).
- `HERMES_LLM_MODEL` — model tag for the LLM provider. Default
  `gemma3:4b`.
- `HERMES_DASHBOARD_PORT` — host loopback port for the web
  dashboard. Default `9119`.
- `HERMES_SUBDOMAIN` — subdomain for the dashboard. Default
  `hermes`; internal exposure, behind Authelia forward-auth.

## What `post-deploy.py` does

1. Waits for the data volume (`${DATA_DIR}/hermes`) — `hostPath:
   DirectoryOrCreate` makes it exist before the container starts.
2. Writes `${DATA_DIR}/hermes/config.yaml` with the wizard-collected
   model provider, model name, and base URL. This file is what
   Hermes' main loop reads on every start, so changes apply
   immediately.
3. Restarts the pod so Hermes picks up the new config.
4. Surfaces `HERMES_API_KEY` as a `__SB_CREDENTIAL__` for the
   install banner.

No `hermes setup` interactive wizard is invoked — the only thing
that command does on first start is write `.env` and `config.yaml`,
and we write the relevant fields ourselves. The Hermes image's
entrypoint takes care of bootstrapping the rest (Honcho DB,
FTS5 index, SOUL.md skeleton) idempotently on each start.

## Multimodal (image-bearing) chats

Hermes' generated `config.yaml` writes a single `model:` block, so
every turn — text-only or image-bearing — goes through the same
model tag. If you want OSCAR's `media-ingestion-multimodal` skill
(book covers, document photos) to actually OCR images instead of
returning "I can't see images", the model you point `HERMES_LLM_MODEL`
at must itself be vision-capable.

Two ways to get there:

1. **Single multimodal model.** Pull a vision-capable tag in
   `ollama` (set `OLLAMA_DEFAULT_MODEL=qwen2.5vl:7b` or similar)
   and set `HERMES_LLM_MODEL` to the same tag. Vision models
   handle text-only turns fine, so a single model covers both
   cases. Simplest setup.
2. **Two models in parallel (text fast, vision on demand).** Keep
   `OLLAMA_DEFAULT_MODEL=gemma3:4b` for low-latency text turns and
   set `OLLAMA_VISION_MODEL=qwen2.5vl:7b` to pre-pull the vision
   model. Routing image-bearing turns to the vision model is
   pending upstream Hermes support — until then, point
   `HERMES_LLM_MODEL` at the vision tag when running the media
   pipeline.

## Adding MCP servers

Per the upstream
[MCP config reference](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference),
MCP servers are configured in `config.yaml` under a top-level
`mcp_servers:` key — **not** through an HTTP route. There is no
`POST /mcp/servers` endpoint on the API server. Two ways to wire
new servers from a script:

1. **Merge into `config.yaml` from another template's `post-deploy.py`.**
   Read the existing `${DATA_DIR}/hermes/config.yaml` (the `model:`
   block this template wrote), splice in an `mcp_servers:` section,
   write back, and trigger a pod restart via
   `POST /api/services/hermes/action {action: "restart"}`. That's
   the path OSCAR's `oscar-household` template takes.
2. **Hand-edit and reload.** `hermes config edit`, add the
   `mcp_servers:` block, then send `/reload-mcp` in any active
   gateway session. Interactive — fine for one-off changes from a
   running gateway, not from a deploy script.

There's no documented non-interactive `/reload-mcp` HTTP trigger,
so scripted reconfiguration restarts the pod.

## Connecting messaging gateways (Signal, Telegram, …)

These have **a genuinely interactive step that neither side of a
ServiceBay deploy can do**. Signal is the clearest case:

1. **Operator runs `signal-cli link -n "HermesAgent"`** to generate
   a linking QR code. The QR has to be scanned by the operator's
   physical phone via the Signal app. This step is irreducibly
   manual — no daemon and no script can do it.
2. **Hermes-side configuration** (SIGNAL_HTTP_URL, SIGNAL_ACCOUNT,
   SIGNAL_ALLOWED_USERS, …) lands in `${DATA_DIR}/hermes/.env` and
   *is* env-driven, so it can be scripted by a downstream template
   (e.g. OSCAR's `oscar-household`) once the operator has done the
   QR scan.

The boundary is: **pairing is manual, env-var wiring after pairing
is scriptable.** Downstream templates can drive step 2 but never
step 1.

After pairing, the gateway runs automatically because this template
starts Hermes with `gateway run`. Manual operator path to do the
QR pairing once after install (see the
[Signal setup docs](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/signal)):

```
podman exec -it hermes signal-cli link -n "HermesAgent"
# scan the QR with the operator's phone; signal-cli writes
# credentials into the Hermes data volume.
```

This contradicts the no-`podman exec` policy from
`UX_PHILOSOPHY.md`, but the policy applies to *required deploy-time
steps*, not *post-install optional* operator actions. The same
applies to other messaging platforms (Telegram bot-token paste,
Discord OAuth, etc.) — those have a one-time interactive setup
before the bot is paired with a chat account.

## Dashboard

The Hermes web dashboard (config, API keys, sessions) runs in its own
`hermes-dashboard` container and is on by default. It is a separate
`hermes dashboard` process — `hermes gateway run` does not start it, and
the `HERMES_DASHBOARD*` env vars are not read — so it cannot share the
gateway container. Both containers share the `/opt/data` Hermes home.

It binds `127.0.0.1:HERMES_DASHBOARD_PORT` (default `9119`) and is
reached at `https://<HERMES_SUBDOMAIN>.<PUBLIC_DOMAIN>` (default
`hermes.<domain>`): the `HERMES_SUBDOMAIN` variable auto-registers an
internal-exposure NPM proxy host behind Authelia forward-auth, so the
dashboard is LAN-only and SSO-gated. Because it surfaces API keys it is
never bound to a LAN-reachable address (no `--insecure`).

## Storage

Everything Hermes persists — Honcho user model, FTS5 conversation
index, SOUL.md, sessions, memories, skills, cron jobs, hooks,
logs — lives in `${DATA_DIR}/hermes/`. Back it up like any other
SQLite-backed service: stop the pod, copy the directory, restart.

## Health checks

Baseline `service:hermes` is auto-created. Hermes also exposes
**HTTP health endpoints** documented at the
[API-server reference](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server):

- `GET /health` → `{"status": "ok"}`
- `GET /v1/health` → same content, for OpenAI-compatible clients
- `GET /health/detailed` → extended report (active sessions,
  running agents, resource usage)

Whether `/health` is exempt from `API_SERVER_KEY` bearer auth is
not explicitly called out in the docs (the auth section frames
auth as a property of the API server as a whole). Test against
your install before wiring an `http`-type ServiceBay check at this
endpoint — if bearer auth is enforced, fall back to a
`script`-type check that does
`curl -H "Authorization: Bearer $HERMES_API_KEY" http://127.0.0.1:<port>/health`
(or use `/health/detailed` for richer signal).

See `docs/TEMPLATE_AUTHORING.md` § Health checks for the
contract; the auto-created `service:hermes` is the safe baseline
either way.

## Logging

Hermes' upstream image writes human-readable text to stdout —
`get_container_logs` works as-is. `post-deploy.py` emits
JSON-shaped lines per `docs/TEMPLATE_LOGGING.md` for the events
under its control (config write, restart, ready).

## See also

- [stacks/ai-stack/README.md](../../stacks/ai-stack/README.md) —
  walkthrough that pairs this template with `ollama`.
- Upstream Docker docs: <https://hermes-agent.nousresearch.com/docs/user-guide/docker>
