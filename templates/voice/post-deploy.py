#!/usr/bin/env python3
"""
post-deploy hook for the `voice` stack.

Three responsibilities:

  1. **Install the `voice-whisper.container` Quadlet** (#1809). Whisper
     moved out of the pod: on CUDA boxes it should run on the GPU, and
     the kube path cannot deliver one — `podman kube play` silently
     drops CDI device requests (#1026), and `privileged: true` exposes
     /dev but not the host driver libraries (box-verified: "CUDA driver
     version is insufficient"). So whisper runs as a companion
     `.container` Quadlet, the same pattern as the ollama GPU fixup:
     `AddDevice=nvidia.com/gpu=all` + `SecurityLabelDisable=true` when
     `/etc/cdi/nvidia.yaml` is registered, the plain CPU image
     otherwise. Same Wyoming endpoint either way (tcp://localhost:10300),
     so HA's pipeline config never changes.

     Box-measured 2026-06-12 (RTX 2000 Ada, 5.5 s German phrase, warm):
     CPU base-int8 0.83–0.98 s (2.86 s under load) → GPU medium-int8
     0.38 s at 1.1 GiB VRAM, GPU small 0.15 s at 0.8 GiB.

  2. **Data migration from the old in-HA-pod voice setup** (#348) —
     legacy `${DATA_DIR}/home-assistant/{whisper,piper}` content moves
     to `${DATA_DIR}/voice/…` so multi-gigabyte models aren't
     re-downloaded.

  3. **Surface the endpoint cheat-sheet** so the operator sees the
     three Wyoming URLs they need to paste into HA's voice-assistant
     UI.

Idempotent: re-runs converge (unit rewritten only on content drift,
migration skips populated targets).

See lib/registry.ts:getTemplatePostDeployScript for the script
protocol.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys


def env(key: str, default: str = "") -> str:
    val = os.environ.get(key, default)
    return val if val else default


def log(msg: str) -> None:
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


# ── whisper companion unit (#1809) ──────────────────────────────────────────

WHISPER_UNIT = "voice-whisper"

# The wizard default. When the operator left the model on this default AND
# the box has a GPU, the unit upgrades to medium-int8 automatically — the
# GPU runs the better model faster than the CPU ran base (box-measured
# 0.38 s vs 0.83–2.86 s). An operator who explicitly picked a non-default
# model keeps their choice on both paths (one knob, no GPU-specific knob).
CPU_DEFAULT_MODEL = "base-int8"
GPU_DEFAULT_MODEL = "medium-int8"


def cdi_available() -> bool:
    return os.path.exists("/etc/cdi/nvidia.yaml")


def render_whisper_unit(data_dir: str, model: str, language: str, gpu: bool) -> str:
    """Render the voice-whisper `.container` Quadlet (pure — the content
    diff and the write share one source of truth)."""
    if gpu:
        return (
            "[Unit]\n"
            "Description=Voice Whisper STT (Wyoming, GPU via CDI #1809)\n"
            "Wants=network-online.target\n"
            "After=network-online.target\n"
            "\n"
            "[Container]\n"
            "Image=lscr.io/linuxserver/faster-whisper:gpu\n"
            f"ContainerName={WHISPER_UNIT}\n"
            "Network=host\n"
            f"Environment=WHISPER_MODEL={model}\n"
            f"Environment=WHISPER_LANG={language}\n"
            "# Beam 1: greedy decode — the GPU headroom goes into the bigger\n"
            "# model instead; box-measured accurate at 0.38 s for 5.5 s speech.\n"
            "Environment=WHISPER_BEAM=1\n"
            "# CDI device — podman kube play silently drops this when\n"
            "# expressed as resources.limits (#1026), which is why whisper\n"
            "# left the pod.\n"
            "AddDevice=nvidia.com/gpu=all\n"
            "# SELinux relaxation is required for NVML/CUDA init on FCoS —\n"
            "# without it the container sees the devices but driver init\n"
            "# fails (same fixup as ollama, #1026).\n"
            "SecurityLabelDisable=true\n"
            "# linuxserver image keeps its model cache under /config.\n"
            f"Volume={data_dir}/voice/whisper-gpu:/config:Z\n"
            "AutoUpdate=registry\n"
            "\n"
            "[Service]\n"
            "Restart=on-failure\n"
            "RestartSec=5\n"
            "\n"
            "[Install]\n"
            "WantedBy=default.target\n"
        )
    return (
        "[Unit]\n"
        "Description=Voice Whisper STT (Wyoming, CPU #1809)\n"
        "Wants=network-online.target\n"
        "After=network-online.target\n"
        "\n"
        "[Container]\n"
        "Image=docker.io/rhasspy/wyoming-whisper:latest\n"
        f"ContainerName={WHISPER_UNIT}\n"
        "Network=host\n"
        f"Exec=--model {model} --language {language}"
        " --data-dir /data --uri tcp://0.0.0.0:10300\n"
        f"Volume={data_dir}/voice/whisper:/data:Z\n"
        "AutoUpdate=registry\n"
        "\n"
        "[Service]\n"
        "Restart=on-failure\n"
        "RestartSec=5\n"
        "\n"
        "[Install]\n"
        "WantedBy=default.target\n"
    )


def whisper_service_active() -> bool:
    try:
        out = subprocess.run(
            ["systemctl", "--user", "is-active", f"{WHISPER_UNIT}.service"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (FileNotFoundError, subprocess.SubprocessError, OSError):
        return False
    return out.stdout.strip() == "active"


def stale_pod_whisper_running() -> bool:
    """True when the pre-v2 pod still carries its whisper container — the
    install runner does not restart a kube service on a spec-changing
    re-render (#1813), so the stale container would hold :10300 and
    crash-loop the companion unit."""
    try:
        out = subprocess.run(
            ["podman", "ps", "--format", "{{.Names}}"],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (FileNotFoundError, subprocess.SubprocessError, OSError):
        return False
    return "voice-faster-whisper" in out.stdout.split()


def install_whisper_unit(data_dir: str) -> bool:
    """Write + activate the companion whisper Quadlet. Returns True when
    the service is (re)started or already active with current content."""
    gpu = cdi_available()
    model = env("WHISPER_MODEL", CPU_DEFAULT_MODEL)
    if gpu and model == CPU_DEFAULT_MODEL:
        model = GPU_DEFAULT_MODEL
    language = env("WHISPER_LANGUAGE", "de")
    unit = render_whisper_unit(data_dir, model, language, gpu)

    # Quadlet Volume= does NOT create the host path (kube DirectoryOrCreate
    # does) — without this the unit fails with `statfs …: no such file or
    # directory` (box-observed on first rollout).
    volume_dir = os.path.join(
        data_dir, "voice", "whisper-gpu" if gpu else "whisper"
    )
    try:
        os.makedirs(volume_dir, exist_ok=True)
    except OSError as e:
        log(f"   ⚠️ whisper: could not create {volume_dir}: {e}")
        return False

    # Self-heal #1813: a spec-changing re-render leaves the old pod (with
    # its in-pod whisper on :10300) running — restart the kube service so
    # the companion unit can bind.
    if stale_pod_whisper_running():
        log("   whisper: stale in-pod whisper still running — restarting voice.service (#1813).")
        subprocess.run(
            ["systemctl", "--user", "restart", "voice.service"],
            check=False,
            capture_output=True,
        )

    systemd_dir = os.path.expanduser("~/.config/containers/systemd")
    unit_path = os.path.join(systemd_dir, f"{WHISPER_UNIT}.container")

    existing = ""
    if os.path.exists(unit_path):
        try:
            with open(unit_path) as f:
                existing = f.read()
        except OSError:
            existing = ""

    if existing == unit and whisper_service_active():
        log(f"   whisper: {WHISPER_UNIT}.container current and active — no-op.")
        return True

    try:
        os.makedirs(systemd_dir, exist_ok=True)
        with open(unit_path, "w") as f:
            f.write(unit)
        os.chmod(unit_path, 0o644)
    except OSError as e:
        log(f"   ⚠️ whisper: could not write {unit_path}: {e}")
        return False

    subprocess.run(
        ["systemctl", "--user", "daemon-reload"], check=False, capture_output=True
    )
    started = subprocess.run(
        ["systemctl", "--user", "restart", f"{WHISPER_UNIT}.service"],
        capture_output=True,
        text=True,
    )
    if started.returncode != 0:
        log(f"   ⚠️ whisper: systemctl restart failed: {started.stderr[:300]}")
        return False
    log(
        f"   whisper: {WHISPER_UNIT}.container installed — "
        f"{'GPU (CDI)' if gpu else 'CPU'} path, model {model}."
    )
    return True


# ── legacy data migration (#348) ─────────────────────────────────────────────


def migrate_dir(old_path: str, new_path: str, label: str) -> None:
    """Move old_path → new_path if old exists and new is empty/missing.

    Treats a non-empty destination as "already migrated" — never
    overwrites. Best-effort: a failure logs but doesn't abort the
    rest of the post-deploy. The voice pod will still come up with
    an empty data dir and re-download on first request.
    """
    if not os.path.isdir(old_path):
        return
    if os.path.isdir(new_path) and any(os.scandir(new_path)):
        # Both exist and the new one is already populated — leave
        # everything alone. The operator can clean up the old path
        # manually once they're satisfied the new one works.
        log(f"   {label}: new path is already populated; leaving the legacy {old_path} as-is.")
        return
    try:
        os.makedirs(os.path.dirname(new_path), exist_ok=True)
        if os.path.exists(new_path):
            # New path exists but is empty — remove the empty dir
            # before move so shutil.move treats this as a rename.
            os.rmdir(new_path)
        shutil.move(old_path, new_path)
        log(f"   {label}: moved {old_path} → {new_path}.")
    except Exception as e:  # pylint: disable=broad-except
        log(f"   ⚠️ {label}: could not migrate {old_path} → {new_path}: {e}. The voice pod will re-download models on first request.")


def main() -> int:
    data_dir = env("DATA_DIR", "/mnt/data")

    # Migrate the legacy in-HA-pod voice data.
    legacy_whisper = os.path.join(data_dir, "home-assistant", "whisper")
    legacy_piper = os.path.join(data_dir, "home-assistant", "piper")
    new_whisper = os.path.join(data_dir, "voice", "whisper")
    new_piper = os.path.join(data_dir, "voice", "piper")
    if os.path.isdir(legacy_whisper) or os.path.isdir(legacy_piper):
        log("Migrating voice data from the legacy in-HA-pod paths (#348)...")
        migrate_dir(legacy_whisper, new_whisper, "Faster Whisper models")
        migrate_dir(legacy_piper, new_piper, "Piper voices")

    # Whisper companion unit (#1809) — GPU when CDI is registered.
    install_whisper_unit(data_dir)

    log("✅ Voice pipeline endpoints — paste these into Home Assistant → Settings → Voice Assistants:")
    log("   • Speech-to-text (Wyoming): tcp://localhost:10300")
    log("   • Text-to-speech   (Wyoming): tcp://localhost:10200")
    log("   • Wake word        (Wyoming): tcp://localhost:10400")

    return 0


if __name__ == "__main__":
    sys.exit(main())
