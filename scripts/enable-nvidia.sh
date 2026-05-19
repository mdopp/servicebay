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
DRIVER_MARKER=/var/lib/install-nvidia-driver-done
CDI_MARKER=/var/lib/install-nvidia-cdi-done

# Stage 1: layer the packages. RPM Fusion's nonfree repo ships the
# NVIDIA proprietary driver build; nvidia-container-toolkit provides
# `nvidia-ctk` for CDI generation (the standard podman-NVIDIA bridge).
# Open kernel modules (`kmod-nvidia-open-dkms`) are NVIDIA's
# recommended path for Turing+ GPUs (covers Ada Lovelace).
if [[ ! -f "$DRIVER_MARKER" ]]; then
    echo "enable-nvidia: layering RPM Fusion + NVIDIA driver + container toolkit..."
    /usr/bin/rpm-ostree install --idempotent --allow-inactive \
        "https://download1.rpmfusion.org/free/fedora/rpmfusion-free-release-${FEDORA_VERSION}.noarch.rpm" \
        "https://download1.rpmfusion.org/nonfree/fedora/rpmfusion-nonfree-release-${FEDORA_VERSION}.noarch.rpm"
    /usr/bin/rpm-ostree install --idempotent --allow-inactive \
        kmod-nvidia-open-dkms \
        xorg-x11-drv-nvidia-cuda \
        nvidia-container-toolkit
    touch "$DRIVER_MARKER"
    echo
    echo "enable-nvidia: packages staged. REBOOT REQUIRED to load the kmod."
    echo "After reboot, re-run this script to generate the CDI config:"
    echo
    echo "    sudo bash enable-nvidia.sh"
    echo
    read -r -p "Reboot now? [y/N]: " ans
    if [[ "${ans^^}" == "Y" ]]; then
        /usr/bin/systemctl reboot
    fi
    exit 0
fi

# Stage 2: post-reboot CDI generation.
if [[ ! -f "$CDI_MARKER" ]]; then
    echo "enable-nvidia: waiting for nvidia kernel module..."
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
