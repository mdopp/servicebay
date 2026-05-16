#!/usr/bin/env python3
"""
post-deploy hook for the `hermes` template.

Three responsibilities:

  1. **Write config.yaml.** Hermes reads its model-provider settings
     from /opt/data/config.yaml. The upstream entrypoint copies a
     default config.yaml on first start if none exists. We overwrite
     it with the wizard-collected provider/model/base_url so Hermes
     points at the ServiceBay `ollama` template (or whatever endpoint
     the operator picked).

  2. **Restart the pod** so Hermes picks up the new config. We do
     this via ServiceBay's own POST /api/services/<name>/action
     endpoint rather than `systemctl` so the restart counts as a
     managed action and shows in the service history.

  3. **Surface HERMES_API_KEY** as a __SB_CREDENTIAL__ marker so it
     lands in the wizard's SAVE-THESE-NOW banner. Operators paste it
     into OSCAR's oscar-household config (or any other client) to
     authenticate against Hermes' API.

UX_PHILOSOPHY.md § 2 bans operator-facing `podman exec`
instructions. Everything Hermes needs to come up wired to Ollama is
done here, without any interactive step.

See lib/registry.ts:getTemplatePostDeployScript for the script
protocol.
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


def emit_credential(**fields: object) -> None:
    sys.stdout.write("__SB_CREDENTIAL__ " + json.dumps(fields) + "\n")
    sys.stdout.flush()


def post_json(url: str, payload: dict[str, object], timeout: float = 10.0) -> tuple[int, dict[str, object] | None]:
    body = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    token = os.environ.get("SB_API_TOKEN", "")
    if token:
        headers["X-SB-Internal-Token"] = token
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(data) if data else None
            except json.JSONDecodeError:
                return resp.status, None
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:  # pylint: disable=broad-except
            return e.code, None
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, None


def write_config_yaml(data_dir: str, provider_url: str, model: str) -> str | None:
    """Write /opt/data/config.yaml's model: block. Returns the path on
    success, None if the write failed. Best-effort — a failure here
    means Hermes falls back to its default config.yaml (likely empty
    model.base_url), which the operator can fix from the wizard."""
    config_dir = os.path.join(data_dir, "hermes")
    config_path = os.path.join(config_dir, "config.yaml")
    try:
        os.makedirs(config_dir, exist_ok=True)
    except OSError as e:
        jlog("error", "hermes:config", "could not create config dir", path=config_dir, error=str(e))
        return None
    # Minimal, idempotent: a single model block targeting the
    # OpenAI-compatible endpoint. Yaml-by-hand because we don't want a
    # PyYAML dependency in post-deploy scripts.
    content = (
        "# Written by ServiceBay's hermes template post-deploy.py.\n"
        "# Edit via the wizard's reconfigure flow or hand-edit and restart the hermes service.\n"
        "model:\n"
        f"  provider: custom\n"
        f"  model: {model}\n"
        f"  base_url: {provider_url}\n"
        f"  api_key: \"none\"\n"
    )
    try:
        with open(config_path, "w", encoding="utf-8") as f:
            f.write(content)
    except OSError as e:
        jlog("error", "hermes:config", "could not write config.yaml", path=config_path, error=str(e))
        return None
    jlog("info", "hermes:config", "wrote config.yaml", path=config_path, model=model, provider_url=provider_url)
    return config_path


def restart_hermes(sb_api: str) -> bool:
    """POST /api/services/hermes/action {action: 'restart'}. Best-effort."""
    status, body = post_json(
        f"{sb_api}/api/services/hermes/action",
        {"action": "restart"},
        timeout=30,
    )
    if status == 200:
        jlog("info", "hermes:restart", "restart requested via ServiceBay API")
        return True
    err = (body or {}).get("error") if isinstance(body, dict) else None
    jlog("warn", "hermes:restart", "restart request failed; the config will take effect on next manual restart", status=status, error=str(err) if err else None)
    return False


def main() -> int:
    data_dir = env("DATA_DIR", "/mnt/data")
    sb_api = env("SB_API_URL", "http://localhost:3000")
    host = env("HOST", "<server-ip>")
    api_port = env("HERMES_API_PORT", "8642")
    api_key = env("HERMES_API_KEY")
    provider_url = env("HERMES_LLM_PROVIDER_URL", "http://127.0.0.1:11434/v1")
    model = env("HERMES_LLM_MODEL", "gemma3:4b")
    dashboard_port = env("HERMES_DASHBOARD_PORT")

    # 1. Write config.yaml with the wizard-picked provider + model.
    config_written = write_config_yaml(data_dir, provider_url, model) is not None

    # 2. Restart so Hermes picks up the new config.
    if config_written:
        # Give the pod a few seconds to settle so the restart isn't
        # racing the initial deploy.
        time.sleep(3)
        restart_hermes(sb_api)

    # 3. Surface the API key for downstream wiring (oscar-household,
    # MCP clients, the operator's own scripts).
    if api_key:
        emit_credential(
            service="Hermes Agent (API)",
            url=f"http://{host}:{api_port}",
            username="(bearer token)",
            password=api_key,
            importance="critical",
            notes="Bearer token for Hermes' API. Send as `Authorization: Bearer <key>`. Bind a client by pasting this into oscar-household or your own MCP wiring. Regenerate from the wizard if it leaks.",
        )

    print(f"✅ Hermes is configured: model={model}, provider={provider_url}, port={api_port}.")
    if dashboard_port:
        print(f"   Dashboard enabled on 127.0.0.1:{dashboard_port} — see README for the NPM + Authelia setup.")
    print(f"   Other ServiceBay templates (oscar-household) can reach Hermes at http://127.0.0.1:{api_port}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
