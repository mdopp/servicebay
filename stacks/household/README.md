# Household AI Assistant (OSCAR) Stack

The Household AI Assistant ("OSCAR") stack integrates local-first conversational AI, room voice satellites, local structured auditing, and Home Assistant smart home control into a cohesive, private, multi-user household system.

## Included Services

- [x] **ollama** — Local multimodal LLM runtime (requires **16GB GPU VRAM** for simultaneous visual and vocal processing).
- [x] **hermes** — Hermes Agent runtime (messaging gateways, conversational loops, and MCP host).
- [x] **home-assistant** — Smart home hub (device discovery and scripting).
- [x] **voice** — Wyoming-protocol local voice engines (Whisper STT + Piper TTS + openWakeWord).

---

## Hardware Requirements

> [!IMPORTANT]
> Because this stack runs a real-time local voice pipeline (Whisper-large-v3, Piper TTS) concurrently with a multimodal vision LLM (Gemma 4 / LLaVA / Qwen-VL) to extract book/document metadata from pictures, you **MUST** run this stack on a host with a dedicated GPU carrying at least **16GB VRAM** (e.g. NVIDIA RTX 4080, RTX 2000 Ada, or comparable).

---

## Onboarding Sequence: Three-Tier Deployment

We recommend deploying your household assistant in three logical tiers to ensure ease of testing, verification, and scaling.

### Tier 1: Baseline Chat Agent (≈ 5 minutes)
Verify the core agent loop and inference speed.
1. Deploy **`ollama`** and **`hermes`** via the ServiceBay Wizard.
2. Verify latency on your box using Hermes' interactive API or `/health` check.

### Tier 2: Smart Home Integration (≈ 15 minutes)
Connect your assistant to your physical devices with zero-code setup.
1. In Home Assistant, generate a **Long-lived Access Token** (Profile → Security → Long-lived access tokens).
2. Configure your `hermes` deployment with the following variables:
   * `HASS_URL` — Defaults to `http://127.0.0.1:8123` (reaches the `home-assistant` pod via host loopback).
   * `HASS_TOKEN` — Paste the long-lived token here.
3. Deploy. Hermes automatically mounts the native Home Assistant gateway and registers device-commanding tools (`light`, `switch`, `climate`, `media_player`).

### Tier 3: Full Multi-User Household Stack (≈ 30 minutes)
Activate room voice satellites, multimodal ingestion, and local structured log auditing.
1. Deploy the **`voice`** template (CTranslate2 Faster Whisper + Piper).
2. Deploy the `oscar-gatekeeper` sidecar pod.
3. Configure your voice satellites (HA Voice PE devices) to point at your ServiceBay host on port `10700` (the Wyoming gatekeeper port).
4. Pair your Signal messaging gateway:
   ```bash
   podman exec -it hermes signal-cli link -n "HermesAgent"
   # Scan the printed QR code with your phone's Signal App
   ```

---

## ServiceBay-Native Structured Log Auditing

OSCAR implements local auditing natively by writing to the **ServiceBay Unified Logging architecture** (`TEMPLATE_LOGGING.md`).

* **Operational & Cloud Audit Logging**: Hermes and the Gatekeeper write structured JSON lines on stdout with the tag **`oscar:audit`**. They serialize audit metadata (`uid`, `trace_id`, `vendor`, `model`, `prompt_hash`, `prompt_length`, `response_length`, `cost`) directly into the `args` column.
* **Auditing Query Skill**: The **`oscar-audit-query`** skill queries the ServiceBay log-querying API `/api/logs/query` or its MCP equivalent. Asking "What did the cloud connector cost yesterday?" returns a localized summary without requiring custom SQLite drivers or database files.
* **Settings & Verbose Flag**: Bounded-window debug toggling is managed via a simple `settings.json` file in the shared data volume, read by both containers on every query event.

---

## Dynamic Self-Enhancement

* **Markdown Ingestion (Obsidian Compatible)**: Photographing document pages, books, or album covers extracts rich metadata using Ollama's vision capabilities and writes standard Markdown files into your Syncthing-synchronized folder. These notes are immediately indexed by the `qmd` BM25 retrieval skill and remain accessible in **Obsidian**.
* **Admin Review Governance**: Any skill compiled dynamically by Hermes' self-improvement tools requires manual promotion by an admin before entering active execution, keeping your household system safe and predictable.

---

## Verification & Checks

Probes are declared at deploy time in each template's `post-deploy.py` and aggregated in the ServiceBay HealthStore. The **`oscar-status`** skill queries these checks:

* `ollama` — Local model HTTP responding at `/api/tags`.
* `hermes-api` — HTTP `/health` responding with Bearer token.
* `home-assistant` — Connection success at `/api/` using `HASS_TOKEN`.
* `voice-whisper` / `voice-piper` — Systemd/Podman units active.
