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
import re
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
    # #1002 — ServiceBay defaults table. Six overrides on top of
    # Hermes' upstream defaults that swing the box from "developer
    # laptop" toward "household appliance" semantics. See the
    # discussion thread on #1002 for the why of each:
    #   - memory.provider=holographic — local store, no external deps.
    #     Switch to honcho when the honcho template lands (#1004).
    #   - tts.provider=piper — local voice. Falls back to '' (silent)
    #     when piper isn't installed yet; never the upstream `edge`
    #     (Microsoft online) default.
    #   - browser.engine=disabled — agents inside a container almost
    #     never want a real browser. Skills that need it flip it on.
    #   - model_catalog.enabled=false — don't phone the upstream
    #     catalog endpoint every 24h. Privacy-by-default.
    #   - network.force_ipv4=true — FritzBox + IPv6 has bitten other
    #     services (#415). Skip AAAA records in aiohttp.
    #   - display.personality=default — household assistant, not anime.
    content = (
        "# Written by ServiceBay's hermes template post-deploy.py.\n"
        "# Edit via the wizard's reconfigure flow or hand-edit and restart the hermes service.\n"
        "model:\n"
        f"  provider: custom\n"
        f"  model: {model}\n"
        f"  base_url: {provider_url}\n"
        f"  api_key: \"none\"\n"
        "memory:\n"
        "  provider: holographic\n"
        "tts:\n"
        "  provider: piper\n"
        "browser:\n"
        "  engine: disabled\n"
        "model_catalog:\n"
        "  enabled: false\n"
        "network:\n"
        "  force_ipv4: true\n"
        "display:\n"
        "  personality: default\n"
    )
    try:
        with open(config_path, "w", encoding="utf-8") as f:
            f.write(content)
    except OSError as e:
        jlog("error", "hermes:config", "could not write config.yaml", path=config_path, error=str(e))
        return None
    # Make the dir traversable and the file readable so OTHER templates'
    # post-deploys (notably oscar-household) can splice an `mcp_servers:`
    # block into the same config.yaml. Without this, the hermes container
    # leaves the dir as 0o700 and downstream post-deploys silently bail
    # at os.path.exists() with "config.yaml not found" - observed
    # 2026-05-25 during a household-stack install: ha-mcp + servicebay-mcp
    # never got wired, so Hermes ran with the model block only and could
    # neither control Home Assistant nor query ServiceBay logs.
    # Best-effort: a PermissionError here is non-fatal (other-readability
    # is a convenience, not a hard requirement for Hermes itself).
    try:
        os.chmod(config_dir, 0o755)
        os.chmod(config_path, 0o644)
    except OSError as e:
        jlog("warn", "hermes:config", "could not relax config perms for downstream merges", path=config_dir, error=str(e))
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


def write_gateway_env(data_dir: str, entries: dict[str, str]) -> bool:
    """Merge messaging-gateway credentials into `<DATA_DIR>/hermes/.env`.

    Hermes reads its gateway allowlists and bot tokens from this file at
    start time (the warning Hermes prints on a fresh install names this
    exact path: `~/.hermes/.env`). The pod mounts `<DATA_DIR>/hermes` at
    `/opt/data`, and Hermes' default HOME is `/opt/data` → `.env` here is
    the same file Hermes loads.

    Merge semantics: read existing key/value lines, overwrite the keys
    we manage, keep everything else untouched. Empty values clear a key
    (so an operator who removes a token from the wizard actually rotates
    the credential out). A run with all-empty inputs and no existing
    file is a no-op.

    Returns True when the .env file changed (signals the caller to
    restart the pod), False when it was already up to date.
    """
    config_dir = os.path.join(data_dir, "hermes")
    env_path = os.path.join(config_dir, ".env")
    managed_keys = {
        "TELEGRAM_BOT_TOKEN",
        "TELEGRAM_ALLOWED_USERS",
        "DISCORD_BOT_TOKEN",
        "DISCORD_ALLOWED_CHANNELS",
        "SIGNAL_ACCOUNT",
        "SIGNAL_ALLOWED_USERS",
    }
    existing: dict[str, str] = {}
    order: list[str] = []
    preamble: list[str] = []
    if os.path.exists(env_path):
        try:
            with open(env_path, encoding="utf-8") as f:
                for raw in f:
                    line = raw.rstrip("\n")
                    if not line.strip() or line.lstrip().startswith("#"):
                        preamble.append(line)
                        continue
                    if "=" not in line:
                        preamble.append(line)
                        continue
                    key, _, value = line.partition("=")
                    key = key.strip()
                    if not key:
                        preamble.append(line)
                        continue
                    if key in managed_keys:
                        # Drop existing managed lines; they get rewritten below.
                        continue
                    existing[key] = value
                    order.append(key)
        except OSError as e:
            jlog("warn", "hermes:env", "could not read .env, will recreate", path=env_path, error=str(e))
            existing = {}
            order = []
            preamble = []

    # Decide whether anything would actually change.
    new_managed = {k: v for k, v in entries.items() if v}
    desired_lines: list[str] = []
    for line in preamble:
        desired_lines.append(line)
    for key in order:
        desired_lines.append(f"{key}={existing[key]}")
    if new_managed:
        if desired_lines and desired_lines[-1] != "":
            desired_lines.append("")
        for key in sorted(new_managed):
            desired_lines.append(f"{key}={new_managed[key]}")
    new_content = "\n".join(desired_lines).rstrip("\n") + ("\n" if desired_lines else "")

    if not os.path.exists(env_path) and not new_managed:
        return False

    try:
        with open(env_path, encoding="utf-8") as f:
            old_content = f.read()
    except (FileNotFoundError, OSError):
        old_content = ""
    if old_content == new_content:
        return False

    try:
        os.makedirs(config_dir, exist_ok=True)
        with open(env_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        os.chmod(env_path, 0o600)
    except OSError as e:
        jlog("error", "hermes:env", "could not write .env", path=env_path, error=str(e))
        return False
    jlog(
        "info",
        "hermes:env",
        "updated messaging-gateway .env",
        path=env_path,
        keys=sorted(new_managed.keys()),
    )
    return True


def _wait_for_ha_token(token_path: str, deadline_secs: int = 90) -> str | None:
    """#1002 — Poll for the HA long-lived token file. HA's post-deploy
    auto-onboards the `oscar` user and writes this file near the end of
    its run; if hermes' post-deploy is racing it (even with
    servicebay.dependencies: home-assistant) the file may not exist yet
    on first check. Returns the token once present + non-empty, or None
    if the deadline passes."""
    deadline = time.time() + deadline_secs
    while time.time() < deadline:
        if os.path.exists(token_path):
            try:
                with open(token_path, encoding="utf-8") as f:
                    token = f.read().strip()
                if token:
                    return token
            except OSError:
                pass
        time.sleep(3)
    return None


def _wait_for_ha_api(token: str, timeout_secs: int = 60) -> bool:
    """#1002 — Probe HA's /api/ with the new token until it answers 200.
    Avoids the first reconnect-loop iteration where Hermes' HA gateway
    fires before HA's listener is fully up (the "Cannot connect to host
    127.0.0.1:8123" error in the v4.29.x install logs). Best-effort —
    we still restart even on timeout, since Hermes will retry on its
    own."""
    deadline = time.time() + timeout_secs
    last_status = 0
    while time.time() < deadline:
        try:
            req = urllib.request.Request(
                "http://127.0.0.1:8123/api/",
                headers={"Authorization": f"Bearer {token}"},
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                last_status = resp.status
                if 200 <= resp.status < 300:
                    return True
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
            pass
        time.sleep(3)
    jlog("warn", "hermes:ha-ready", "HA /api/ not 200 within deadline; restart anyway", last_status=last_status, deadline_secs=timeout_secs)
    return False


def adopt_ha_long_lived_token(data_dir: str) -> str | None:
    """When home-assistant's post-deploy has auto-onboarded HA (#934), it
    leaves a long-lived access token at
    `<DATA_DIR>/home-assistant/homeassistant/.oscar-long-lived-token`.
    Pick that up over the placeholder `HASS_TOKEN` from assemble and
    patch the deployed hermes pod yml so Hermes' native HA gateway can
    actually authenticate. Returns the token on success, or None when
    the file never appears (operator opted out of auto-onboarding) or
    the patch was a no-op.

    #1002: now retries (up to 90s) for the token file and probes HA's
    /api/ before signalling ready. The previous one-shot read missed
    the file on every install where HA's auto-onboarding hadn't yet
    written it, leaving HASS_TOKEN as the placeholder."""
    token_path = os.path.join(data_dir, "home-assistant", "homeassistant", ".oscar-long-lived-token")
    token = _wait_for_ha_token(token_path)
    if token is None:
        jlog("info", "hermes:ha-token", "no HA long-lived token after retry — likely operator opted out of HA auto-onboarding", path=token_path)
        return None
    # The hermes pod yml is written by ServiceBay's install runner to the
    # user-Quadlet directory. Patch the HASS_TOKEN env value in-place so a
    # subsequent restart picks up the real token. We match the YAML
    # structure ServiceBay produces:
    #     - name: HASS_TOKEN
    #       value: "<random>"
    pod_yml = os.path.expanduser("~/.config/containers/systemd/hermes.yml")
    if not os.path.exists(pod_yml):
        jlog("warn", "hermes:ha-token", "hermes.yml not found at expected path", path=pod_yml)
        return None
    try:
        with open(pod_yml, encoding="utf-8") as f:
            src = f.read()
    except OSError as e:
        jlog("warn", "hermes:ha-token", "could not read hermes.yml", path=pod_yml, error=str(e))
        return None
    new = re.sub(
        r"(- name: HASS_TOKEN\n\s+value: )[^\n]+",
        lambda m: m.group(1) + '"' + token + '"',
        src,
    )
    if new == src:
        # Already adopted on a previous run.
        return token
    try:
        with open(pod_yml, "w", encoding="utf-8") as f:
            f.write(new)
    except OSError as e:
        jlog("warn", "hermes:ha-token", "could not write patched hermes.yml", path=pod_yml, error=str(e))
        return None
    jlog("info", "hermes:ha-token", "adopted HA long-lived token from home-assistant post-deploy", token_path=token_path)

    # #1002 — Wait for HA's /api/ to answer 200 with this token before
    # we restart hermes. Without this gate Hermes' first HA-gateway
    # reconnect lands during HA's startup window and gets
    # "Cannot connect to host 127.0.0.1:8123" — operator-visible noise
    # that has nothing to do with the actual config.
    _wait_for_ha_api(token)
    return token


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

    # Pick up the real HA long-lived token if home-assistant's post-deploy
    # auto-onboarded HA. Without this Hermes' native HA gateway runs with
    # the random placeholder from `assemble` and gets `auth_invalid` from
    # HA on every call.
    adopt_ha_long_lived_token(data_dir)

    # Merge messaging-gateway credentials (Telegram / Discord / Signal
    # allowlists + bot tokens) into <DATA_DIR>/hermes/.env. Idempotent —
    # only signals a restart when something actually changed.
    env_changed = write_gateway_env(
        data_dir,
        {
            "TELEGRAM_BOT_TOKEN": env("TELEGRAM_BOT_TOKEN"),
            "TELEGRAM_ALLOWED_USERS": env("TELEGRAM_ALLOWED_USERS"),
            "DISCORD_BOT_TOKEN": env("DISCORD_BOT_TOKEN"),
            "DISCORD_ALLOWED_CHANNELS": env("DISCORD_ALLOWED_CHANNELS"),
            "SIGNAL_ACCOUNT": env("SIGNAL_ACCOUNT"),
            "SIGNAL_ALLOWED_USERS": env("SIGNAL_ALLOWED_USERS"),
        },
    )

    # 2. Restart so Hermes picks up the new config (and the new env if we
    # just patched HASS_TOKEN or rewrote .env).
    if config_written or env_changed:
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
