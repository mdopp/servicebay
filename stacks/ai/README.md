# AI stack

Local-LLM agent runtime for ServiceBay — pairs `ollama` (model
runtime) with `hermes` (agent loop, messaging gateways, MCP
client). Adopters that want voice + per-resident identity on top
of this baseline should also look at the OSCAR project, which
consumes this stack as a prerequisite.

## Included Services

- [x] ollama — Local LLM runtime (HTTP API on 127.0.0.1:11434, optional NVIDIA GPU via CDI)
- [x] hermes — Hermes Agent (gateway runtime, OpenAI-compatible LLM client, MCP host)

## Phase 0 — chat-with-a-local-agent

Two templates, in order. The wizard topo-sorts these automatically
(`hermes` declares `servicebay.dependencies: "ollama"`), so if you
check both at once the deploy lands them in the right order.

### 1. `ollama`

Wizard variables you'll be prompted for:

| Variable | Default | Notes |
|---|---|---|
| `OLLAMA_PORT` | `11434` | Loopback-bound (`OLLAMA_HOST=127.0.0.1:<port>`). Don't change to `0.0.0.0` — Ollama ships no auth; the LAN-exposed surface should be NPM + Authelia (see template README). |
| `OLLAMA_DEFAULT_MODEL` | `gemma3:4b` | Any tag from <https://ollama.com/library>. Small CPU-friendly default; bump once you have GPU passthrough working. |
| `OLLAMA_GPU_PASSTHROUGH` | `""` | Leave blank for CPU. Set to any non-blank value (e.g. `yes`) for NVIDIA GPU via CDI. See template README for the host-side `nvidia-ctk cdi generate` setup. |
| `OLLAMA_READINESS_TIMEOUT_SECONDS` | `600` | Post-deploy waits this long for the first model pull. Multi-GB models on a slow link can take 10+ min. |

After deploy, `post-deploy.py` triggers an `/api/pull` of the
default model. The model lands in `${DATA_DIR}/ollama/` and
survives upgrades.

### 2. `hermes`

Wizard variables:

| Variable | Default | Notes |
|---|---|---|
| `HERMES_API_PORT` | `8642` | Loopback-bound. Other ServiceBay pods on this host reach it via host loopback (both pods are `hostNetwork: true`). |
| `HERMES_API_KEY` | _auto-generated_ | Surfaced in the SAVE-THESE-NOW credential banner after install. Paste into any client that needs to call Hermes' API (OSCAR's `oscar-household`, your own MCP servers). |
| `HERMES_LLM_PROVIDER_URL` | `http://127.0.0.1:11434/v1` | Points at the Ollama you just deployed. Override to use a different OpenAI-compatible endpoint. |
| `HERMES_LLM_MODEL` | `gemma3:4b` | Should match `OLLAMA_DEFAULT_MODEL` above. |
| `HERMES_DASHBOARD_PORT` | `""` | Leave blank to skip the dashboard. Set to a port (e.g. `9119`) to enable; bound to 127.0.0.1 and meant to live behind NPM + Authelia forward-auth. Optional for chat-only setups. |

`post-deploy.py` writes `${DATA_DIR}/hermes/config.yaml` with the
model + provider you picked, then restarts the pod so Hermes
boots wired to Ollama. **No `podman exec` or interactive setup is
needed** — everything `hermes setup` would have written
non-interactively is driven from the wizard's variables.

## What you have after deploy

- `http://127.0.0.1:11434` — Ollama API (use any OpenAI-SDK client)
- `http://127.0.0.1:8642` — Hermes' API, bearer-token-gated
- A `Service: ollama` and `Service: hermes` health check, plus an
  `ollama-api` HTTP check (registered by the post-deploy script)
- Hermes' data volume at `${DATA_DIR}/hermes/` — Honcho user model,
  FTS5 conversation index, skills, sessions, memories. Backup-safe.

## Post-install: messaging gateways

Hermes ships gateways for Signal, Telegram, Discord, Slack,
WhatsApp, and Email. **Pairing is interactive** — a QR scan or
bot-token paste — so it doesn't run as part of the ServiceBay
deploy. Two paths:

- **If you're running OSCAR:** the `oscar-household` template
  handles Signal pairing as part of its own post-deploy. See
  <https://github.com/mdopp/oscar>.
- **Manual:** SSH to the host and run
  `podman exec -it hermes hermes gateway setup <name>`. The
  command is upstream-driven; if its flags change, see the
  Hermes docs at <https://hermes-agent.nousresearch.com/docs/>.

## Deferred — Postgres + Qdrant

Earlier drafts of this stack included `postgres` and `qdrant`
templates. **They aren't part of Phase 0.** Hermes uses SQLite
(Honcho + FTS5) internally, and Ollama keeps its model weights in
a hostPath volume. Neither needs a network database.

A future consumer (OSCAR's Phase 3a — streaming ingestion into
domain collections; or another adopter with semantic-search
needs) may justify adding `postgres` and `qdrant` templates to
this stack. The addition is consumer-driven, not speculative —
this walkthrough is updated when the templates exist and an
adopter is ready to use them.

## See also

- [`templates/ollama/README.md`](../../templates/ollama/README.md)
- [`templates/hermes/README.md`](../../templates/hermes/README.md)
- [`docs/TEMPLATE_AUTHORING.md`](../../docs/TEMPLATE_AUTHORING.md) —
  the contract these templates implement.
- OSCAR architecture (consumes this stack): <https://github.com/mdopp/oscar>
