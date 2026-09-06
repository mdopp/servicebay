---
title: Solaris — structure & capabilities (orientation)
whenToUse: You need to understand what Solaris (the household AI assistant) is, how it's structured, and how it relates to ServiceBay — before working on it or answering questions about it.
kind: guide
tags: [solaris, solarisbay, household-ai, voice, llama, llm, home-assistant, overview, orientation]
---

# Solaris — what it is and what it can do

Solaris (repo `mdopp/solarisbay`) is a **private household AI assistant** that
ServiceBay deploys as a one-click tier. It runs entirely on the box — voice at
home, chat in the browser, one agent with long memory, per-resident privacy,
and real control of the house through Home Assistant. Nothing leaves the house
without an explicit, audited opt-in.

> Note: `solbay-architecture.md` in the ServiceBay repo is **stale** (a pre-v0.10
> design that mentioned an external agent gateway — no longer used). The current
> architecture is the native **Solaris Engine**; see `mdopp/solarisbay` `README.md` /
> `solaris-architecture.md` for the canonical picture.

## Structure (repo `mdopp/solarisbay`)
- **`solaris-chat/`** — the Solaris Engine: one process owning the agent loop
  (direct llama-server `/v1/chat/completions`, per-turn model + reasoning), the
  session store (`solaris.db`, SQLite/WAL), tracing, timer scheduler, tool
  registry, and the browser chat surface (SSO-gated).
- **`voice-gatekeeper/`** — the Wyoming/Voice PE path: identity-by-voice and the
  distributed-satellite bridge into HA's Assist pipeline.
- **`tts-martin/`** — the local GPU TTS voice ("Martin").
- **`templates/` + `stacks/`** — ServiceBay templates (`llama`, `solaris`) and
  the `solarisbay` stack, consumed by ServiceBay as an **external registry**.
- **`database/`, `docs/`, `scripts/`** — schema, docs, box tooling.

## Capabilities
- **One conversation** — voice at home (HA Voice PE via ESPHome → whisper GPU
  STT → engine → Martin GPU TTS) and browser chat, same agent + memory. A spoken
  turn answers in ≈1.3 s after speech end.
- **Local inference** — one llama.cpp **`llama-server`** on the box GPU (RTX 2000
  Ada 16 GB), shipped as the solarisbay **`llama`** template: host network, port
  **11435**, OpenAI-compatible (`POST /v1/chat/completions`, `/v1/embeddings`,
  plus `/props` and `/slots`). Models are **GGUF files under
  `${DATA_DIR}/llama/models/`** — no registry, no pull command. The household
  model is the alias **`gemma-4-e4b`** (gemma-4 e4b Q4_0 + MTP drafter + mmproj;
  speculative decoding roughly halves the answer latency). No cloud LLM unless
  explicitly opted in.
  *History: until 2026-09 this was Ollama on 11434 with `gemma4:e2b` /
  `gemma4:12b` / `nomic-embed-text`. Ollama is retired (operator decision,
  solarisbay#1332) — nothing new is built against it.*
- **Addressing the model server** (ADR 0007 — never a LAN IP): a service on the
  **host network** uses `http://127.0.0.1:11435`; an **isolated pod** uses
  `http://host.containers.internal:11435`. Today only the first path answers —
  llama-server still binds loopback only, and the pod-reachable listener lands
  with mdopp/solarisbay#1344. Don't promise an isolated consumer that 11435 is
  reachable yet.
- **One server, several profiles, switched through the model lease** — a
  neighbouring service that needs a different model asks over HTTP, never by
  running the lease script: `POST` / `GET` / `DELETE`
  `http://127.0.0.1:8787/api/model-lease` (loopback, no token). `POST
  {"model":"foundry","ttl_s":900}` answers `200 ready` with the alias, `202
  preparing` with a `retry_after` to poll, or `409 held` when someone else holds
  it; `DELETE` releases it, and an expired lease falls back to the household
  model on its own. Read which model actually answered from the `model` field of
  the `/v1` response — never from your own setting.
- **Home control** — drives lights/heating/scenes/timers through Home Assistant
  (the engine calls HA tools; HA fronts the Voice PE speaker).
- **Long memory** — the household's documents/appointments/decisions woven into
  something the assistant can query; a notes vault + `solaris.db`.
- **Per-resident privacy** — each resident has their own memory namespace and
  tool scope; guests get a locked-down world. Voice is identity.
- **Admin via ServiceBay MCP** — admin-only turns can reach the ServiceBay MCP to
  operate the box.

## How it relates to ServiceBay
Solaris is a **consumer** of the ServiceBay platform: ServiceBay provides the
install/reconcile runner, reverse proxy + SSO, identity, backup, health, and the
box itself; Solaris ships as templates in an external registry and installs like
any other service. Generic capabilities belong in ServiceBay (or upstream), not
in Solaris.

## Related assists
`servicebay-overview` (the platform underneath), `create-service`,
`new-service-architecture`.
