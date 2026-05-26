# Ollama (Local LLM Server)

[Ollama](https://ollama.com/) is a single-binary local LLM runtime
that speaks an OpenAI-compatible HTTP API. ServiceBay's `ollama`
template wraps the upstream image
(`docker.io/ollama/ollama:latest`) as a hostNetwork pod bound to
`127.0.0.1` so other templates on the same host (e.g. `hermes`)
can reach it at `http://127.0.0.1:11434` without DNS or bridge
networking.

## Variables

- `OLLAMA_PORT` — host port. Default `11434`. Bound to loopback.
- `OLLAMA_DEFAULT_MODEL` — primary model. The tag Hermes' `model.model`
  points at after install. Default `gemma4:e4b` (~10 GB, fits 100% on
  a 16 GB GPU, fast). Any Ollama library tag works, plus user-namespaced
  tags like `VladimirGav/gemma4-26b-16GB-VRAM:latest`.
- `OLLAMA_EXTRA_MODELS` — comma-separated list of additional models
  pre-pulled at install time on top of the default. The point is to
  give the operator one-click switchable choices in Hermes' Models tab
  without a fresh download. Default ships
  `VladimirGav/gemma4-26b-16GB-VRAM:latest` — a quantized 26B that
  still fits 100% on a 16 GB GPU, complementing the smaller default.
  Each extra adds 10–20 minutes to the install on a typical home link.
  Set to empty string to skip.
- `OLLAMA_VISION_MODEL` — optional second model for image-aware
  skills (e.g. OSCAR's `media-ingestion-multimodal`). Blank by
  default; set to `qwen2.5vl:7b`, `llava:13b`, or `bakllava:7b`
  to enable multimodal flows.
- `OLLAMA_GPU_PASSTHROUGH` — leave blank for CPU; set non-blank
  for NVIDIA GPU passthrough via CDI.
- `OLLAMA_READINESS_TIMEOUT_SECONDS` — post-deploy model-pull
  deadline. Default `600`. Shared per-pull (not summed across the
  default + extras + vision); bump it if you pull large models on a
  slow link.

## CPU vs. GPU

| Mode | When | What's deployed |
|---|---|---|
| CPU (default) | No NVIDIA GPU, or you just want to kick the tyres | Plain Ollama pod, no `resources` block. Use small models (≤ 7B parameters) for acceptable latency. |
| GPU | NVIDIA GPU + CDI registered | Pod manifest gets `resources.limits.nvidia.com/gpu: "1"`. Podman matches this against the CDI device registry. Works with the larger models Ollama can run (gemma3:12b, qwen2.5:14b, llama3.1:70b on multi-GPU boxes). |

### Enabling GPU on the host (one-time)

```
sudo dnf install -y nvidia-container-toolkit   # or your distro's equivalent
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
podman info | grep -i cdi                       # confirm registration
```

Then set `OLLAMA_GPU_PASSTHROUGH=yes` in the ServiceBay wizard and
redeploy.

## Network exposure

Ollama ships **no built-in authentication**. The template binds
`OLLAMA_HOST=127.0.0.1:<port>` so only the host's loopback
interface accepts connections. Other ServiceBay pods that are
also `hostNetwork: true` (e.g. `hermes`) can reach it via that
loopback; bridge-networked pods cannot.

For LAN or remote access, put Ollama behind NPM + Authelia using
the forward-auth pattern (see `src/lib/stackInstall/forwardAuth.ts`
and the AdGuard / Syncthing admin pages for examples). **Do not**
flip `OLLAMA_HOST` to `0.0.0.0` and publish it directly — Ollama's
API exposes every loaded model to anyone who reaches it.

## What `post-deploy.py` does

1. Waits for `http://127.0.0.1:<port>/api/tags` to answer (the pod's
   own readiness signal).
2. POSTs `/api/pull` with `OLLAMA_DEFAULT_MODEL` so the first model
   is ready before the operator's first request.
3. If `OLLAMA_VISION_MODEL` is set, POSTs a second `/api/pull` for
   that model (sequential to keep network/disk pressure predictable).
4. Logs progress and emits a final "ready" line.

Idempotent — a second deploy with the same models finds them already
cached and skips the pulls.

## Multimodal (vision) inference

OSCAR's `media-ingestion-multimodal` skill needs a vision-capable
model to OCR book covers, transcribe photos of documents, etc.
The default `gemma3:4b` is text-only — sending it an image yields
an unhelpful "I can't see images" response.

Set `OLLAMA_VISION_MODEL` at install time (or via the wizard's
reconfigure flow) to pull a vision model alongside the default.
The model pulls in series after the default; both share the
`OLLAMA_READINESS_TIMEOUT_SECONDS` budget. Suggested tags:

- `qwen2.5vl:7b` — Apache-2.0, ~6 GB quantised, fits a 16 GB GPU
  alongside `gemma3:4b`.
- `llava:13b` — older but well-tested, ~8 GB.
- `bakllava:7b` — Mistral-based LLaVA variant, ~5 GB.

Hermes' wiring picks up the new model automatically the next time
its config is regenerated — see `templates/hermes/README.md`.

## Storage

Models persist at `${DATA_DIR}/ollama/`. Pulled weights are large
(2–40 GB depending on model) — plan disk capacity accordingly.

## Health checks

A baseline `service`-type check (`Service: ollama`) is auto-created
by `ServiceManager.deployService`. The post-deploy.py script
additionally registers an HTTP check (`ollama-api`, 60 s) hitting
`http://127.0.0.1:<port>/api/tags` so degraded-but-running cases
(model corrupted, disk full, GPU OOM) surface as a `fail` instead
of going unnoticed.

See `docs/TEMPLATE_AUTHORING.md` § Health checks for the contract.

## Logging

Ollama's upstream image emits human-readable lines on stdout —
fine for `get_container_logs` / `get_podman_logs`. The post-deploy
script emits JSON-shaped lines per `docs/TEMPLATE_LOGGING.md` for
the events under its control (pull start, progress, ready).
