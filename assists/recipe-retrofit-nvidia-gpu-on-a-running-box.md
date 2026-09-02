---
title: Retrofitting NVIDIA GPU passthrough onto a box that was built without it
whenToUse: A box is already installed and running, an NVIDIA card is in it, but podman has no GPU — the image was built without GPU support, or first-boot GPU setup gave up. Also when the CDI config is missing or `install-nvidia-cdi.timer` is still firing every minute after the work is done.
kind: recipe
tags: [nvidia, gpu, cdi, podman, passthrough, rpm-ostree, fedora-coreos, driver, ollama, retrofit]
---

# Retrofitting NVIDIA GPU passthrough on a running box

A box built from the ServiceBay image does this at first boot
(`install-nvidia-cdi` in `tools/sb/internal/build/assets/fedora-coreos.bu`). This
recipe is the **hand path** for a host that is already up: the image was built
without GPU support, or the boot-time job gave up (it stops after a bounded
number of attempts and writes `/var/lib/install-nvidia-cdi-gave-up` rather than
retrying for ever).

Everything below runs **as root, on the host** (an immutable Fedora CoreOS-style
host with `rpm-ostree`), not inside a container.

## Before you start

Confirm the card is actually there — retrofitting a machine with no NVIDIA GPU
just layers packages you will have to peel off again:

```bash
lspci | grep -i 'NVIDIA Corporation'
```

Then note the Fedora release you are layering against — the RPM Fusion release
packages are per-version:

```bash
rpm -E %fedora
```

## Why it is three stages with two reboots

This is the part that catches people. `rpm-ostree` **cannot install a package
from a repo whose `.repo` file only exists in a pending, not-yet-booted
deployment.** So layering the RPM Fusion repos and layering the driver *in one
invocation* fails with "Packages not found". And `nvidia-ctk` cannot enumerate a
device whose kernel module is not loaded, which needs the driver deployment to
be booted. Hence: repos → reboot → driver → reboot → CDI.

Guard each stage with a marker file (`/var/lib/install-nvidia-*-done` is the
convention the boot-time job uses) so re-running after each reboot is a no-op
for the stages already finished. Write the marker **after** the stage succeeds,
never before.

### Stage 1 — layer the RPM Fusion repos

The nonfree NVIDIA driver builds live there, not in the base repos.

```bash
rpm-ostree install --idempotent --allow-inactive \
  "https://download1.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm" \
  "https://download1.rpmfusion.org/nonfree/fedora/rpmfusion-nonfree-release-$(rpm -E %fedora).noarch.rpm"
```

Then **reboot** — the repo definitions have to be in the *booted* deployment
before stage 2 can resolve against them.

### Stage 2 — layer the driver and the container toolkit

```bash
rpm-ostree install --idempotent --allow-inactive \
  kmod-nvidia-open-dkms \
  xorg-x11-drv-nvidia-cuda \
  nvidia-container-toolkit
```

- **`kmod-nvidia-open-dkms`** — the open kernel modules are NVIDIA's recommended
  path for Turing-and-newer cards. On an older card, use the proprietary
  `kmod-nvidia` instead; the open modules will build and then refuse to bind.
- **`nvidia-container-toolkit`** ships `nvidia-ctk`, the standard podman↔NVIDIA
  bridge. Without it there is nothing to generate a CDI spec with.

Then **reboot** again, so the kernel module is loaded.

### Stage 3 — generate the CDI spec

CDI (Container Device Interface) is what lets podman hand the GPU to a container.
Wait for the module rather than assuming it: DKMS builds the module against the
running kernel on first boot, and on a cold cache that takes minutes.

```bash
for _ in $(seq 1 30); do lsmod | grep -q '^nvidia ' && break; sleep 2; done
lsmod | grep -q '^nvidia ' || { echo "kmod never loaded"; exit 1; }

mkdir -p /etc/cdi
nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
nvidia-ctk cdi list
```

If the module never appears, the build failed rather than the wait being too
short — read `journalctl -u 'dkms*'` and `dmesg | grep -i nvidia`. A driver/kernel
mismatch after an `rpm-ostree upgrade` is the usual cause.

## Then stop the boot-time timer — the step that is easy to forget

A box built from the image also drives CDI generation from
`install-nvidia-cdi.timer`, which uses `OnUnitInactiveSec` and which **systemd
never stops by itself**. Generating CDI by hand finishes that timer's job, so
retire it explicitly:

```bash
systemctl disable --now install-nvidia-cdi.timer
```

Skip this and the timer keeps writing a journal line a minute for work that is
already done — on the order of 1400 lines a day, crowding out the lines an
operator actually needs later (#2668, #2659). The same reasoning is why the
done-marker guard lives **inside** the script the timer runs and not as a
`ConditionPathExists` on the unit: a condition-skipped fire logs "skipped, unmet
condition" for ever, because a unit condition cannot disable its own timer.

## Verify, then use it

```bash
podman run --rm --device nvidia.com/gpu=all <a CUDA-capable image> nvidia-smi
```

Seeing the card listed from *inside* a container is the proof; `nvidia-smi` on
the host only proves the driver, not the passthrough. When installing a
GPU-hungry template (the AI stack), set the template's GPU-passthrough variable
so the generated pod requests the device — a box with a working CDI spec still
runs on CPU if nothing asks for the GPU.

## Footguns

- **One `rpm-ostree install` for repos and driver together** — fails with
  "Packages not found". Two invocations with a reboot between, always.
- **Generating CDI before the kmod is loaded** — `nvidia-ctk` writes a spec with
  no devices in it, and the failure is silent until a container starts and finds
  nothing. Always gate on `lsmod`.
- **Leaving the timer running** — see above.
- **`rpm-ostree upgrade` later** — layered kmod packages are rebuilt against the
  new kernel; if the rebuild fails the box boots without the module and
  containers lose the GPU. Re-check `lsmod` after a host upgrade, and re-run
  stage 3 if `/etc/cdi/nvidia.yaml` is stale.
