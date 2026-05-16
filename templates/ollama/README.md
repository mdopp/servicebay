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
- `OLLAMA_DEFAULT_MODEL` — model pulled on first install. Default
  `gemma3:4b` (small, CPU-friendly). Any Ollama library tag works.
- `OLLAMA_GPU_PASSTHROUGH` — leave blank for CPU; set non-blank
  for NVIDIA GPU passthrough via CDI.
- `OLLAMA_READINESS_TIMEOUT_SECONDS` — post-deploy model-pull
  deadline. Default `600`.

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
3. Logs progress and emits a final "ready" line.

Idempotent — a second deploy with the same model finds it already
cached and skips the pull.

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
