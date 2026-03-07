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

    # Quadlet directory for the user
    - path: /var/home/${HOST_USER}/.config/containers/systemd
      mode: 0755
      user:
        name: ${HOST_USER}
      group:
        name: ${HOST_USER}

  files:
    # Network: Static IP
    - path: /etc/NetworkManager/system-connections/${NET_INTERFACE}.nmconnection
      mode: 0600
      contents:
        inline: |
          [connection]
          id=${NET_INTERFACE}
          type=ethernet
          interface-name=${NET_INTERFACE}
          
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
          OS_DISK=$(lsblk -ndo PKNAME "$(findmnt -n -o SOURCE /)" | head -1)

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

          # Check if RAID is already assembled
          if [[ -e /dev/md/data ]]; then
            echo "setup-raid: /dev/md/data already exists. Skipping creation."
          else
            # Check if the disk (or its partitions) already has a RAID superblock
            EXISTING_RAID=false
            for part in "$RAID_DISK" "${RAID_DISK}1" "${RAID_DISK}p1"; do
              if [[ -e "$part" ]] && mdadm --examine "$part" &>/dev/null; then
                echo "setup-raid: found existing RAID superblock on $part, reassembling"
                mdadm --assemble /dev/md/data "$part" --run
                EXISTING_RAID=true
                break
              fi
            done

            if ! $EXISTING_RAID; then
              echo "setup-raid: no existing RAID found, creating new array"

              # Partition the disk
              wipefs -a "$RAID_DISK"
              parted -s "$RAID_DISK" mklabel gpt mkpart raid1-ssd1 xfs 0% 100%

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
            fi
          fi

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

          # Mount RAID over $MOUNT_POINT
          mkdir -p "$MOUNT_POINT"
          mount /dev/md/data "$MOUNT_POINT"

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
            # Only write config.json if it doesn't exist (preserve user changes)
            if [[ ! -f "$MOUNT_POINT/servicebay/config.json" && -f "$IGNITION_TMP/servicebay/config.json" ]]; then
              cp "$IGNITION_TMP/servicebay/config.json" "$MOUNT_POINT/servicebay/config.json"
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

          # Persist mount via fstab
          grep -q '/dev/md/data' /etc/fstab || \
            echo "/dev/md/data $MOUNT_POINT xfs defaults,nofail 0 2" >> /etc/fstab

          echo "setup-raid: done. RAID1 mounted at $MOUNT_POINT"

    # Systemd unit to run RAID setup on first boot only
    - path: /etc/systemd/system/setup-raid.service
      mode: 0644
      contents:
        inline: |
          [Unit]
          Description=First-boot RAID1 setup (auto-detect largest disk)
          ConditionPathExists=!/var/lib/setup-raid-done
          After=sysinit.target systemd-udevd.service
          Before=local-fs.target

          [Service]
          Type=oneshot
          RemainAfterExit=yes
          ExecStart=/bin/bash /usr/local/bin/setup-raid.sh
          ExecStartPost=/bin/touch /var/lib/setup-raid-done

          [Install]
          WantedBy=local-fs.target

    # User Linger (enables rootless services at boot)
    - path: /var/lib/systemd/linger/${HOST_USER}
      mode: 0644

    # ServiceBay Quadlet (rootless)
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

    # Script to backup Quadlet service definitions to RAID
    - path: /usr/local/bin/backup-quadlets.sh
      mode: 0755
      contents:
        inline: |
          #!/bin/bash
          set -euo pipefail
          QUADLET_DIR="/var/home/${HOST_USER}/.config/containers/systemd"
          BACKUP_DIR="${DATA_ROOT}/servicebay/quadlet-backup"
          if [[ ! -d "$QUADLET_DIR" ]]; then
            exit 0
          fi
          mkdir -p "$BACKUP_DIR"
          # Sync all quadlet files to backup (delete removed ones)
          rsync -a --delete --include='*.kube' --include='*.yml' --include='*.container' --exclude='*' "$QUADLET_DIR/" "$BACKUP_DIR/"
          echo "backup-quadlets: synced to $BACKUP_DIR"

    # Systemd service to backup Quadlet files
    - path: /etc/systemd/system/backup-quadlets.service
      mode: 0644
      contents:
        inline: |
          [Unit]
          Description=Backup Quadlet service definitions to RAID

          [Service]
          Type=oneshot
          ExecStart=/bin/bash /usr/local/bin/backup-quadlets.sh

    # Timer to run Quadlet backup every 5 minutes
    - path: /etc/systemd/system/backup-quadlets.timer
      mode: 0644
      contents:
        inline: |
          [Unit]
          Description=Periodic Quadlet backup to RAID

          [Timer]
          OnBootSec=2min
          OnUnitActiveSec=5min

          [Install]
          WantedBy=timers.target

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
          PORT="${SERVICEBAY_PORT}"
          MAX_WAIT=120
          WAITED=0
          echo "install-nginx: waiting for ServiceBay on port $PORT..."
          while ! curl -sf "http://localhost:$PORT/api/system/nginx/status" >/dev/null 2>&1; do
            sleep 5
            WAITED=$((WAITED + 5))
            if (( WAITED >= MAX_WAIT )); then
              echo "install-nginx: timeout waiting for ServiceBay" >&2
              exit 1
            fi
          done
          echo "install-nginx: ServiceBay is up, installing nginx..."
          curl -sf -X POST "http://localhost:$PORT/api/system/nginx/install"
          echo "install-nginx: done"

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
    # Enable first-boot RAID setup
    - path: /etc/systemd/system/local-fs.target.wants/setup-raid.service
      target: /etc/systemd/system/setup-raid.service

    # Enable Podman Socket for the user (required for ServiceBay to control the host)
    - path: /var/home/${HOST_USER}/.config/systemd/user/sockets.target.wants/podman.socket
      target: /usr/lib/systemd/user/podman.socket
      user:
        name: ${HOST_USER}
      group:
        name: ${HOST_USER}

    # Enable Quadlet backup timer
    - path: /etc/systemd/system/timers.target.wants/backup-quadlets.timer
      target: /etc/systemd/system/backup-quadlets.timer

    # Enable Python3 install on first boot
    - path: /etc/systemd/system/multi-user.target.wants/install-python.service
      target: /etc/systemd/system/install-python.service

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
  if ! command -v "$cmd" >/dev/null 2>&1; then
    MISSING+=("$cmd")
  fi
done

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

  read -r -p "Install missing dependencies now? [Y/n]: " DO_INSTALL
  DO_INSTALL=${DO_INSTALL:-Y}
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
    if [[ "$value" == "$value_confirm" && -n "$value" ]]; then
      printf -v "$var_name" '%s' "$value"
      return
    fi
    echo "Passwords do not match or are empty. Try again." >&2
  done
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

save_settings() {
  cat > "$SETTINGS_FILE" <<SETTINGS
HOST_USER=${HOST_USER}
SSH_AUTHORIZED_KEY=${SSH_AUTHORIZED_KEY}
NET_INTERFACE=${NET_INTERFACE}
STATIC_IP=${STATIC_IP}
STATIC_PREFIX=${STATIC_PREFIX}
GATEWAY=${GATEWAY}
DNS_SERVERS=${DNS_SERVERS}
SERVICEBAY_PORT=${SERVICEBAY_PORT}
SERVICEBAY_CHANNEL=${SERVICEBAY_CHANNEL}
SERVICEBAY_ADMIN_USER=${SERVICEBAY_ADMIN_USER}
GW_HOST=${GW_HOST}
GW_USER=${GW_USER}
ENABLE_REGISTRIES=${ENABLE_REGISTRIES}
ENABLE_EMAIL=${ENABLE_EMAIL:-N}
EMAIL_HOST=${EMAIL_HOST:-}
EMAIL_PORT=${EMAIL_PORT:-587}
EMAIL_SECURE=${EMAIL_SECURE:-N}
EMAIL_USER=${EMAIL_USER:-}
EMAIL_FROM=${EMAIL_FROM:-}
EMAIL_RECIPIENTS=${EMAIL_RECIPIENTS:-}
SETTINGS
  echo "Settings saved to $SETTINGS_FILE"
}

USE_SAVED=false

if [[ -f "$SETTINGS_FILE" ]]; then
  echo ""
  echo "========== Saved Settings =========="
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
  read -r -p "Accept these settings? (only passwords will be prompted) [Y/n]: " ACCEPT_SAVED
  ACCEPT_SAVED=${ACCEPT_SAVED:-Y}
  if [[ "${ACCEPT_SAVED^^}" =~ ^Y ]]; then
    USE_SAVED=true
  fi
fi

if $USE_SAVED; then
  # Load all non-secret values from saved settings
  HOST_USER="$(load_setting HOST_USER)"
  SSH_AUTHORIZED_KEY="$(load_setting SSH_AUTHORIZED_KEY)"
  NET_INTERFACE="$(load_setting NET_INTERFACE)"
  STATIC_IP="$(load_setting STATIC_IP)"
  STATIC_PREFIX="$(load_setting STATIC_PREFIX)"
  GATEWAY="$(load_setting GATEWAY)"
  DNS_SERVERS="$(load_setting DNS_SERVERS)"
  SERVICEBAY_PORT="$(load_setting SERVICEBAY_PORT)"
  SERVICEBAY_CHANNEL="$(load_setting SERVICEBAY_CHANNEL)"
  SERVICEBAY_ADMIN_USER="$(load_setting SERVICEBAY_ADMIN_USER)"
  GW_HOST="$(load_setting GW_HOST)"
  GW_USER="$(load_setting GW_USER)"
  ENABLE_REGISTRIES="$(load_setting ENABLE_REGISTRIES)"
  ENABLE_EMAIL="$(load_setting ENABLE_EMAIL)"
  EMAIL_HOST="$(load_setting EMAIL_HOST)"
  EMAIL_PORT="$(load_setting EMAIL_PORT)"
  EMAIL_SECURE="$(load_setting EMAIL_SECURE)"
  EMAIL_USER="$(load_setting EMAIL_USER)"
  EMAIL_FROM="$(load_setting EMAIL_FROM)"
  EMAIL_RECIPIENTS="$(load_setting EMAIL_RECIPIENTS)"

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

  # Nginx config import (also available in saved-settings mode)
  echo ""
  read -r -p "Import an existing nginx config export? (JSON file) [N]: " IMPORT_NGINX
  IMPORT_NGINX=${IMPORT_NGINX:-N}
  if [[ "${IMPORT_NGINX^^}" =~ ^Y ]]; then
    prompt NGINX_IMPORT_FILE "Path to nginx config JSON" ""
  else
    NGINX_IMPORT_FILE=""
  fi

else
  # --- Full interactive prompts ---

  prev() {
    local key="$1" fallback="$2"
    local val
    val=$(load_setting "$key")
    if [[ -n "$val" ]]; then echo "$val"; else echo "$fallback"; fi
  }

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

  # --- Nginx Config Import ---

  echo ""
  echo "--- Nginx Reverse Proxy ---"
  echo "Nginx will be installed automatically on first boot."
  read -r -p "Import an existing nginx config export? (JSON file) [N]: " IMPORT_NGINX
  IMPORT_NGINX=${IMPORT_NGINX:-N}
  if [[ "${IMPORT_NGINX^^}" =~ ^Y ]]; then
    prompt NGINX_IMPORT_FILE "Path to nginx config JSON" ""
  else
    NGINX_IMPORT_FILE=""
  fi
fi

# --- Save settings for next run ---
save_settings

PASSWORD_HASH="$(printf '%s' "$HOST_PASSWORD" | openssl passwd -6 -stdin)"

# Build ServiceBay config.json (with optional sections)
SERVICEBAY_CONFIG='{
  "auth": {
    "username": "'"$SERVICEBAY_ADMIN_USER"'",
    "password": "'"$SERVICEBAY_ADMIN_PASSWORD"'"
  },
  "autoUpdate": {
    "enabled": true,
    "schedule": "0 0 * * *",
    "channel": "'"$SERVICEBAY_CHANNEL"'"
  },
  "templateSettings": {
    "DATA_DIR": "'"$DATA_ROOT/stacks"'"
  }'

# Add gateway config if provided
if [[ -n "$GW_USER" ]]; then
  SERVICEBAY_CONFIG+=',
  "gateway": {
    "type": "fritzbox",
    "host": "'"$GW_HOST"'",
    "username": "'"$GW_USER"'",
    "password": "'"$GW_PASS"'"
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
  # Convert comma-separated recipients to JSON array
  EMAIL_TO_JSON="$(echo "$EMAIL_RECIPIENTS" | sed 's/[[:space:]]*,[[:space:]]*/","/g; s/^/"/; s/$/"/')"
  EMAIL_SECURE_BOOL="false"
  [[ "${EMAIL_SECURE^^}" =~ ^Y ]] && EMAIL_SECURE_BOOL="true"
  SERVICEBAY_CONFIG+=',
  "notifications": {
    "email": {
      "enabled": true,
      "host": "'"$EMAIL_HOST"'",
      "port": '"$EMAIL_PORT"',
      "secure": '"$EMAIL_SECURE_BOOL"',
      "user": "'"$EMAIL_USER"'",
      "pass": "'"$EMAIL_PASS"'",
      "from": "'"$EMAIL_FROM"'",
      "to": ['"$EMAIL_TO_JSON"']
    }
  }'
fi

SERVICEBAY_CONFIG+=',
  "setupCompleted": true
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

export HOST_USER SSH_AUTHORIZED_KEY PASSWORD_HASH NET_INTERFACE STATIC_IP STATIC_PREFIX GATEWAY DNS_SERVERS \
       DATA_ROOT SERVICEBAY_PORT SERVICEBAY_VERSION SERVICEBAY_CONFIG_JSON SERVICEBAY_SSH_PUB SERVICEBAY_SSH_PRIV

# Render Butane template
envsubst < "$TEMPLATE" > "$RENDERED_BU"

# --- Inject imported nginx config files into Butane ---
if [[ -n "${NGINX_IMPORT_FILE:-}" && -f "$NGINX_IMPORT_FILE" ]]; then
  echo "Embedding nginx config from $NGINX_IMPORT_FILE..."
  # Parse JSON and create Butane file entries for each .conf file
  # The JSON format is { "filename.conf": "content", ... }
  NGINX_CONF_DIR="${DATA_ROOT}/nginx/conf.d"
  NGINX_BUTANE_EXTRA=""
  while IFS='=' read -r filename; do
    # Extract content for this key using python3 or a simple approach
    content=$(python3 -c "
import json, sys
with open('$NGINX_IMPORT_FILE') as f:
    data = json.load(f)
print(data.get('$filename', ''))
" 2>/dev/null || echo "")
    if [[ -n "$content" ]]; then
      NGINX_BUTANE_EXTRA+="
    - path: ${NGINX_CONF_DIR}/${filename}
      mode: 0644
      user:
        name: ${HOST_USER}
      group:
        name: ${HOST_USER}
      contents:
        inline: |
$(echo "$content" | sed 's/^/          /')"
    fi
  done < <(python3 -c "
import json
with open('$NGINX_IMPORT_FILE') as f:
    data = json.load(f)
for key in data:
    print(key)
" 2>/dev/null)

  if [[ -n "$NGINX_BUTANE_EXTRA" ]]; then
    # Append the extra file entries before the 'links:' section
    sed -i "/^  links:/i\\${NGINX_BUTANE_EXTRA}" "$RENDERED_BU"
    echo "  Embedded $(echo "$NGINX_BUTANE_EXTRA" | grep -c '^\    - path:') nginx config file(s)"
  fi
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
cat > "$PRE_INSTALL" <<'PREINST'
#!/usr/bin/env bash
set -euo pipefail

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

# Find removable USB drives
mapfile -t USB_DEVS < <(
  for dev in /sys/block/sd*; do
    [[ -e "$dev/removable" ]] || continue
    [[ "$(cat "$dev/removable" 2>/dev/null)" == "1" ]] || continue
    name=$(basename "$dev")
    size_bytes=$(blockdev --getsize64 "/dev/$name" 2>/dev/null || echo 0)
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
echo "After install, add the second SSD to the RAID:"
echo "  sudo mdadm --add /dev/md/data /dev/disk/by-partlabel/raid1-ssd2"
