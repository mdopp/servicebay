#!/usr/bin/env python3
"""
post-deploy hook for the `ollama` template.

Two responsibilities:

  1. **Pull the default model.** Ollama doesn't pull on first start;
     it serves what's already on disk. The wizard knows which model
     the operator picked, so trigger the pull here once the pod is
     reachable.

  2. **Register an HTTP health check.** The auto-created
     `service:ollama` check catches "systemd thinks ollama is down";
     adding an `http` check against `/api/tags` catches the
     degraded-but-running cases (corrupt model store, GPU OOM, disk
     full) that systemd would still see as `active`.

Idempotent: a second run finds the model already cached and skips
the pull; the health-check API does upsert-by-id.

See lib/registry.ts:getTemplatePostDeployScript for the script
protocol and docs/TEMPLATE_AUTHORING.md § Health checks for the
check-registration contract.
"""

from __future__ import annotations

import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.request


def env(key: str, default: str = "") -> str:
    val = os.environ.get(key, default)
    return val if val else default


def jlog(level: str, tag: str, message: str, **args: object) -> None:
    """Emit a TEMPLATE_LOGGING.md-shaped line on stdout."""
    sys.stdout.write(
        json.dumps(
            {
                "ts": datetime.datetime.now().astimezone().isoformat(),
                "level": level,
                "tag": tag,
                "message": message,
                "args": args,
            }
        )
        + "\n"
    )
    sys.stdout.flush()


def http_request(
    url: str,
    payload: dict[str, object] | None = None,
    method: str = "GET",
    timeout: float = 10.0,
    extra_headers: dict[str, str] | None = None,
) -> tuple[int, bytes]:
    headers = {"Content-Type": "application/json"}
    if extra_headers:
        headers.update(extra_headers)
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        try:
            body = e.read()
        except Exception:  # pylint: disable=broad-except
            body = b""
        return e.code, body
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, b""


def wait_for_ready(ollama_url: str, deadline_sec: int) -> bool:
    """Poll /api/tags until Ollama responds 200."""
    started = time.time()
    last_beat = 0.0
    while time.time() - started < deadline_sec:
        status, _ = http_request(f"{ollama_url}/api/tags", timeout=5)
        if status == 200:
            return True
        elapsed = time.time() - started
        if elapsed - last_beat >= 10:
            jlog("info", "ollama:wait", "still waiting for Ollama API", elapsed_sec=int(elapsed))
            last_beat = elapsed
        time.sleep(3)
    return False


def pull_model(ollama_url: str, model: str, deadline_sec: int) -> bool:
    """Trigger a streaming pull and wait for the done line."""
    body = json.dumps({"name": model, "stream": True}).encode("utf-8")
    req = urllib.request.Request(
        f"{ollama_url}/api/pull",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=deadline_sec) as resp:
            last_status = ""
            for raw in resp:
                if time.time() - started > deadline_sec:
                    jlog("error", "ollama:pull", "model pull exceeded deadline", model=model, deadline_sec=deadline_sec)
                    return False
                try:
                    chunk = json.loads(raw.decode("utf-8").strip())
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                status = str(chunk.get("status", ""))
                if status and status != last_status:
                    jlog("info", "ollama:pull", status, model=model)
                    last_status = status
                if chunk.get("error"):
                    jlog("error", "ollama:pull", "pull error", model=model, error=str(chunk.get("error")))
                    return False
        jlog("info", "ollama:pull", "model ready", model=model, elapsed_sec=int(time.time() - started))
        return True
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
        jlog("error", "ollama:pull", "pull failed", model=model, error=str(e))
        return False


def register_http_check(sb_api: str, sb_token: str, ollama_url: str) -> None:
    """Best-effort: a non-200 here doesn't block the install."""
    headers = {}
    if sb_token:
        headers["X-SB-Internal-Token"] = sb_token
    status, body = http_request(
        f"{sb_api}/api/health/checks",
        payload={
            "id": "ollama-api",
            "name": "Ollama API",
            "type": "http",
            "target": f"{ollama_url}/api/tags",
            "interval": 60,
            "enabled": True,
            "httpConfig": {"expectedStatus": 200},
        },
        method="POST",
        timeout=10,
        extra_headers=headers,
    )
    if status == 200:
        jlog("info", "ollama:health", "registered http check ollama-api")
    else:
        jlog("warn", "ollama:health", "could not register http check", status=status, body=body.decode("utf-8", errors="replace")[:200])


def main() -> int:
    port = env("OLLAMA_PORT", "11434")
    model = env("OLLAMA_DEFAULT_MODEL", "gemma3:4b")
    vision_model = env("OLLAMA_VISION_MODEL", "")
    timeout = int(env("OLLAMA_READINESS_TIMEOUT_SECONDS", "600"))
    sb_api = env("SB_API_URL", "http://localhost:3000")
    sb_token = env("SB_API_TOKEN", "")
    ollama_url = f"http://127.0.0.1:{port}"

    jlog("info", "ollama:bootstrap", "waiting for Ollama API", url=ollama_url, deadline_sec=timeout)
    if not wait_for_ready(ollama_url, deadline_sec=min(timeout, 120)):
        jlog(
            "warn",
            "ollama:bootstrap",
            "Ollama API not reachable yet; skipping model pull. The service may still come up — check the install log and re-run from the wizard if needed.",
            url=ollama_url,
        )
        return 0

    started = time.time()

    def remaining_budget() -> int:
        return max(60, timeout - int(time.time() - started))

    if model:
        jlog("info", "ollama:pull", "starting model pull", model=model)
        ok = pull_model(ollama_url, model, deadline_sec=remaining_budget())
        if not ok:
            jlog(
                "warn",
                "ollama:pull",
                "model pull did not complete; the pod is up but the default model is missing. Pull manually with `curl -X POST http://127.0.0.1:%s/api/pull -d '{\"name\":\"%s\"}'`." % (port, model),
                model=model,
            )

    if vision_model:
        jlog("info", "ollama:pull", "starting vision-model pull", model=vision_model)
        ok = pull_model(ollama_url, vision_model, deadline_sec=remaining_budget())
        if not ok:
            jlog(
                "warn",
                "ollama:pull",
                "vision-model pull did not complete; OSCAR's media-ingestion-multimodal skill will fall back to text-only. Pull manually with `curl -X POST http://127.0.0.1:%s/api/pull -d '{\"name\":\"%s\"}'` or bump OLLAMA_READINESS_TIMEOUT_SECONDS." % (port, vision_model),
                model=vision_model,
            )

    register_http_check(sb_api, sb_token, ollama_url)

    print(f"✅ Ollama is running on 127.0.0.1:{port}. Default model: {model}.")
    if vision_model:
        print(f"   Vision model: {vision_model} (multimodal-capable).")
    print(f"   Other ServiceBay templates (hermes, oscar-household) can reach it at http://127.0.0.1:{port}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
