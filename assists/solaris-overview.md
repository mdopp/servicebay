---
title: Solaris — structure & capabilities (orientation)
whenToUse: You need to understand what Solaris (the household AI assistant) is, how it's structured, and how it relates to ServiceBay — before working on it or answering questions about it.
kind: guide
tags: [solaris, solarisbay, household-ai, voice, ollama, home-assistant, overview, orientation]
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
  (direct Ollama `/api/chat`, per-turn model + reasoning), the session store
  (`solaris.db`, SQLite/WAL), tracing, timer scheduler, tool registry, and the
  browser chat surface (SSO-gated).
- **`voice-gatekeeper/`** — the Wyoming/Voice PE path: identity-by-voice and the
  distributed-satellite bridge into HA's Assist pipeline.
- **`tts-martin/`** — the local GPU TTS voice ("Martin").
- **`templates/` + `stacks/`** — ServiceBay templates (`ollama`, `solaris`) and
  the `solarisbay` stack, consumed by ServiceBay as an **external registry**.
- **`database/`, `docs/`, `scripts/`** — schema, docs, box tooling.

## Capabilities
- **One conversation** — voice at home (HA Voice PE via ESPHome → whisper GPU
  STT → engine → Martin GPU TTS) and browser chat, same agent + memory. A spoken
  turn answers in ≈1.3 s after speech end.
- **Local inference** — Ollama on the box GPU (RTX 2000 Ada 16 GB) with resident
  models: `gemma4:e2b` (fast/voice), `gemma4:12b` (thorough/admin),
  `nomic-embed-text` (embeddings). No cloud LLM unless explicitly opted in.
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
