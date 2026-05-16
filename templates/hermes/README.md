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
- `HERMES_DASHBOARD_PORT` — leave blank to skip the dashboard
  (default); set to a port to enable, gated behind Authelia
  forward-auth.

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

## Connecting messaging gateways (Signal, Telegram, …)

These are **post-install, interactive** flows (QR-code scan for
Signal device-link, bot-token paste for Telegram). They don't
belong in `post-deploy.py`. Two options:

- **OSCAR's `oscar-household` template** — if you're running OSCAR,
  the household pod handles Signal pairing and `hermes mcp add`
  wiring. See `mdopp/oscar/templates/oscar-household/`.
- **Manual.** SSH into the host and:
  ```
  podman exec -it hermes hermes gateway setup signal
  podman exec -it hermes hermes mcp add <name> <url> <token>
  ```
  Yes, this contradicts the no-`podman exec` policy. The policy
  applies to *required deploy-time* steps, not to *post-install
  optional* operator actions taken later. Document any gateway you
  add in your own runbook.

If you find yourself wiring the same gateway on every household,
that's a signal to push the pairing flow upstream into Hermes
(env-var or CLI-flag-driven) and update this template.

## Dashboard (optional)

Setting `HERMES_DASHBOARD_PORT` to e.g. `9119` enables the in-browser
dashboard on 127.0.0.1:9119. To make it reachable remotely with
SSO:

1. Add an NPM proxy host for `hermes.<PUBLIC_DOMAIN>` → `http://127.0.0.1:9119`.
2. In Advanced → Custom Nginx Configuration, paste the
   `__authelia_forward_auth__` sentinel (or use the AdGuard /
   Syncthing admin pages as a copy-paste source — see
   `src/lib/stackInstall/forwardAuth.ts`).
3. Add the resulting subdomain to Authelia's access-control rules.

A future template version may collapse this into a `subdomain`-typed
variable that auto-registers the proxy host with forward-auth, once
the dashboard's TLS+auth assumptions are validated end-to-end.

## Storage

Everything Hermes persists — Honcho user model, FTS5 conversation
index, SOUL.md, sessions, memories, skills, cron jobs, hooks,
logs — lives in `${DATA_DIR}/hermes/`. Back it up like any other
SQLite-backed service: stop the pod, copy the directory, restart.

## Health checks

Baseline `service:hermes` is auto-created. No HTTP health endpoint
is documented upstream, so no `http` check is added — degraded API
states surface via the auto-created service check and the install
log. Add a `script`-type check from the wizard if you want a
custom probe (e.g. "the SQLite file is readable").

See `docs/TEMPLATE_AUTHORING.md` § Health checks.

## Logging

Hermes' upstream image writes human-readable text to stdout —
`get_container_logs` works as-is. `post-deploy.py` emits
JSON-shaped lines per `docs/TEMPLATE_LOGGING.md` for the events
under its control (config write, restart, ready).

## See also

- [stacks/ai-stack/README.md](../../stacks/ai-stack/README.md) —
  walkthrough that pairs this template with `ollama`.
- Upstream Docker docs: <https://hermes-agent.nousresearch.com/docs/user-guide/docker>
