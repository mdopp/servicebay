#!/usr/bin/env bash
set -euo pipefail

# Interactive installer for Fedora CoreOS using the fedora-coreos.bu template.
# Prompts for secrets (SSH key, passwords) and renders Butane -> Ignition, then
# bakes the Ignition into an ISO for fully unattended install.
#
# RAID support: creates a degraded RAID1 with a single SSD. After install,
# restore data and add the second SSD via: mdadm --add /dev/md/data /dev/sdY

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build/fcos"
TEMPLATE="$BUILD_DIR/fedora-coreos.bu" # Write template to build dir
RENDERED_BU="$BUILD_DIR/fedora-coreos.rendered.bu"
IGNITION_OUT="$BUILD_DIR/install.ign"

mkdir -p "$BUILD_DIR"

# Embedded Butane Template
cat <<'EOF' > "$TEMPLATE"
variant: fcos
version: 1.5.0

passwd:
  users:
    - name: ${HOST_USER}
      ssh_authorized_keys:
        - "${SSH_AUTHORIZED_KEY}"
        - "${SERVICEBAY_SSH_PUB}"
      groups:
        - wheel
      password_hash: "${PASSWORD_HASH}"

storage:
  directories:
    # ServiceBay persistence (rootless)
    - path: ${DATA_ROOT}/servicebay
      mode: 0755
      user:
        name: ${HOST_USER}
      group:
        name: ${HOST_USER}
    # Base stack directory (ServiceBay will create subfolders)
    - path: ${DATA_ROOT}/stacks
      mode: 0755
      user:
        name: ${HOST_USER}
      group:
        name: ${HOST_USER}
    
    # Ensure intermediate directories are owned by user
    - path: /var/home/${HOST_USER}/.config
      mode: 0755
      user:
        name: ${HOST_USER}
      group:
        name: ${HOST_USER}
    - path: /var/home/${HOST_USER}/.config/containers
      mode: 0755
      user:
        name: ${HOST_USER}
      group:
        name: ${HOST_USER}
    - path: /var/home/${HOST_USER}/.config/systemd
      mode: 0755
      user:
        name: ${HOST_USER}
      group:
        name: ${HOST_USER}
    - path: /var/home/${HOST_USER}/.config/systemd/user
      mode: 0755
      user:
        name: ${HOST_USER}
      group:
        name: ${HOST_USER}
    - path: /var/home/${HOST_USER}/.config/systemd/user/sockets.target.wants
      mode: 0755
      user:
        name: ${HOST_USER}
      group:
        name: ${HOST_USER}

    # ServiceBay SSH directory
    - path: ${DATA_ROOT}/servicebay/ssh
      mode: 0700
      user:
        name: ${HOST_USER}
      group:
        name: ${HOST_USER}

    # USB automount root (USB drives mounted as /mnt/usb/<label>)
    - path: /mnt/usb
      mode: 0777

    # Quadlet directory for the user
    - path: /var/home/${HOST_USER}/.config/containers/systemd
      mode: 0755
      user:
        name: ${HOST_USER}
      group:
        name: ${HOST_USER}

  files:
    # Hostname
    - path: /etc/hostname
      mode: 0644
      overwrite: true
      contents:
        inline: ${SERVER_NAME}

    # Free port 53 for AdGuard Home — disable systemd-resolved's stub listener.
    # Without this, AdGuard's DNS port collides with the 127.0.0.53:53 stub on
    # FCOS and the install wizard refuses to bind. /etc/resolv.conf is
    # repointed below so name resolution still works via systemd-resolved.
    - path: /etc/systemd/resolved.conf.d/no-stub.conf
      mode: 0644
      contents:
        inline: |
          [Resolve]
          DNSStubListener=no

    # USB automount: udev rule to trigger systemd service on USB block device add
    - path: /etc/udev/rules.d/99-usb-automount.rules
      mode: 0644
      contents:
        inline: |
          ACTION=="add", SUBSYSTEM=="block", ENV{ID_BUS}=="usb", ENV{DEVTYPE}=="partition", TAG+="systemd", ENV{SYSTEMD_WANTS}="usb-mount@%k.service"
          ACTION=="remove", SUBSYSTEM=="block", ENV{ID_BUS}=="usb", ENV{DEVTYPE}=="partition", RUN+="/usr/local/bin/usb-mount.sh remove %k"

    # Z-Wave / serial USB passthrough to rootless containers.
    # /dev/ttyACM* defaults to crw-rw---- root:dialout, which leaves a
    # rootless podman container's "nobody" user with no read access
    # (logs as "permission denied opening serial port"). MODE=0666
    # opens it to everyone — fine on a single-user homelab, and the
    # only practical option without rebuilding the rootless uid
    # mapping. The SYMLINK= rule pins the Sigma Designs / Aeotec
    # Z-Wave stick at /dev/zwave so the home-assistant template can
    # mount a stable path regardless of which /dev/ttyACM<N> the
    # kernel assigns this boot.
    - path: /etc/udev/rules.d/99-zwave.rules
      mode: 0644
      contents:
        inline: |
          SUBSYSTEM=="tty", KERNEL=="ttyACM*", MODE="0666"
          SUBSYSTEM=="tty", ATTRS{idVendor}=="0658", ATTRS{idProduct}=="0200", SYMLINK+="zwave"

    # USB automount: mount/unmount script
    - path: /usr/local/bin/usb-mount.sh
      mode: 0755
      contents:
        inline: |
          #!/usr/bin/env bash
          set -euo pipefail
          ACTION="${1:-}"
          DEVNAME="${2:-}"
          DEV="/dev/$DEVNAME"
          USB_ROOT="/mnt/usb"

          case "$ACTION" in
            add)
              # Use filesystem label if available, else device name
              LABEL=$(lsblk -ndo LABEL "$DEV" 2>/dev/null || echo "")
              [[ -z "$LABEL" ]] && LABEL="$DEVNAME"
              # Sanitize label for use as directory name
              LABEL=$(echo "$LABEL" | tr -c 'A-Za-z0-9._-' '_')
              MOUNT_POINT="$USB_ROOT/$LABEL"
              mkdir -p "$MOUNT_POINT"
              mount -o rw,noatime "$DEV" "$MOUNT_POINT"
              echo "usb-mount: mounted $DEV at $MOUNT_POINT"
              ;;
            remove)
              MOUNT_POINT=$(findmnt -nro TARGET "$DEV" 2>/dev/null || true)
              if [[ -n "$MOUNT_POINT" && "$MOUNT_POINT" == "$USB_ROOT"/* ]]; then
                umount -l "$MOUNT_POINT"
                rmdir "$MOUNT_POINT" 2>/dev/null || true
                echo "usb-mount: unmounted $DEV from $MOUNT_POINT"
              fi
              ;;
            *)
              echo "Usage: usb-mount.sh {add|remove} <device>" >&2
              exit 1
              ;;
          esac

    # USB automount: systemd template unit triggered by udev
    - path: /etc/systemd/system/usb-mount@.service
      mode: 0644
      contents:
        inline: |
          [Unit]
          Description=Mount USB device %i
          After=local-fs.target

          [Service]
          Type=oneshot
          RemainAfterExit=yes
          ExecStart=/usr/local/bin/usb-mount.sh add %i
          ExecStop=/usr/local/bin/usb-mount.sh remove %i

    # Network: Static IP
    - path: /etc/NetworkManager/system-connections/${NET_INTERFACE}.nmconnection
      mode: 0600
      contents:
        inline: |
          [connection]
          id=${NET_INTERFACE}
          type=ethernet
          interface-name=${NET_INTERFACE}
          autoconnect=true
          autoconnect-priority=10

          [ipv4]
          method=manual
          address1=${STATIC_IP}/${STATIC_PREFIX},${GATEWAY}
          dns=${DNS_SERVERS}

          [ipv6]
          method=auto

    # First-boot RAID setup script
    # Finds the largest non-OS disk, creates a degraded RAID1, formats and mounts it.
    - path: /usr/local/bin/setup-raid.sh
      mode: 0755
      contents:
        inline: |
          #!/usr/bin/env bash
          set -euo pipefail
          MOUNT_POINT="${DATA_ROOT}"
          HOST_USER="${HOST_USER}"

          # Find the OS disk (the one holding /)
          # Newer FCOS uses composefs overlay for / — fall back to /sysroot
          ROOT_SOURCE=$(findmnt -n -o SOURCE /)
          if ! lsblk "$ROOT_SOURCE" &>/dev/null; then
            ROOT_SOURCE=$(findmnt -n -o SOURCE /sysroot)
          fi
          OS_DISK=$(lsblk -ndo PKNAME "$ROOT_SOURCE" | head -1)

          # Find the largest non-OS, non-removable disk
          RAID_DISK=""
          RAID_SIZE=0
          for dev in $(lsblk -dnpo NAME -I 8,259,254 --sort SIZE); do
            name=$(basename "$dev")
            # Skip OS disk and its partitions
            [[ "$name" == "$OS_DISK"* ]] && continue
            # Skip removable (USB)
            [[ "$(cat /sys/block/${name}/removable 2>/dev/null)" == "1" ]] && continue
            size=$(blockdev --getsize64 "$dev" 2>/dev/null || echo 0)
            if (( size > RAID_SIZE )); then
              RAID_SIZE=$size
              RAID_DISK=$dev
            fi
          done

          if [[ -z "$RAID_DISK" ]]; then
            echo "setup-raid: no suitable disk found for RAID. Skipping." >&2
            exit 0
          fi

          echo "setup-raid: OS disk=$OS_DISK, RAID disk=$RAID_DISK ($(( RAID_SIZE / 1073741824 )) GiB)"

          # Find the RAID device — the kernel may auto-assemble it under any /dev/mdN name.
          # Check for existing auto-assembled arrays first, then try manual assembly, then create new.
          MD_DEV=""

          # 1) Check if any md device already uses a partition from RAID_DISK
          for part in "${RAID_DISK}p1" "${RAID_DISK}1" "$RAID_DISK"; do
            [[ -e "$part" ]] || continue
            # Find which md device contains this partition
            for md in /dev/md[0-9]*; do
              [[ -e "$md" ]] || continue
              if mdadm --detail "$md" 2>/dev/null | grep -q "$part"; then
                MD_DEV="$md"
                echo "setup-raid: found auto-assembled array $MD_DEV containing $part"
                break 2
              fi
            done
          done

          # 2) Also check /dev/md/data symlink (may exist if we created the array)
          if [[ -z "$MD_DEV" && -e /dev/md/data ]]; then
            MD_DEV=$(readlink -f /dev/md/data)
            echo "setup-raid: found /dev/md/data -> $MD_DEV"
          fi

          # 3) Try manual assembly if not already active
          if [[ -z "$MD_DEV" ]]; then
            for part in "${RAID_DISK}p1" "${RAID_DISK}1" "$RAID_DISK"; do
              if [[ -e "$part" ]] && mdadm --examine "$part" &>/dev/null; then
                echo "setup-raid: found RAID superblock on $part, assembling"
                if mdadm --assemble /dev/md/data "$part" --run 2>/dev/null; then
                  MD_DEV=$(readlink -f /dev/md/data)
                  echo "setup-raid: assembled as $MD_DEV"
                fi
                break
              fi
            done
          fi

          # 4) Create new array if nothing found
          if [[ -z "$MD_DEV" ]]; then
            echo "setup-raid: no existing RAID found, creating new array"

            # Partition the disk
            wipefs -a "$RAID_DISK"
            sgdisk -Z -n 1:0:0 -t 1:fd00 -c 1:raid1-ssd1 "$RAID_DISK"

            # Wait for partition to appear
            udevadm settle
            PART="${RAID_DISK}1"
            # For nvme disks the partition is e.g. /dev/nvme0n1p1
            [[ -e "$PART" ]] || PART="${RAID_DISK}p1"

            # Create degraded RAID1 (second disk missing)
            mdadm --create /dev/md/data --level=1 --raid-devices=2 --metadata=1.2 \
              --run "$PART" missing

            # Format
            mkfs.xfs -L data /dev/md/data
            MD_DEV=$(readlink -f /dev/md/data)
          fi

          echo "setup-raid: using RAID device $MD_DEV"

          # Persist mdadm config
          mdadm --detail --scan >> /etc/mdadm.conf

          # Ignition writes ServiceBay config to the OS disk at $MOUNT_POINT/servicebay.
          # Before mounting the RAID over $MOUNT_POINT, save those files so we can
          # copy them into the RAID afterwards.
          IGNITION_TMP=""
          if [[ -d "$MOUNT_POINT/servicebay" ]]; then
            IGNITION_TMP=$(mktemp -d)
            cp -a "$MOUNT_POINT/servicebay" "$IGNITION_TMP/"
            echo "setup-raid: saved Ignition config from OS disk"
          fi

          # Mount RAID directly. We avoid `systemctl start var-mnt-data.mount`
          # from inside this service because the synchronous systemctl call
          # used to deadlock against the mount unit's previous After=setup-raid
          # ordering (now removed, but a direct mount is simpler and faster
          # anyway). The systemd mount unit still exists and will reattach the
          # RAID on subsequent boots via its WantedBy=multi-user.target.
          mkdir -p "$MOUNT_POINT"
          if findmnt -n "$MOUNT_POINT" >/dev/null 2>&1; then
            echo "setup-raid: $MOUNT_POINT already mounted, skipping"
          else
            mount "$MD_DEV" "$MOUNT_POINT"
            echo "setup-raid: mounted $MD_DEV at $MOUNT_POINT"
          fi

          # Create data directories (no-op if they already exist)
          mkdir -p "$MOUNT_POINT/servicebay/ssh" "$MOUNT_POINT/stacks"

          # Apply Ignition config into RAID
          if [[ -n "$IGNITION_TMP" && -d "$IGNITION_TMP/servicebay" ]]; then
            # Always overwrite nodes.json and SSH keys (may change between installs)
            for f in nodes.json ssh/id_rsa ssh/id_rsa.pub; do
              if [[ -f "$IGNITION_TMP/servicebay/$f" ]]; then
                cp "$IGNITION_TMP/servicebay/$f" "$MOUNT_POINT/servicebay/$f"
              fi
            done
            # config.json: stage the new ISO copy alongside the existing
            # one. setup-config-merge.service does the smart merge once
            # python3 is available (we run too early here for python).
            # On a fresh box (no existing config.json) we just rename
            # the new one into place — no merge needed.
            if [[ -f "$IGNITION_TMP/servicebay/config.json" ]]; then
              if [[ -f "$MOUNT_POINT/servicebay/config.json" ]]; then
                cp "$IGNITION_TMP/servicebay/config.json" "$MOUNT_POINT/servicebay/config.iso.json"
                echo "setup-raid: existing config.json found, staged ISO copy as config.iso.json (merge runs after python install)"
              else
                cp "$IGNITION_TMP/servicebay/config.json" "$MOUNT_POINT/servicebay/config.json"
                echo "setup-raid: no existing config.json, wrote ISO config directly"
              fi
            fi
            rm -rf "$IGNITION_TMP"
            echo "setup-raid: applied Ignition config to RAID"
          fi

          chmod 600 "$MOUNT_POINT/servicebay/ssh/id_rsa" 2>/dev/null || true
          chown -R "$HOST_USER:$HOST_USER" "$MOUNT_POINT/servicebay" "$MOUNT_POINT/stacks"

          # Restore Quadlet service definitions from RAID backup (reinstall scenario)
          QUADLET_BACKUP="$MOUNT_POINT/servicebay/quadlet-backup"
          QUADLET_DIR="/var/home/$HOST_USER/.config/containers/systemd"
          if [[ -d "$QUADLET_BACKUP" ]] && ls "$QUADLET_BACKUP"/*.{kube,yml,container} &>/dev/null; then
            echo "setup-raid: restoring Quadlet service definitions from RAID backup..."
            mkdir -p "$QUADLET_DIR"
            cp -a "$QUADLET_BACKUP"/*.kube "$QUADLET_DIR/" 2>/dev/null || true
            cp -a "$QUADLET_BACKUP"/*.yml "$QUADLET_DIR/" 2>/dev/null || true
            cp -a "$QUADLET_BACKUP"/*.container "$QUADLET_DIR/" 2>/dev/null || true
            chown -R "$HOST_USER:$HOST_USER" "$QUADLET_DIR"
            echo "setup-raid: restored $(ls "$QUADLET_DIR"/*.kube 2>/dev/null | wc -l) service(s)"
          fi

          # Note: nginx config lives directly on RAID at DATA_DIR/nginx/ — no restore needed,
          # it survives reinstalls by being on the RAID mount itself.

          echo "setup-raid: done. RAID1 mounted at $MOUNT_POINT"

    # Systemd mount unit for RAID at /var/mnt/data (FCOS: /mnt -> /var/mnt)
    # Uses filesystem label so it works regardless of md device number.
    # nofail: don't block boot if RAID doesn't exist yet (first boot before setup-raid).
    #
    # NB: the previous After=setup-raid.service caused a one-hour first-boot
    # deadlock — setup-raid.sh calls `systemctl start var-mnt-data.mount`
    # synchronously, but systemd refused to start the mount until setup-raid
    # was `active`, and setup-raid wasn't going active until the systemctl
    # call returned. Relying solely on `Before=var-mnt-data.mount` declared
    # *on setup-raid.service* (next unit below) preserves correct boot
    # ordering while letting the explicit start call from inside setup-raid
    # actually proceed.
    - path: /etc/systemd/system/var-mnt-data.mount
      mode: 0644
      contents:
        inline: |
          [Unit]
          Description=Mount RAID data volume
          After=local-fs.target

          [Mount]
          What=LABEL=data
          Where=/var/mnt/data
          Type=xfs
          Options=defaults,nofail

          [Install]
          WantedBy=multi-user.target

    # Systemd unit to run RAID setup on first boot only
    - path: /etc/systemd/system/setup-raid.service
      mode: 0644
      contents:
        inline: |
          [Unit]
          Description=First-boot RAID1 setup (auto-detect largest disk)
          ConditionPathExists=!/var/lib/setup-raid-done
          After=local-fs.target systemd-udevd.service
          Before=var-mnt-data.mount multi-user.target

          [Service]
          Type=oneshot
          RemainAfterExit=yes
          ExecStart=/bin/bash /usr/local/bin/setup-raid.sh
          ExecStartPost=/bin/touch /var/lib/setup-raid-done

          [Install]
          WantedBy=multi-user.target

    # User Linger (enables rootless services at boot)
    - path: /var/lib/systemd/linger/${HOST_USER}
      mode: 0644

    # ServiceBay Quadlet (rootless).
    #
    # AUTH_SECRET is loaded from an EnvironmentFile on the persistent
    # data volume (${DATA_ROOT}/servicebay/.auth-secret.env) so it
    # survives OS reinstalls. Without this, every reinstall would
    # regenerate AUTH_SECRET → all encrypted values in config.json
    # (FritzBox password, NPM password, anything else sealed via the
    # secrets helper) decrypt to garbage. The companion oneshot
    # `servicebay-auth-secret-init.service` (declared below in
    # `systemd.units`) writes that file on first boot if missing.
    # See issue #565.
    - path: /var/home/${HOST_USER}/.config/containers/systemd/servicebay.container
      mode: 0644
      user:
        name: ${HOST_USER}
      group:
        name: ${HOST_USER}
      contents:
        inline: |
          [Unit]
          Description=ServiceBay Rootless Management Interface
          After=network-online.target
          # Deliberately NO Requires=/After=servicebay-auth-secret-init.service.
          # That unit is in the system instance and is invisible to user
          # systemd here (a user unit referencing it by name fails to start
          # with "Unit not found", #586). The ordering is already guaranteed
          # by the init unit's `Before=user@1000.service` (see below) — by
          # the time user systemd activates this Quadlet via linger, the
          # EnvironmentFile is already on disk.

          [Container]
          Image=ghcr.io/mdopp/servicebay:${SERVICEBAY_VERSION}
          ContainerName=servicebay
          AutoUpdate=registry
          Network=host
          Volume=/run/user/1000/podman/podman.sock:/run/podman/podman.sock
          Environment=CONTAINER_HOST=unix:///run/podman/podman.sock
          Volume=${DATA_ROOT}/servicebay:/app/data:Z
          Environment=PORT=${SERVICEBAY_PORT}
          Environment=NODE_ENV=production
          Environment=HOST_USER=${HOST_USER}
          EnvironmentFile=${DATA_ROOT}/servicebay/.auth-secret.env
          Environment=SERVICEBAY_USERNAME=${SERVICEBAY_ADMIN_USER}
          Environment=SERVICEBAY_PASSWORD=${SERVICEBAY_ADMIN_PASSWORD}
          SecurityLabelDisable=true

          [Service]
          # Retry restart if it fails (e.g. socket not ready)
          Restart=always
          RestartSec=5

          [Install]
          WantedBy=default.target

    # ServiceBay Initial Config (generated by install script)
    - path: ${DATA_ROOT}/servicebay/config.json
      mode: 0644
      user:
        name: ${HOST_USER}
      group:
        name: ${HOST_USER}
      contents:
        inline: |
${SERVICEBAY_CONFIG_JSON}

    # ServiceBay nodes config (Local node with correct user)
    - path: ${DATA_ROOT}/servicebay/nodes.json
      mode: 0644
      user:
        name: ${HOST_USER}
      group:
        name: ${HOST_USER}
      contents:
        inline: |
          [
            {
              "Name": "Local",
              "URI": "ssh://${HOST_USER}@127.0.0.1",
              "Identity": "/app/data/ssh/id_rsa",
              "Default": true
            }
          ]

    # ServiceBay SSH private key (pre-authorized for host access)
    - path: ${DATA_ROOT}/servicebay/ssh/id_rsa
      mode: 0600
      user:
        name: ${HOST_USER}
      group:
        name: ${HOST_USER}
      contents:
        inline: |
${SERVICEBAY_SSH_PRIV}

    # ServiceBay SSH public key
    - path: ${DATA_ROOT}/servicebay/ssh/id_rsa.pub
      mode: 0644
      user:
        name: ${HOST_USER}
      group:
        name: ${HOST_USER}
      contents:
        inline: |
          ${SERVICEBAY_SSH_PUB}

    # First-boot script to install Python3 (required by ServiceBay agent)
    - path: /usr/local/bin/install-python.sh
      mode: 0755
      contents:
        inline: |
          #!/bin/bash
          set -euo pipefail
          echo "install-python: installing python3 via rpm-ostree..."
          rpm-ostree install --apply-live --allow-inactive python3
          echo "install-python: done"

    # Systemd unit to install Python3 on first boot
    - path: /etc/systemd/system/install-python.service
      mode: 0644
      contents:
        inline: |
          [Unit]
          Description=Install Python3 for ServiceBay agent
          ConditionPathExists=!/var/lib/install-python-done
          After=network-online.target
          Wants=network-online.target

          [Service]
          Type=oneshot
          RemainAfterExit=yes
          ExecStart=/bin/bash /usr/local/bin/install-python.sh
          ExecStartPost=/bin/touch /var/lib/install-python-done

          [Install]
          WantedBy=multi-user.target

    # Re-install config-merge script (#331). On a re-install, setup-raid
    # leaves the existing config.json alone (so runtime-managed values
    # like encrypted password hashes + LLDAP creds + NPM creds + post-
    # deploy run history aren't lost) but stages the freshly-rendered
    # ISO config as `config.iso.json` alongside. This script combines
    # the two:
    #   - starts from the new ISO config (operator's current intent)
    #   - overlays a small whitelist of runtime-managed paths from the
    #     old config (everything else from the new ISO wins)
    #   - writes back atomically + removes config.iso.json
    #
    # Without this, every new schema field added in a future ServiceBay
    # release silently fails to land on re-installed boxes.
    - path: /usr/local/bin/setup-config-merge.py
      mode: 0755
      contents:
        inline: |
          #!/usr/bin/env python3
          """Merge a freshly-staged ISO config (config.iso.json) into the
          existing config.json on a re-install, preserving runtime-managed
          fields. Idempotent: no-op when config.iso.json doesn't exist."""
          import json
          import os
          import sys

          DIR = "/var/mnt/data/servicebay"
          OLD = os.path.join(DIR, "config.json")
          NEW = os.path.join(DIR, "config.iso.json")

          # Paths whose value the runtime owns (not the install prompts).
          # Everything not on this list takes its value from the new ISO
          # config — that mirrors what the operator just typed.
          PRESERVE_PATHS = [
              ("auth", "password"),
              ("auth", "passwordHash"),
              ("lldap",),
              ("reverseProxy", "npm"),
              ("reverseProxy", "lanIp"),
              ("reverseProxy", "lanIpHistory"),
              ("servicePostDeploy",),
              ("agent",),
          ]

          def get_path(obj, path):
              cur = obj
              for k in path:
                  if not isinstance(cur, dict) or k not in cur:
                      return None, False
                  cur = cur[k]
              return cur, True

          def set_path(obj, path, value):
              cur = obj
              for k in path[:-1]:
                  if k not in cur or not isinstance(cur[k], dict):
                      cur[k] = {}
                  cur = cur[k]
              cur[path[-1]] = value

          def main():
              if not os.path.exists(NEW):
                  return 0
              if not os.path.exists(OLD):
                  os.replace(NEW, OLD)
                  print("setup-config-merge: no prior config.json, ISO copy promoted in place.")
                  return 0
              with open(OLD) as f:
                  old = json.load(f)
              with open(NEW) as f:
                  new = json.load(f)
              merged = new
              kept = 0
              for path in PRESERVE_PATHS:
                  val, found = get_path(old, path)
                  if found:
                      set_path(merged, path, val)
                      kept += 1
              # Tag the merge so the dashboard can show a "Welcome
              # back — services restoring" banner instead of a silent
              # boot (#337). Only set on the merge path; a true fresh
              # install (no prior config.json) goes through the
              # promote-in-place branch above and leaves `reinstall`
              # unset.
              import datetime
              merged["reinstall"] = {"completedAt": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")}
              tmp = OLD + ".merge.tmp"
              with open(tmp, "w") as f:
                  json.dump(merged, f, indent=2)
              # ServiceBay runs as the host user (uid 1000, `core`).
              # This service runs as root, so without explicit chown
              # the merged config.json ends up root:root and the
              # container gets EACCES when reading it. getConfig()'s
              # catch then falls back to DEFAULT_CONFIG, migrateConfig
              # saves that empty default, and every install-time value
              # (auth, gateway, bootstrap token, setupCompleted,
              # stackSetupPending) vanishes silently. Match the
              # ownership setup-raid uses for everything else in
              # /var/mnt/data/servicebay.
              try:
                  import pwd
                  core = pwd.getpwnam("core")
                  os.chown(tmp, core.pw_uid, core.pw_gid)
              except (KeyError, OSError):
                  # Static fallback — install-fedora-coreos.sh always
                  # creates `core` with uid/gid 1000.
                  os.chown(tmp, 1000, 1000)
              os.chmod(tmp, 0o600)
              os.replace(tmp, OLD)
              os.remove(NEW)
              print(f"setup-config-merge: merged config.iso.json into config.json (preserved {kept} runtime path(s)).")

              # Wipe install-jobs from the previous OS instance. The
              # job files survive a re-install (RAID mount), and the
              # OnboardingWizard's auto-open gates on "no terminal
              # job exists" — stale jobs from before the re-install
              # suppress the wizard. They're also useless after a re-
              # install: their logs reference container IDs and paths
              # that no longer exist. Drop them so the wizard fires
              # cleanly on first boot.
              import shutil
              jobs_dir = os.path.join(DIR, "install-jobs")
              if os.path.isdir(jobs_dir):
                  try:
                      shutil.rmtree(jobs_dir)
                      print("setup-config-merge: cleared stale install-jobs from previous OS install.")
                  except OSError as e:
                      print(f"setup-config-merge: could not clear install-jobs: {e}", file=sys.stderr)
              return 0

          if __name__ == "__main__":
              sys.exit(main())

    # AUTH_SECRET init — generates a fresh secret on first boot if no
    # persistent one exists yet. Re-installs find the existing file and
    # leave it alone so encrypted values in config.json keep decrypting.
    # See #565.
    - path: /etc/systemd/system/servicebay-auth-secret-init.service
      mode: 0644
      contents:
        inline: |
          [Unit]
          Description=Initialise persistent AUTH_SECRET for ServiceBay (#565)
          DefaultDependencies=no
          After=var-mnt-data.mount local-fs.target
          RequiresMountsFor=/var/mnt/data
          Before=user@1000.service

          [Service]
          Type=oneshot
          RemainAfterExit=yes
          # mkdir is idempotent; the conditional generation lives in the
          # shell script so an existing .auth-secret.env survives intact
          # even when this oneshot re-runs (e.g. after `systemctl daemon-reload`).
          # systemd treats `%s` in ExecStart= as a specifier ($SHELL) and
          # substitutes it *before* invoking sh. Pre-fix: the printf format
          # string was rewritten from "AUTH_SECRET=%s\n" to
          # "AUTH_SECRET=/bin/bash\n" — so every fresh install wrote that
          # 9-char nonsense into .auth-secret.env, and ServiceBay's
          # assertAuthSecret() (≥32 chars required) crashed the container
          # in a restart loop. Escape with `%%s` so systemd renders it as
          # literal `%s` before the shell sees it. Same fix anywhere
          # `printf` is used inside ExecStart=/usr/bin/sh -c.
          ExecStart=/usr/bin/sh -c '\
            install -d -m 0755 -o ${HOST_USER} -g ${HOST_USER} /var/mnt/data/servicebay; \
            if [ ! -s /var/mnt/data/servicebay/.auth-secret.env ]; then \
              SECRET=$$(/usr/bin/openssl rand -hex 32); \
              umask 0177; \
              printf "AUTH_SECRET=%%s\\n" "$$SECRET" > /var/mnt/data/servicebay/.auth-secret.env; \
              chown ${HOST_USER}:${HOST_USER} /var/mnt/data/servicebay/.auth-secret.env; \
              echo "AUTH_SECRET written (fresh install or first migration)"; \
            else \
              echo "AUTH_SECRET preserved from previous install"; \
            fi'

          [Install]
          WantedBy=multi-user.target

    # Systemd unit for the config-merge — runs once after install-python
    # so python3 is guaranteed available, before servicebay.service.
    - path: /etc/systemd/system/setup-config-merge.service
      mode: 0644
      contents:
        inline: |
          [Unit]
          Description=Merge re-install ISO config into existing config.json (#331)
          ConditionPathExists=/var/mnt/data/servicebay/config.iso.json
          After=install-python.service var-mnt-data.mount servicebay-auth-secret-init.service
          Requires=install-python.service var-mnt-data.mount
          # No `Before=servicebay.service` — that unit is in the user
          # systemd instance (Quadlet under ~/.config/containers/systemd)
          # and isn't visible to the system bus. The user instance only
          # starts after the system reaches multi-user.target, which
          # this oneshot is ordered into via WantedBy below — so the
          # merge always completes before the container reads config.

          [Service]
          Type=oneshot
          RemainAfterExit=yes
          ExecStart=/usr/bin/python3 /usr/local/bin/setup-config-merge.py

          [Install]
          WantedBy=multi-user.target

    # First-boot script to install Nginx reverse proxy via ServiceBay API
    - path: /usr/local/bin/install-nginx.sh
      mode: 0755
      user:
        name: ${HOST_USER}
      group:
        name: ${HOST_USER}
      contents:
        inline: |
          #!/bin/bash
          set -euo pipefail
          PORT="${SERVICEBAY_PORT:-3000}"
          API="http://localhost:$PORT"
          API_WAIT=1800       # 30 min for ServiceBay API + agent. Earlier
                              # 5-min cap timed out before the agent came
                              # up on slow first-boots, leaving the unit in
                              # `failed` state forever even though NPM was
                              # later installed cleanly via the wizard.
          INSTALLED_WAIT=1800 # 30 min for nginx to appear via the onboarding
                              # wizard before we step in. Avoids racing the
                              # interactive install which can take a while
                              # to reach the "Reverse Proxy" step.
          WAITED=0
          MARKER=/var/home/${HOST_USER}/.config/install-nginx-done

          # Always touch the marker on EXIT (success OR failure). The marker's
          # ConditionPathExists in the .service unit then suppresses the unit
          # on subsequent boots — even if this run gave up because the
          # operator had already installed NPM via the wizard, we're done
          # and the wizard owns NPM going forward. Without this trap a
          # one-time wait timeout produced an permanently-`failed` unit
          # the operator couldn't get rid of without a manual reset-failed.
          trap 'mkdir -p "$(dirname "$MARKER")" && touch "$MARKER"' EXIT

          # Helper: returns 0 if NPM is reported as installed, 1 otherwise.
          is_installed() {
            curl -sf "$API/api/system/nginx/status" 2>/dev/null \
              | grep -q '"installed":true'
          }

          echo "install-nginx: waiting for ServiceBay API on port $PORT (up to ${API_WAIT}s)..."
          while ! curl -sf "$API/api/system/nginx/status" >/dev/null 2>&1; do
            sleep 5
            WAITED=$((WAITED + 5))
            if (( WAITED >= API_WAIT )); then
              echo "install-nginx: timeout waiting for ServiceBay API after ${API_WAIT}s — assume the operator will install NPM via the wizard" >&2
              exit 0
            fi
          done

          # Quick win: if NPM is already installed by the time the API is
          # reachable (interactive wizard finished first), skip everything.
          if is_installed; then
            echo "install-nginx: nginx already installed — nothing to do"
            exit 0
          fi

          # Wait for at least one agent to be connected (needs python3 first).
          echo "install-nginx: waiting for agent to connect..."
          while true; do
            if is_installed; then
              echo "install-nginx: nginx came up while we were waiting — done"
              exit 0
            fi
            CONNECTED=$(curl -sf "$API/api/system/health" | grep -o '"isConnected":true' || true)
            if [[ -n "$CONNECTED" ]]; then break; fi
            sleep 5
            WAITED=$((WAITED + 5))
            if (( WAITED >= API_WAIT )); then
              echo "install-nginx: timeout waiting for agent after ${API_WAIT}s — operator will install NPM via the wizard" >&2
              exit 0
            fi
          done
          echo "install-nginx: agent connected"

          # Poll for installed=true. The operator may install NPM via the
          # onboarding wizard concurrently — don't race it.
          echo "install-nginx: polling for nginx-web service (up to ${INSTALLED_WAIT}s for the wizard to finish)..."
          POLL_WAITED=0
          while (( POLL_WAITED < INSTALLED_WAIT )); do
            if is_installed; then
              echo "install-nginx: nginx is installed, nothing to do"
              exit 0
            fi
            sleep 30
            POLL_WAITED=$((POLL_WAITED + 30))
          done

          echo "install-nginx: wizard didn't install nginx in ${INSTALLED_WAIT}s, attempting install ourselves..."
          for attempt in 1 2 3; do
            if curl -sf -X POST "$API/api/system/nginx/install"; then
              echo "install-nginx: done"
              exit 0
            fi
            echo "install-nginx: attempt $attempt failed, retrying in 10s..."
            sleep 10
          done
          echo "install-nginx: all attempts failed — install nginx manually from Settings → Reverse Proxy" >&2
          # Marker still gets touched by the trap so the unit doesn't keep
          # showing `failed` on every boot. Operator sees the warning above
          # in journalctl and the diagnose probe surfaces the missing NPM.
          exit 1

    # Systemd user unit to install Nginx on first boot
    - path: /var/home/${HOST_USER}/.config/systemd/user/install-nginx.service
      mode: 0644
      user:
        name: ${HOST_USER}
      group:
        name: ${HOST_USER}
      contents:
        inline: |
          [Unit]
          Description=Install Nginx reverse proxy via ServiceBay
          ConditionPathExists=!/var/home/${HOST_USER}/.config/install-nginx-done
          After=servicebay.service

          [Service]
          Type=oneshot
          RemainAfterExit=yes
          ExecStart=/bin/bash /usr/local/bin/install-nginx.sh
          ExecStartPost=/bin/touch /var/home/${HOST_USER}/.config/install-nginx-done

          [Install]
          WantedBy=default.target

    # First-boot script to restore USB as first boot device (enables reinstall via USB)
    - path: /usr/local/bin/restore-usb-boot.sh
      mode: 0755
      contents:
        inline: |
          #!/usr/bin/env bash
          set -euo pipefail
          # Restore USB as first boot device so reinserting the USB stick triggers reinstall
          USB_ENTRY=$(efibootmgr | grep -i -m1 'usb\|UEFI.*USB\|removable' | grep -oP 'Boot\K[0-9A-Fa-f]+')
          if [[ -n "$USB_ENTRY" ]]; then
            CURRENT=$(efibootmgr | grep -oP 'BootOrder: \K.*')
            NEW="$USB_ENTRY,$(echo "$CURRENT" | sed "s/$USB_ENTRY,\?//;s/,$//")"
            efibootmgr -o "$NEW"
            echo "restore-usb-boot: boot order set to $NEW (USB first)"
          else
            echo "restore-usb-boot: no USB boot entry found, skipping"
          fi

          # Write GRUB custom menu entry for USB reinstall
          mount -o remount,rw /boot 2>/dev/null || true
          cat > /boot/grub2/custom.cfg <<'GRUBCFG'
          set timeout=3
          menuentry 'Reinstall from USB' --class usb {
            insmod chain
            insmod part_gpt
            # Try non-primary disks (NVMe OS disk is typically hd0)
            for i in 1 2 3 4; do
              for p in 1 2; do
                if [ -f (hd$i,gpt$p)/EFI/BOOT/BOOTX64.EFI ]; then
                  chainloader (hd$i,gpt$p)/EFI/BOOT/BOOTX64.EFI
                  boot
                fi
              done
            done
            echo "No USB boot device found. Entering UEFI firmware setup..."
            sleep 3
            fwsetup
          }
          GRUBCFG
          echo "restore-usb-boot: wrote GRUB custom menu entry"

    # Systemd unit to restore USB-first boot order on first boot
    - path: /etc/systemd/system/restore-usb-boot.service
      mode: 0644
      contents:
        inline: |
          [Unit]
          Description=Restore USB-first boot order (enables reinstall via USB)
          ConditionPathExists=!/var/lib/restore-usb-boot-done
          After=local-fs.target

          [Service]
          Type=oneshot
          RemainAfterExit=yes
          ExecStart=/usr/local/bin/restore-usb-boot.sh
          ExecStartPost=/usr/bin/touch /var/lib/restore-usb-boot-done

          [Install]
          WantedBy=multi-user.target

  links:
    # Repoint /etc/resolv.conf away from the stub listener (which we disabled
    # above to free port 53 for AdGuard). systemd-resolved still writes
    # upstream DNS into /run/systemd/resolve/resolv.conf, so name resolution
    # on the host keeps working.
    - path: /etc/resolv.conf
      target: /run/systemd/resolve/resolv.conf
      overwrite: true

    # Enable RAID data mount
    - path: /etc/systemd/system/multi-user.target.wants/var-mnt-data.mount
      target: /etc/systemd/system/var-mnt-data.mount

    # Enable first-boot RAID setup
    - path: /etc/systemd/system/multi-user.target.wants/setup-raid.service
      target: /etc/systemd/system/setup-raid.service

    # Enable Podman Socket for the user (required for ServiceBay to control the host)
    - path: /var/home/${HOST_USER}/.config/systemd/user/sockets.target.wants/podman.socket
      target: /usr/lib/systemd/user/podman.socket
      user:
        name: ${HOST_USER}
      group:
        name: ${HOST_USER}

    # Enable Python3 install on first boot
    - path: /etc/systemd/system/multi-user.target.wants/install-python.service
      target: /etc/systemd/system/install-python.service

    # Enable AUTH_SECRET init on first boot (#565). The `[Install]
    # WantedBy=` block in the unit file isn't enough on its own because
    # Ignition writes the file but doesn't `systemctl enable` it — the
    # symlink has to be present in the wants/ directory at ignition
    # time, matching how every other system-level oneshot here is wired.
    - path: /etc/systemd/system/multi-user.target.wants/servicebay-auth-secret-init.service
      target: /etc/systemd/system/servicebay-auth-secret-init.service

    # Enable setup-config-merge on first boot (#331). Without this
    # symlink, Ignition drops the unit file at /etc/systemd/system/
    # but never enables it — systemd ignores the [Install] section
    # of unit files placed via Ignition, so an explicit
    # multi-user.target.wants symlink is required, same as the
    # other first-boot units above.
    - path: /etc/systemd/system/multi-user.target.wants/setup-config-merge.service
      target: /etc/systemd/system/setup-config-merge.service

    # Enable Nginx install on first boot (user service)
    - path: /var/home/${HOST_USER}/.config/systemd/user/default.target.wants/install-nginx.service
      target: /var/home/${HOST_USER}/.config/systemd/user/install-nginx.service
      user:
        name: ${HOST_USER}
      group:
        name: ${HOST_USER}

    # Enable restore-usb-boot on first boot
    - path: /etc/systemd/system/multi-user.target.wants/restore-usb-boot.service
      target: /etc/systemd/system/restore-usb-boot.service
EOF

# --- Dependency check ---
# All tools required to build the Ignition ISO
declare -A DEPS=(
  [butane]="Transpile Butane YAML to Ignition JSON"
  [openssl]="Hash passwords (passwd -6)"
  [coreos-installer]="Download ISO and embed Ignition"
  [envsubst]="Render template variables"
  [ssh-keygen]="Generate SSH keypair for ServiceBay"
)

MISSING=()
for cmd in "${!DEPS[@]}"; do
  # Also check ~/.cargo/bin for cargo-installed tools (e.g. coreos-installer)
  if ! command -v "$cmd" >/dev/null 2>&1 && ! [[ -x "$HOME/.cargo/bin/$cmd" ]]; then
    MISSING+=("$cmd")
  fi
done

# Ensure ~/.cargo/bin is in PATH for this session if it exists
if [[ -d "$HOME/.cargo/bin" ]] && [[ ":$PATH:" != *":$HOME/.cargo/bin:"* ]]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo ""
  echo "========== Missing Dependencies =========="
  for cmd in "${MISSING[@]}"; do
    echo "  - $cmd  (${DEPS[$cmd]})"
  done
  echo "==========================================="
  echo ""

  # Detect package manager and map commands to packages
  install_packages() {
    local pkgs=()
    for cmd in "${MISSING[@]}"; do
      case "$cmd" in
        butane)
          # butane is not in standard repos, install from GitHub
          echo "Installing butane from GitHub releases..."
          local arch
          arch=$(uname -m)
          [[ "$arch" == "x86_64" ]] && arch="x86_64" || arch="aarch64"
          local url="https://github.com/coreos/butane/releases/latest/download/butane-${arch}-unknown-linux-gnu"
          if command -v curl >/dev/null 2>&1; then
            sudo curl -sSL -o /usr/local/bin/butane "$url"
          elif command -v wget >/dev/null 2>&1; then
            sudo wget -qO /usr/local/bin/butane "$url"
          else
            echo "ERROR: neither curl nor wget available to download butane" >&2
            return 1
          fi
          sudo chmod +x /usr/local/bin/butane
          echo "  butane installed to /usr/local/bin/butane"
          ;;
        coreos-installer)
          # coreos-installer has no standalone binary; use distro package or cargo
          if command -v dnf >/dev/null 2>&1; then
            echo "Installing coreos-installer via dnf..."
            sudo dnf install -y -q coreos-installer
          elif command -v apt-get >/dev/null 2>&1; then
            echo "Installing coreos-installer via cargo (no apt package available)..."
            # Ensure build tools and SSL headers are present
            sudo apt-get update -qq && sudo apt-get install -y -qq build-essential pkg-config libssl-dev zlib1g-dev libzstd-dev
            if ! command -v cargo >/dev/null 2>&1; then
              echo "Installing Rust toolchain first..."
              curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
              # shellcheck disable=SC1091
              source "$HOME/.cargo/env"
            fi
            cargo install coreos-installer
          elif command -v pacman >/dev/null 2>&1; then
            echo "Installing coreos-installer via cargo..."
            if ! command -v cargo >/dev/null 2>&1; then
              sudo pacman -S --noconfirm rust
            fi
            sudo pacman -S --noconfirm base-devel openssl pkg-config
            cargo install coreos-installer
          else
            echo "ERROR: cannot auto-install coreos-installer on this distro." >&2
            echo "Install manually: cargo install coreos-installer" >&2
            echo "  or: sudo dnf install coreos-installer (Fedora)" >&2
            return 1
          fi
          echo "  coreos-installer installed"
          ;;
        openssl)   pkgs+=("openssl") ;;
        envsubst)  pkgs+=("gettext") ;;
        ssh-keygen) pkgs+=("openssh-client" "openssh") ;;  # Debian/Ubuntu vs Fedora/RHEL
      esac
    done

    if [[ ${#pkgs[@]} -gt 0 ]]; then
      if command -v apt-get >/dev/null 2>&1; then
        # Debian/Ubuntu: openssh is called openssh-client
        local apt_pkgs=()
        for p in "${pkgs[@]}"; do
          [[ "$p" == "openssh" ]] && continue  # skip Fedora name
          apt_pkgs+=("$p")
        done
        echo "Installing via apt: ${apt_pkgs[*]}"
        sudo apt-get update -qq && sudo apt-get install -y -qq "${apt_pkgs[@]}"
      elif command -v dnf >/dev/null 2>&1; then
        # Fedora/RHEL: openssh-client is called openssh-clients, gettext is gettext
        local dnf_pkgs=()
        for p in "${pkgs[@]}"; do
          case "$p" in
            openssh-client) dnf_pkgs+=("openssh-clients") ;;
            *) dnf_pkgs+=("$p") ;;
          esac
        done
        echo "Installing via dnf: ${dnf_pkgs[*]}"
        sudo dnf install -y -q "${dnf_pkgs[@]}"
      elif command -v pacman >/dev/null 2>&1; then
        local pac_pkgs=()
        for p in "${pkgs[@]}"; do
          case "$p" in
            openssh-client|openssh) pac_pkgs+=("openssh") ;;
            *) pac_pkgs+=("$p") ;;
          esac
        done
        echo "Installing via pacman: ${pac_pkgs[*]}"
        sudo pacman -S --noconfirm "${pac_pkgs[@]}"
      else
        echo "ERROR: no supported package manager found (apt-get, dnf, pacman)" >&2
        echo "Please install manually: ${pkgs[*]}" >&2
        return 1
      fi
    fi
  }

  echo "Installing missing dependencies automatically..."
  DO_INSTALL=Y
  if [[ "${DO_INSTALL^^}" =~ ^Y ]]; then
    install_packages
    # Verify all dependencies are now available
    STILL_MISSING=()
    for cmd in "${MISSING[@]}"; do
      if ! command -v "$cmd" >/dev/null 2>&1; then
        STILL_MISSING+=("$cmd")
      fi
    done
    if [[ ${#STILL_MISSING[@]} -gt 0 ]]; then
      echo ""
      echo "ERROR: still missing after install: ${STILL_MISSING[*]}" >&2
      exit 1
    fi
    echo ""
    echo "All dependencies installed successfully."
  else
    echo ""
    echo "Cannot continue without: ${MISSING[*]}" >&2
    exit 1
  fi
fi

SETTINGS_FILE="$BUILD_DIR/install-settings.env"

prompt() {
  local var_name="$1"; shift
  local prompt_text="$1"; shift
  local default_value="$1"; shift
  local value
  read -r -p "$prompt_text [$default_value]: " value || true
  if [[ -z "$value" ]]; then
    value="$default_value"
  fi
  printf -v "$var_name" '%s' "$value"
}

prompt_secret() {
  local var_name="$1"; shift
  local prompt_text="$1"; shift
  local value value_confirm
  while true; do
    read -r -s -p "$prompt_text: " value || true
    echo
    read -r -s -p "Confirm: " value_confirm || true
    echo
    if [[ "$value" != "$value_confirm" || -z "$value" ]]; then
      echo "Passwords do not match or are empty. Try again." >&2
      continue
    fi
    # Reject characters that survive envsubst into the Butane template +
    # the manually-quoted JSON build. \n breaks systemd Environment= lines
    # (and YAML); " and \ break JSON; ${ would re-trigger envsubst.
    if [[ "$value" == *$'\n'* || "$value" == *'"'* || "$value" == *'\'* || "$value" == *'$'* || "$value" == *'`'* ]]; then
      echo "Password contains characters that break the install pipeline (newline, quote, backslash, \$ or backtick). Pick a different one." >&2
      continue
    fi
    printf -v "$var_name" '%s' "$value"
    return
  done
}

# Prompt for an *optional* secret. No "Confirm:" pass — the operator
# is pasting a value they already generated locally (e.g. via
# `openssl rand -hex 32`) and they keep the cleartext on their side.
# Empty input means "skip" — the calling code treats that as "no
# bootstrap token, MCP-during-install disabled".
prompt_optional_secret() {
  local var_name="$1"; shift
  local prompt_text="$1"; shift
  local value
  read -r -s -p "$prompt_text: " value || true
  echo
  printf -v "$var_name" '%s' "$value"
}

# --- Load / save settings ---
load_setting() {
  local key="$1"
  if [[ -f "$SETTINGS_FILE" ]]; then
    grep -oP "^${key}=\K.*" "$SETTINGS_FILE" 2>/dev/null || echo ""
  else
    echo ""
  fi
}

# Single source of truth for non-secret install settings that get
# persisted between runs. Add a new variable: append it here once and
# the saved-settings round-trip (load + save + future-run defaults)
# picks it up. Remove a variable: drop it here and old values stop
# being read on the next run — no migration needed.
#
# Secrets (passwords, API keys, the bootstrap MCP token) are NEVER
# saved — they're prompted fresh on every run. They're listed in the
# prompt blocks below, not here.
PERSISTED_SETTINGS=(
  SERVER_NAME
  HOST_USER
  SSH_AUTHORIZED_KEY
  NET_INTERFACE
  STATIC_IP
  STATIC_PREFIX
  GATEWAY
  DNS_SERVERS
  SERVICEBAY_PORT
  SERVICEBAY_CHANNEL
  SERVICEBAY_ADMIN_USER
  PUBLIC_DOMAIN
  GW_HOST
  GW_USER
  ENABLE_REGISTRIES
  ENABLE_EMAIL
  EMAIL_HOST
  EMAIL_PORT
  EMAIL_SECURE
  EMAIL_USER
  EMAIL_FROM
  EMAIL_RECIPIENTS
  AUTH_SECRET
)

save_settings() {
  : > "$SETTINGS_FILE"
  for key in "${PERSISTED_SETTINGS[@]}"; do
    # Indirect expansion: ${!key} reads the variable named in $key.
    # `:-` collapses unset/empty to empty rather than printing
    # `KEY=` with a literal dash.
    printf '%s=%s\n' "$key" "${!key:-}" >> "$SETTINGS_FILE"
  done
  echo "Settings saved to $SETTINGS_FILE"
}

USE_SAVED=false

if [[ -f "$SETTINGS_FILE" ]]; then
  echo ""
  echo "========== Saved Settings =========="
  echo "  Server name:      $(load_setting SERVER_NAME)"
  echo "  Host user:        $(load_setting HOST_USER)"
  echo "  SSH key:          $(load_setting SSH_AUTHORIZED_KEY | cut -c1-60)..."
  echo "  Network:          $(load_setting STATIC_IP)/$(load_setting STATIC_PREFIX) via $(load_setting NET_INTERFACE)"
  echo "  Gateway (router):  $(load_setting GATEWAY)"
  echo "  DNS:              $(load_setting DNS_SERVERS)"
  echo "  ServiceBay port:  $(load_setting SERVICEBAY_PORT)"
  echo "  ServiceBay channel: $(load_setting SERVICEBAY_CHANNEL)"
  echo "  Admin user:       $(load_setting SERVICEBAY_ADMIN_USER)"
  _GW_USER="$(load_setting GW_USER)"
  if [[ -n "$_GW_USER" ]]; then
    echo "  FRITZ!Box:        $_GW_USER@$(load_setting GW_HOST)"
  else
    echo "  FRITZ!Box:        (not configured)"
  fi
  echo "  Registries:       $(load_setting ENABLE_REGISTRIES)"
  _EMAIL="$(load_setting ENABLE_EMAIL)"
  if [[ "${_EMAIL^^}" =~ ^Y ]]; then
    echo "  Email:            $(load_setting EMAIL_USER) via $(load_setting EMAIL_HOST):$(load_setting EMAIL_PORT)"
    echo "  Email from:       $(load_setting EMAIL_FROM)"
    echo "  Email to:         $(load_setting EMAIL_RECIPIENTS)"
  else
    echo "  Email:            (not configured)"
  fi
  echo "===================================="
  echo ""
  read -r -p "Accept these settings? (passwords + the optional MCP bootstrap token will still be prompted) [Y/n]: " ACCEPT_SAVED
  ACCEPT_SAVED=${ACCEPT_SAVED:-Y}
  if [[ "${ACCEPT_SAVED^^}" =~ ^Y ]]; then
    USE_SAVED=true
  fi
fi

if $USE_SAVED; then
  # Load all non-secret values from saved settings — iterates the
  # PERSISTED_SETTINGS schema so adding/removing a variable means
  # touching one place. Variables present in the file but no longer
  # in the schema are silently dropped on the next save.
  for key in "${PERSISTED_SETTINGS[@]}"; do
    printf -v "$key" '%s' "$(load_setting "$key")"
  done

  case "$SERVICEBAY_CHANNEL" in
    test) SERVICEBAY_VERSION="test" ;;
    dev)  SERVICEBAY_VERSION="dev" ;;
    *)    SERVICEBAY_VERSION="latest" ;;
  esac

  DATA_ROOT="/mnt/data"

  # Find ISO
  DEFAULT_ISO="$(ls -1t "$SCRIPT_DIR"/*.iso "$SCRIPT_DIR"/build/*.iso "$BUILD_DIR"/*.iso 2>/dev/null | grep -v 'fedora-coreos-custom\.iso' | head -1 || echo '')"
  if [[ -z "$DEFAULT_ISO" ]]; then
    echo "No Fedora CoreOS ISO found locally."
    read -r -p "Download the latest stable ISO now? [Y/n]: " DO_DOWNLOAD
    DO_DOWNLOAD=${DO_DOWNLOAD:-Y}
    if [[ "${DO_DOWNLOAD^^}" != "N" ]]; then
      echo "Downloading Fedora CoreOS stable ISO (this may take a few minutes)..."
      ( cd "$BUILD_DIR" && coreos-installer download -s stable -p metal -f iso -C . )
      DEFAULT_ISO="$(ls -1t "$BUILD_DIR"/*.iso 2>/dev/null | head -1 || echo '')"
      if [[ -z "$DEFAULT_ISO" ]]; then
        echo "ERROR: Download failed." >&2
        exit 1
      fi
      echo "Downloaded: $DEFAULT_ISO"
    fi
  fi
  prompt ISO_PATH "Path to Fedora CoreOS ISO" "$DEFAULT_ISO"

  # Prompt only for passwords
  echo ""
  prompt_secret SERVICEBAY_ADMIN_PASSWORD "ServiceBay admin password"
  prompt_secret HOST_PASSWORD "Host user console password (will be hashed)"
  if [[ -n "$GW_USER" ]]; then
    prompt_secret GW_PASS "Gateway password ($GW_USER@$GW_HOST)"
  else
    GW_PASS=""
  fi
  if [[ "${ENABLE_EMAIL^^}" =~ ^Y ]]; then
    prompt_secret EMAIL_PASS "SMTP password ($EMAIL_USER)"
  fi

  # Bootstrap MCP token (#322): optional, LAN-only, read-only,
  # 30 minutes of usable life from first server boot. If the operator
  # leaves it empty we don't write anything — they'll mint MCP tokens
  # via the dashboard later. To enable: paste a token they generated
  # locally (e.g. `openssl rand -hex 32`) — the script SHA-256s it
  # before writing into config.json so the cleartext never leaves the
  # operator's terminal.
  echo ""
  echo "Optional: MCP bootstrap token for install-time diagnostics."
  echo "  - Generate locally with: openssl rand -hex 32"
  echo "  - Read-only, LAN-only, 30 minutes from first boot."
  echo "  - Press Enter to skip (you can mint MCP tokens later via the dashboard)."
  prompt_optional_secret SERVICEBAY_BOOTSTRAP_TOKEN "Paste bootstrap token (or Enter to skip)"

  # Backup restore (also available in saved-settings mode)
  echo ""
  read -r -p "Include a ServiceBay backup for restore? [N]: " INCLUDE_BACKUP
  INCLUDE_BACKUP=${INCLUDE_BACKUP:-N}
  if [[ "${INCLUDE_BACKUP^^}" =~ ^Y ]]; then
    prompt BACKUP_FILE "Path to ServiceBay backup (.tar.gz)" ""
  else
    BACKUP_FILE=""
  fi

else
  # --- Full interactive prompts ---

  prev() {
    local key="$1" fallback="$2"
    local val
    val=$(load_setting "$key")
    if [[ -n "$val" ]]; then echo "$val"; else echo "$fallback"; fi
  }

  # --- Server Identity ---

  while true; do
    prompt SERVER_NAME "Server name (hostname)" "$(prev SERVER_NAME "servicebay")"
    # Validate: RFC 952/1123 hostname — lowercase alphanumeric and hyphens, 1-63 chars,
    # must start with a letter, must not end with a hyphen.
    if [[ "$SERVER_NAME" =~ ^[a-z][a-z0-9-]{0,61}[a-z0-9]$ ]] || [[ "$SERVER_NAME" =~ ^[a-z]$ ]]; then
      break
    fi
    echo "  Invalid hostname. Rules: 1-63 chars, lowercase letters/digits/hyphens,"
    echo "  must start with a letter, must not end with a hyphen."
  done

  # --- User & Auth ---

  prompt HOST_USER "Host username" "$(prev HOST_USER "core")"

  DEFAULT_SSH_KEY="$(cat ~/.ssh/id_ed25519.pub 2>/dev/null || cat ~/.ssh/id_rsa.pub 2>/dev/null || echo '')"
  prompt SSH_AUTHORIZED_KEY "SSH public key (for $HOST_USER)" "$(prev SSH_AUTHORIZED_KEY "${DEFAULT_SSH_KEY:-ssh-ed25519 YOUR_KEY_HERE}")"

  # --- Network ---

  prompt NET_INTERFACE "Network interface" "$(prev NET_INTERFACE "eno1")"
  prompt STATIC_IP "Static IPv4" "$(prev STATIC_IP "192.168.178.99")"
  prompt STATIC_PREFIX "IPv4 prefix length" "$(prev STATIC_PREFIX "24")"
  prompt GATEWAY "Gateway" "$(prev GATEWAY "192.168.178.1")"
  prompt DNS_SERVERS "DNS servers (semicolon separated)" "$(prev DNS_SERVERS "192.168.178.1;8.8.8.8")"

  # --- Storage (hardwired to RAID mount) ---

  DATA_ROOT="/mnt/data"

  # --- ISO ---

  echo ""
  DEFAULT_ISO="$(ls -1t "$SCRIPT_DIR"/*.iso "$SCRIPT_DIR"/build/*.iso "$BUILD_DIR"/*.iso 2>/dev/null | grep -v 'fedora-coreos-custom\.iso' | head -1 || echo '')"

  if [[ -z "$DEFAULT_ISO" ]]; then
    echo "No Fedora CoreOS ISO found locally."
    read -r -p "Download the latest stable ISO now? [Y/n]: " DO_DOWNLOAD
    DO_DOWNLOAD=${DO_DOWNLOAD:-Y}
    if [[ "${DO_DOWNLOAD^^}" != "N" ]]; then
      echo "Downloading Fedora CoreOS stable ISO (this may take a few minutes)..."
      ( cd "$BUILD_DIR" && coreos-installer download -s stable -p metal -f iso -C . )
      DEFAULT_ISO="$(ls -1t "$BUILD_DIR"/*.iso 2>/dev/null | head -1 || echo '')"
      if [[ -z "$DEFAULT_ISO" ]]; then
        echo "ERROR: Download failed." >&2
        exit 1
      fi
      echo "Downloaded: $DEFAULT_ISO"
    fi
  fi

  prompt ISO_PATH "Path to Fedora CoreOS ISO" "$DEFAULT_ISO"

  # --- ServiceBay ---

  prompt SERVICEBAY_PORT "ServiceBay port" "$(prev SERVICEBAY_PORT "5888")"

  PREV_CHANNEL="$(prev SERVICEBAY_CHANNEL "")"
  case "$PREV_CHANNEL" in
    test)   DEFAULT_CHANNEL_OPT=2 ;;
    dev)    DEFAULT_CHANNEL_OPT=3 ;;
    *)      DEFAULT_CHANNEL_OPT=1 ;;
  esac

  echo "Select ServiceBay Channel:"
  echo "  1) Stable (latest)"
  echo "  2) Test   (test)"
  echo "  3) Dev    (dev)"
  read -r -p "Select channel [$DEFAULT_CHANNEL_OPT]: " CHANNEL_OPT
  CHANNEL_OPT=${CHANNEL_OPT:-$DEFAULT_CHANNEL_OPT}
  case $CHANNEL_OPT in
      2)
          SERVICEBAY_VERSION="test"
          SERVICEBAY_CHANNEL="test"
          ;;
      3)
          SERVICEBAY_VERSION="dev"
          SERVICEBAY_CHANNEL="dev"
          ;;
      *)
          SERVICEBAY_VERSION="latest"
          SERVICEBAY_CHANNEL="stable"
          ;;
  esac

  prompt SERVICEBAY_ADMIN_USER "ServiceBay admin user" "$(prev SERVICEBAY_ADMIN_USER "admin")"
  prompt_secret SERVICEBAY_ADMIN_PASSWORD "ServiceBay admin password"
  prompt_secret HOST_PASSWORD "Host user console password (will be hashed)"

  # --- Public domain (used by Authelia, NPM, all OIDC clients) ---
  echo ""
  prompt PUBLIC_DOMAIN "Public domain (e.g. dopp.cloud) — leave empty to set later in the wizard" "$(prev PUBLIC_DOMAIN "")"

  # --- Gateway (FRITZ!Box) ---

  echo ""
  echo "--- Internet Gateway (FRITZ!Box) ---"
  prompt GW_HOST "Gateway hostname" "$(prev GW_HOST "fritz.box")"
  prompt GW_USER "Gateway username (leave empty to skip)" "$(prev GW_USER "")"
  if [[ -n "$GW_USER" ]]; then
    prompt_secret GW_PASS "Gateway password"
  else
    GW_PASS=""
  fi

  # --- Template Registries ---

  echo ""
  PREV_REG="$(prev ENABLE_REGISTRIES "Y")"
  read -r -p "Enable default template registry (servicebay-templates)? [${PREV_REG}]: " ENABLE_REGISTRIES
  ENABLE_REGISTRIES=${ENABLE_REGISTRIES:-$PREV_REG}

  # --- Email Notifications ---

  echo ""
  echo "--- Email Notifications ---"
  PREV_EMAIL_ENABLED="$(prev ENABLE_EMAIL "N")"
  read -r -p "Configure email notifications? [${PREV_EMAIL_ENABLED}]: " ENABLE_EMAIL
  ENABLE_EMAIL=${ENABLE_EMAIL:-$PREV_EMAIL_ENABLED}

  if [[ "${ENABLE_EMAIL^^}" =~ ^Y ]]; then
    prompt EMAIL_HOST "SMTP host" "$(prev EMAIL_HOST "smtp.gmail.com")"
    prompt EMAIL_PORT "SMTP port" "$(prev EMAIL_PORT "587")"
    PREV_EMAIL_SECURE="$(prev EMAIL_SECURE "N")"
    read -r -p "Use SSL/TLS? [${PREV_EMAIL_SECURE}]: " EMAIL_SECURE
    EMAIL_SECURE=${EMAIL_SECURE:-$PREV_EMAIL_SECURE}
    prompt EMAIL_USER "SMTP username" "$(prev EMAIL_USER "")"
    prompt_secret EMAIL_PASS "SMTP password"
    prompt EMAIL_FROM "From address" "$(prev EMAIL_FROM "")"
    prompt EMAIL_RECIPIENTS "Recipients (comma separated)" "$(prev EMAIL_RECIPIENTS "")"
  fi

  # --- Backup Restore ---

  echo ""
  echo "--- Restore from Backup ---"
  echo "If you have a ServiceBay backup (.tar.gz), it will be placed on the"
  echo "data volume. After first boot, use Settings > Backups > Restore to"
  echo "cherry-pick what to restore (services, configs, nginx, monitoring)."
  read -r -p "Include a backup file for restore? [N]: " INCLUDE_BACKUP
  INCLUDE_BACKUP=${INCLUDE_BACKUP:-N}
  if [[ "${INCLUDE_BACKUP^^}" =~ ^Y ]]; then
    prompt BACKUP_FILE "Path to ServiceBay backup (.tar.gz)" ""
  else
    BACKUP_FILE=""
  fi

  # Bootstrap MCP token (#322) — same prompt as the saved-settings
  # branch above, repeated here for the full-interactive path.
  echo ""
  echo "Optional: MCP bootstrap token for install-time diagnostics."
  echo "  - Generate locally with: openssl rand -hex 32"
  echo "  - Read-only, LAN-only, 30 minutes from first boot."
  echo "  - Press Enter to skip (you can mint MCP tokens later via the dashboard)."
  prompt_optional_secret SERVICEBAY_BOOTSTRAP_TOKEN "Paste bootstrap token (or Enter to skip)"
fi

# --- Save settings for next run ---
save_settings

PASSWORD_HASH="$(printf '%s' "$HOST_PASSWORD" | openssl passwd -6 -stdin)"

# Hash the optional bootstrap token (#322). The cleartext stays on the
# operator's box — only the SHA-256 hex hash lands in config.json. We
# don't echo or save the cleartext anywhere.
SERVICEBAY_BOOTSTRAP_TOKEN_HASH=""
if [[ -n "${SERVICEBAY_BOOTSTRAP_TOKEN:-}" ]]; then
  SERVICEBAY_BOOTSTRAP_TOKEN_HASH="$(printf '%s' "$SERVICEBAY_BOOTSTRAP_TOKEN" | openssl dgst -sha256 -hex | awk '{print $NF}')"
  unset SERVICEBAY_BOOTSTRAP_TOKEN  # don't keep cleartext in env
fi

# Properly escape arbitrary strings as JSON literals — prevents user-supplied
# values (passwords, hostnames, email addresses) from breaking the JSON or
# injecting attacker-chosen keys into config.json. Python3 is a hard dep on
# Fedora CoreOS targets and we already require it on the build host elsewhere.
json_str() {
  python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1"
}

# Build the auth block. If the operator pasted a bootstrap token, the
# SHA-256 hash + scope='read' are inlined — the server reads it on
# first boot, lazy-initializes expiresAt to first-boot + 30 min, then
# uses it to authenticate LAN-only read-scope MCP requests until the
# operator mints their first dashboard token. See #322.
AUTH_BLOCK='"username": '"$(json_str "$SERVICEBAY_ADMIN_USER")"
if [[ -n "${SERVICEBAY_BOOTSTRAP_TOKEN_HASH:-}" ]]; then
  AUTH_BLOCK+=',
    "bootstrapToken": {
      "hash": '"$(json_str "$SERVICEBAY_BOOTSTRAP_TOKEN_HASH")"',
      "scope": "read"
    }'
fi

# Build ServiceBay config.json (with optional sections)
SERVICEBAY_CONFIG='{
  "serverName": '"$(json_str "$SERVER_NAME")"',
  "auth": {
    '"$AUTH_BLOCK"'
  },
  "autoUpdate": {
    "enabled": true,
    "schedule": "0 0 * * *"
  },
  "templateSettings": {
    "DATA_DIR": '"$(json_str "$DATA_ROOT/stacks")"'
  }'

# Add reverseProxy.publicDomain if user supplied one — wizard reads this
# as the default for PUBLIC_DOMAIN so they don't have to type it again.
# Default-empty in case an older saved-settings file pre-dates this field.
if [[ -n "${PUBLIC_DOMAIN:-}" ]]; then
  SERVICEBAY_CONFIG+=',
  "reverseProxy": {
    "publicDomain": '"$(json_str "$PUBLIC_DOMAIN")"'
  }'
fi

# Add gateway config if provided
if [[ -n "$GW_USER" ]]; then
  SERVICEBAY_CONFIG+=',
  "gateway": {
    "type": "fritzbox",
    "host": '"$(json_str "$GW_HOST")"',
    "username": '"$(json_str "$GW_USER")"',
    "password": '"$(json_str "$GW_PASS")"'
  }'
fi

# Add registries config if enabled
if [[ "${ENABLE_REGISTRIES^^}" =~ ^Y ]]; then
  SERVICEBAY_CONFIG+=',
  "registries": {
    "enabled": true,
    "items": [
      {
        "name": "ServiceBay Templates",
        "url": "https://github.com/mdopp/servicebay-templates"
      }
    ]
  }'
fi

# Add email notifications config if enabled
if [[ "${ENABLE_EMAIL^^}" =~ ^Y ]]; then
  # Build JSON array of recipients via python — sed-based escaping was
  # broken on addresses containing quotes.
  EMAIL_TO_JSON="$(python3 -c 'import json,sys; print(json.dumps([s.strip() for s in sys.argv[1].split(",") if s.strip()]))' "$EMAIL_RECIPIENTS")"
  EMAIL_SECURE_BOOL="false"
  [[ "${EMAIL_SECURE^^}" =~ ^Y ]] && EMAIL_SECURE_BOOL="true"
  SERVICEBAY_CONFIG+=',
  "notifications": {
    "email": {
      "enabled": true,
      "host": '"$(json_str "$EMAIL_HOST")"',
      "port": '"$EMAIL_PORT"',
      "secure": '"$EMAIL_SECURE_BOOL"',
      "user": '"$(json_str "$EMAIL_USER")"',
      "pass": '"$(json_str "$EMAIL_PASS")"',
      "from": '"$(json_str "$EMAIL_FROM")"',
      "to": '"$EMAIL_TO_JSON"'
    }
  }'
fi

SERVICEBAY_CONFIG+=',
  "setupCompleted": true,
  "stackSetupPending": true
}'

# Indent config for YAML inline block (10 spaces)
SERVICEBAY_CONFIG_JSON="$(echo "$SERVICEBAY_CONFIG" | sed 's/^/          /')"

# Generate SSH keypair for ServiceBay container -> host communication.
# This key is baked into the Ignition so ServiceBay can SSH to the host without ssh-copy-id
# (CoreOS disables password auth, so ssh-copy-id cannot work).
SERVICEBAY_SSH_DIR="$BUILD_DIR/servicebay-ssh"
mkdir -p "$SERVICEBAY_SSH_DIR"
if [[ ! -f "$SERVICEBAY_SSH_DIR/id_rsa" ]]; then
  ssh-keygen -t rsa -b 4096 -f "$SERVICEBAY_SSH_DIR/id_rsa" -N "" -q
  chmod 600 "$SERVICEBAY_SSH_DIR/id_rsa"
  echo "Generated ServiceBay SSH keypair"
fi
SERVICEBAY_SSH_PUB="$(cat "$SERVICEBAY_SSH_DIR/id_rsa.pub")"
# Indent private key for YAML inline block (10 spaces to match Butane template nesting)
SERVICEBAY_SSH_PRIV="$(sed 's/^/          /' "$SERVICEBAY_SSH_DIR/id_rsa")"

# AUTH_SECRET: required by the ServiceBay backend (≥32 bytes). Reuse a
# previously-generated value across re-runs so an existing FCOS install's
# encrypted config.json fields still decrypt; otherwise generate fresh.
AUTH_SECRET="$(load_setting AUTH_SECRET)"
if [[ -z "$AUTH_SECRET" || ${#AUTH_SECRET} -lt 32 ]]; then
  AUTH_SECRET="$(openssl rand -hex 32)"
fi

export SERVER_NAME HOST_USER SSH_AUTHORIZED_KEY PASSWORD_HASH NET_INTERFACE STATIC_IP STATIC_PREFIX GATEWAY DNS_SERVERS \
       DATA_ROOT SERVICEBAY_PORT SERVICEBAY_VERSION SERVICEBAY_CONFIG_JSON SERVICEBAY_SSH_PUB SERVICEBAY_SSH_PRIV \
       AUTH_SECRET SERVICEBAY_ADMIN_USER SERVICEBAY_ADMIN_PASSWORD

# Render Butane template (only substitute explicit template variables, not shell vars in embedded scripts)
envsubst '${SERVER_NAME} ${HOST_USER} ${SSH_AUTHORIZED_KEY} ${PASSWORD_HASH} ${NET_INTERFACE} ${STATIC_IP} ${STATIC_PREFIX} ${GATEWAY} ${DNS_SERVERS} ${DATA_ROOT} ${SERVICEBAY_PORT} ${SERVICEBAY_VERSION} ${SERVICEBAY_CONFIG_JSON} ${SERVICEBAY_SSH_PUB} ${SERVICEBAY_SSH_PRIV} ${AUTH_SECRET} ${SERVICEBAY_ADMIN_USER} ${SERVICEBAY_ADMIN_PASSWORD}' < "$TEMPLATE" > "$RENDERED_BU"

# --- Stage backup file for post-install restore ---
BACKUP_STAGED=""
if [[ -n "${BACKUP_FILE:-}" && -f "$BACKUP_FILE" ]]; then
  BACKUP_BASENAME="$(basename "$BACKUP_FILE")"
  cp "$BACKUP_FILE" "$BUILD_DIR/$BACKUP_BASENAME"
  BACKUP_STAGED="$BACKUP_BASENAME"
  echo "Staged backup: $BACKUP_BASENAME ($(du -h "$BACKUP_FILE" | cut -f1))"
fi

# Transpile to Ignition
butane --pretty --strict "$RENDERED_BU" > "$IGNITION_OUT"

echo ""
echo "Generated files:"
echo "  - $RENDERED_BU"
echo "  - $IGNITION_OUT"

# --- Bake Ignition into ISO ---

if [[ -z "$ISO_PATH" ]]; then
  echo ""
  echo "No ISO path provided. You can manually embed the Ignition config later:"
  echo "  coreos-installer iso customize \\"
  echo "    --dest-ignition $IGNITION_OUT \\"
  echo "    --pre-install /path/to/auto-select-disk.sh \\"
  echo "    /path/to/fedora-coreos.iso"
  exit 0
fi

if [[ ! -f "$ISO_PATH" ]]; then
  echo "ISO not found: $ISO_PATH" >&2
  exit 1
fi

# Create pre-install script that auto-selects the smallest non-USB disk as OS target.
# This runs in the live environment before coreos-installer writes to disk.
PRE_INSTALL="$BUILD_DIR/pre-install.sh"
cat > "$PRE_INSTALL" <<PREINST_HEADER
#!/usr/bin/env bash
set -euo pipefail

# Set hostname in live environment so the DHCP lease registers the correct name
# (routers like FritzBox learn the hostname from DHCP and cache it)
hostnamectl set-hostname "$SERVER_NAME" 2>/dev/null || hostname "$SERVER_NAME"

PREINST_HEADER
cat >> "$PRE_INSTALL" <<'PREINST'
# Find the smallest non-removable disk (that's not the live USB) for OS install.
# The live USB is the device backing /run/media or the ISO boot.
LIVE_DISK=$(lsblk -ndo PKNAME "$(findmnt -n -o SOURCE /run)" 2>/dev/null || echo "")

BEST=""
BEST_SIZE=0

for dev in $(lsblk -dnpo NAME -I 8,259,254); do
  name=$(basename "$dev")
  # Skip live USB
  [[ "$name" == "$LIVE_DISK" ]] && continue
  # Skip removable
  [[ "$(cat /sys/block/${name}/removable 2>/dev/null)" == "1" ]] && continue
  size=$(blockdev --getsize64 "$dev" 2>/dev/null || echo 0)
  (( size == 0 )) && continue
  # Pick smallest
  if [[ -z "$BEST" ]] || (( size < BEST_SIZE )); then
    BEST_SIZE=$size
    BEST=$dev
  fi
done

if [[ -z "$BEST" ]]; then
  echo "pre-install: ERROR: no suitable OS disk found" >&2
  exit 1
fi

echo "pre-install: selected $BEST ($(( BEST_SIZE / 1073741824 )) GiB) as OS disk"

# Write dest-device into installer.d so coreos-installer picks it up
mkdir -p /etc/coreos/installer.d
cat > /etc/coreos/installer.d/0050-dest-device.yaml <<DISKEOF
dest-device: $BEST
DISKEOF
PREINST

chmod +x "$PRE_INSTALL"

# Create post-install script that sets the installed OS disk as first boot device.
# This prevents the BIOS from booting the USB again and causing an install loop.
POST_INSTALL="$BUILD_DIR/post-install.sh"
cat > "$POST_INSTALL" <<'POSTINST'
#!/usr/bin/env bash
set -euo pipefail
# After install: set the installed OS disk as first boot so we don't loop
ENTRY=$(efibootmgr | grep -i -m1 'fedora\|coreos\|Linux Boot Manager' | grep -oP 'Boot\K[0-9A-Fa-f]+')
if [[ -n "$ENTRY" ]]; then
  CURRENT=$(efibootmgr | grep -oP 'BootOrder: \K.*')
  NEW="$ENTRY,$(echo "$CURRENT" | sed "s/$ENTRY,\?//;s/,$//")"
  efibootmgr -o "$NEW"
  echo "post-install: boot order set to $NEW (disk first)"
else
  echo "post-install: no OS boot entry found, boot order unchanged"
fi
POSTINST

chmod +x "$POST_INSTALL"

CUSTOM_ISO="$BUILD_DIR/fedora-coreos-custom.iso"
rm -f "$CUSTOM_ISO"
cp "$ISO_PATH" "$CUSTOM_ISO"

echo ""
echo "Baking Ignition into ISO..."
( cd "$BUILD_DIR" && coreos-installer iso customize \
  --dest-ignition "$(basename "$IGNITION_OUT")" \
  --pre-install "$(basename "$PRE_INSTALL")" \
  --post-install "$(basename "$POST_INSTALL")" \
  "$(basename "$CUSTOM_ISO")" )

# Patch GRUB menu entry in the ISO to show ServiceBay branding
# The text is stored as plain strings inside the ISO image and can be replaced in-place
# as long as the replacement is the same length or shorter (padded with spaces).
patch_iso_label() {
  local iso="$1" old="$2" new="$3"
  local pad_len=$(( ${#old} - ${#new} ))
  if (( pad_len < 0 )); then
    echo "Warning: label '$new' is longer than '$old', skipping patch" >&2
    return
  fi
  local padded
  padded="$(printf '%-*s' "${#old}" "$new")"
  LC_ALL=C sed -i "s|$old|$padded|g" "$iso"
}

patch_iso_label "$CUSTOM_ISO" "Fedora CoreOS (Live)" "ServiceBay Installer"

echo ""
echo "Done! Ready-to-boot ISO:"
echo "  $CUSTOM_ISO"
echo ""

# --- Write to USB ---

# Find removable USB drives. Read size from sysfs (world-readable) rather
# than `blockdev`, which needs read on the raw device — denied to regular
# users not in the `disk` group, so the loop would silently report 0 and
# drop genuine USB sticks.
mapfile -t USB_DEVS < <(
  for dev in /sys/block/sd*; do
    [[ -e "$dev/removable" ]] || continue
    [[ "$(cat "$dev/removable" 2>/dev/null)" == "1" ]] || continue
    name=$(basename "$dev")
    sectors=$(cat "$dev/size" 2>/dev/null || echo 0)
    # /sys/block/*/size is always in 512-byte units regardless of physical
    # block size — see Documentation/ABI/stable/sysfs-block.
    size_bytes=$(( sectors * 512 ))
    (( size_bytes > 0 )) || continue
    size_gib=$(( size_bytes / 1073741824 ))
    model=$(cat "$dev/device/model" 2>/dev/null | xargs || echo "Unknown")
    echo "/dev/$name ${size_gib}GiB ${model}"
  done
)

if [[ ${#USB_DEVS[@]} -eq 0 ]]; then
  echo "No USB drives detected. You can write manually with:"
  echo "  sudo dd if=$CUSTOM_ISO of=/dev/sdX bs=4M status=progress oflag=sync"
else
  echo "Available USB drives:"
  for i in "${!USB_DEVS[@]}"; do
    echo "  $((i+1))) ${USB_DEVS[$i]}"
  done
  echo "  0) Skip (don't write to USB)"
  echo ""
  read -r -p "Select drive to write ISO to [0]: " USB_CHOICE
  USB_CHOICE=${USB_CHOICE:-0}

  if [[ "$USB_CHOICE" =~ ^[1-9][0-9]*$ ]] && (( USB_CHOICE <= ${#USB_DEVS[@]} )); then
    USB_TARGET=$(echo "${USB_DEVS[$((USB_CHOICE-1))]}" | awk '{print $1}')
    echo ""
    echo "WARNING: This will ERASE ALL DATA on $USB_TARGET (${USB_DEVS[$((USB_CHOICE-1))]})"
    read -r -p "Are you sure? Type YES to confirm: " CONFIRM_USB
    if [[ "$CONFIRM_USB" == "YES" ]]; then
      echo "Writing ISO to $USB_TARGET..."
      sudo dd if="$CUSTOM_ISO" of="$USB_TARGET" bs=4M status=progress oflag=sync
      echo ""
      echo "Done! USB drive is ready."
    else
      echo "Skipped."
    fi
  fi
fi

echo ""
echo "Boot the target machine from this USB. It will:"
echo "  1. Auto-detect the smallest disk and install CoreOS there"
echo "  2. On first boot, auto-detect the largest disk and create a degraded RAID1"
echo "  3. Mount RAID at $DATA_ROOT, start ServiceBay on port $SERVICEBAY_PORT"
echo ""
if [[ -n "${BACKUP_STAGED:-}" ]]; then
  echo "=== Restore from Backup ==="
  echo "After first boot, copy the backup to the server and restore:"
  echo ""
  echo "  scp $BUILD_DIR/$BACKUP_STAGED ${HOST_USER}@${STATIC_IP}:$DATA_ROOT/servicebay/backups/"
  echo ""
  echo "Then open ServiceBay > Settings > Backups > Restore and cherry-pick"
  echo "which services, configs, and settings to restore."
  echo ""
fi
echo "After install, add the second SSD to the RAID:"
echo "  sudo mdadm --add /dev/md/data /dev/disk/by-partlabel/raid1-ssd2"
