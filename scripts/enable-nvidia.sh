#!/usr/bin/env bash
# enable-nvidia.sh — one-shot NVIDIA layering on an EXISTING ServiceBay
# host that wasn't built with GPU support.
#
# Usage (run AS ROOT on the FCoS host):
#
#   sudo bash enable-nvidia.sh
#
# Builds out the same layer that install-fedora-coreos.sh's
# install-nvidia.service would have done at first boot, but on a host
# that's already up: RPM Fusion repos, kmod-nvidia-open-dkms, NVIDIA
# container-toolkit, then nvidia-ctk CDI generation for podman GPU
# passthrough. Idempotent — re-runs are no-ops once the marker files
# exist.
#
# Two phases: package layering needs a reboot to load the kernel
# module, then CDI generation runs on the second pass. Re-run after
# reboot to finish.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "enable-nvidia: must run as root (try: sudo bash enable-nvidia.sh)" >&2
    exit 1
fi

if ! /usr/sbin/lspci 2>/dev/null | grep -qi 'NVIDIA Corporation'; then
    echo "enable-nvidia: no NVIDIA GPU detected via lspci. Aborting." >&2
    exit 1
fi

FEDORA_VERSION="$(/usr/bin/rpm -E %fedora)"
REPOS_MARKER=/var/lib/install-nvidia-repos-done
DRIVER_MARKER=/var/lib/install-nvidia-driver-done
CDI_MARKER=/var/lib/install-nvidia-cdi-done

prompt_reboot() {
    local next_stage="$1"
    echo
    echo "enable-nvidia: REBOOT REQUIRED to ${next_stage}."
    echo "After reboot, re-run:  sudo bash enable-nvidia.sh"
    echo
    read -r -p "Reboot now? [y/N]: " ans
    if [[ "${ans^^}" == "Y" ]]; then
        /usr/bin/systemctl reboot
    fi
    exit 0
}

# Stage 1 — layer the RPM Fusion release packages. These ship the repo
# definitions for the nonfree NVIDIA driver build. rpm-ostree CANNOT
# install packages from a repo whose .repo file is part of a pending
# (not-yet-active) deployment — `rpm-ostree install nvidia-package` in
# the same script invocation would fail with "Packages not found", so
# we split repo layering from driver layering with a reboot between.
if [[ ! -f "$REPOS_MARKER" ]]; then
    echo "enable-nvidia: stage 1 — layering RPM Fusion repos..."
    /usr/bin/rpm-ostree install --idempotent --allow-inactive \
        "https://download1.rpmfusion.org/free/fedora/rpmfusion-free-release-${FEDORA_VERSION}.noarch.rpm" \
        "https://download1.rpmfusion.org/nonfree/fedora/rpmfusion-nonfree-release-${FEDORA_VERSION}.noarch.rpm"
    touch "$REPOS_MARKER"
    prompt_reboot "activate the RPM Fusion repos before installing the NVIDIA driver"
fi

# Stage 2 — install the NVIDIA driver + container toolkit. Open kernel
# modules (`kmod-nvidia-open-dkms`) are NVIDIA's recommended path for
# Turing+ GPUs (covers Ada Lovelace). nvidia-container-toolkit ships
# `nvidia-ctk` for CDI generation (the standard podman-NVIDIA bridge).
if [[ ! -f "$DRIVER_MARKER" ]]; then
    echo "enable-nvidia: stage 2 — layering NVIDIA driver + container toolkit..."
    /usr/bin/rpm-ostree install --idempotent --allow-inactive \
        kmod-nvidia-open-dkms \
        xorg-x11-drv-nvidia-cuda \
        nvidia-container-toolkit
    touch "$DRIVER_MARKER"
    prompt_reboot "load the nvidia kernel module so CDI generation has something to introspect"
fi

# Stage 3 — generate the CDI config. nvidia-ctk needs the kmod loaded
# to enumerate the device.
if [[ ! -f "$CDI_MARKER" ]]; then
    echo "enable-nvidia: stage 3 — waiting for nvidia kernel module..."
    for _ in $(seq 1 30); do
        /usr/sbin/lsmod | grep -q '^nvidia ' && break
        sleep 2
    done
    if ! /usr/sbin/lsmod | grep -q '^nvidia '; then
        echo "enable-nvidia: nvidia kernel module did not load." >&2
        echo "Check 'journalctl -u dkms*' and 'dmesg | grep -i nvidia' for build errors." >&2
        exit 1
    fi
    /usr/bin/mkdir -p /etc/cdi
    /usr/bin/nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
    /usr/bin/nvidia-ctk cdi list || true
    touch "$CDI_MARKER"
    echo
    echo "enable-nvidia: CDI config at /etc/cdi/nvidia.yaml — podman GPU passthrough is ready."
    echo "Set OLLAMA_GPU_PASSTHROUGH=yes (or any non-empty value) when installing the AI stack."
fi

echo "enable-nvidia: done"
