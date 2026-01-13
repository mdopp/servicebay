#!/usr/bin/env bash
set -euo pipefail

# Interactive installer for Fedora CoreOS using the fedora-coreos.bu template.
# Prompts for secrets (SSH key, passwords) and renders Butane -> Ignition, then
# hosts the Ignition file for network install.

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build/fcos"
TEMPLATE="$BUILD_DIR/fedora-coreos.bu" # Write template to build dir
RENDERED_BU="$BUILD_DIR/fedora-coreos.rendered.bu"
IGNITION_OUT="$BUILD_DIR/install.ign"
HTTP_PORT=${HTTP_PORT:-8000}
PYTHON_BIN=${PYTHON_BIN:-python}

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

    # User Linger (enables rootless services at boot)
    - path: /var/lib/systemd/linger/${HOST_USER}
      mode: 0644

  links:
    # Enable Podman Socket for the user (required for ServiceBay to control the host)
    - path: /var/home/${HOST_USER}/.config/systemd/user/sockets.target.wants/podman.socket
      target: /usr/lib/systemd/user/podman.socket
      user:
        name: ${HOST_USER}
      group:
        name: ${HOST_USER}

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
          SecurityLabelDisable=true

          [Service]
          # Retry restart if it fails (e.g. socket not ready)
          Restart=always
          RestartSec=5

          [Install]
          WantedBy=default.target

    # ServiceBay Initial Config
    - path: ${DATA_ROOT}/servicebay/config.json
      mode: 0644
      user:
        name: ${HOST_USER}
      group:
        name: ${HOST_USER}
      contents:
        inline: |
          {
            "auth": {
              "username": "${SERVICEBAY_ADMIN_USER}",
              "password": "${SERVICEBAY_ADMIN_PASSWORD}"
            },
            "templateSettings": {
              "STACKS_DIR": "${DATA_ROOT}/stacks"
            }
          }
EOF

if ! command -v butane >/dev/null 2>&1; then
  echo "butane is required. Install from https://github.com/coreos/butane/releases" >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to hash passwords" >&2
  exit 1
fi

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

# Suggest an SSH public key if available
DEFAULT_SSH_KEY="$(cat ~/.ssh/id_ed25519.pub 2>/dev/null || cat ~/.ssh/id_rsa.pub 2>/dev/null || echo '')"

prompt SSH_AUTHORIZED_KEY "SSH public key (for ${HOST_USER:-core})" "${DEFAULT_SSH_KEY:-ssh-ed25519 YOUR_KEY_HERE}"
prompt HOST_USER "Host username" "core"
prompt NET_INTERFACE "Network interface" "eno1"
prompt STATIC_IP "Static IPv4" "192.168.178.99"
prompt STATIC_PREFIX "IPv4 prefix length" "24"
prompt GATEWAY "Gateway" "192.168.178.1"
prompt DNS_SERVERS "DNS servers (semicolon separated)" "192.168.178.1;8.8.8.8;"
prompt DATA_ROOT "Data root" "/mnt/data"
prompt SERVICEBAY_PORT "ServiceBay port" "5888"

echo "Select ServiceBay Channel:"
echo "  1) Stable (latest)"
echo "  2) Test   (test)"
echo "  3) Dev    (dev)"
read -r -p "Select channel [1]: " CHANNEL_OPT
CHANNEL_OPT=${CHANNEL_OPT:-1}
case $CHANNEL_OPT in
    2) SERVICEBAY_VERSION="test" ;;
    3) SERVICEBAY_VERSION="dev" ;;
    *) SERVICEBAY_VERSION="latest" ;;
esac

prompt SERVICEBAY_ADMIN_USER "ServiceBay admin user" "admin"
prompt_secret SERVICEBAY_ADMIN_PASSWORD "ServiceBay admin password"
prompt_secret HOST_PASSWORD "Host user console password (will be hashed)"

PASSWORD_HASH="$(printf '%s' "$HOST_PASSWORD" | openssl passwd -6 -stdin)"

export HOST_USER SSH_AUTHORIZED_KEY PASSWORD_HASH NET_INTERFACE STATIC_IP STATIC_PREFIX GATEWAY DNS_SERVERS \
       DATA_ROOT SERVICEBAY_PORT SERVICEBAY_VERSION SERVICEBAY_ADMIN_USER SERVICEBAY_ADMIN_PASSWORD

# Render Butane template
envsubst < "$TEMPLATE" > "$RENDERED_BU"

# Transpile to Ignition
butane --pretty --strict "$RENDERED_BU" > "$IGNITION_OUT"

echo "\nGenerated files:" \
  "\n- $RENDERED_BU" \
  "\n- $IGNITION_OUT"

read -r -p "Start temporary HTTP server on port $HTTP_PORT to serve install.ign? [Y/n]: " START_SERVER
START_SERVER=${START_SERVER:-Y}

if [[ "${START_SERVER^^}" != "N" ]]; then
  echo "Starting HTTP server (ctrl+c to stop)..."
  (cd "$BUILD_DIR" && "$PYTHON_BIN" -m http.server "$HTTP_PORT") &
  SERVER_PID=$!
  HOST_IP=$(hostname -I | awk '{print $1}')
  echo "Serving install.ign at: http://$HOST_IP:$HTTP_PORT/install.ign"
  echo "Use this command on the target (adjust disk):"
  echo "  sudo coreos-installer install /dev/sdX --ignition-url http://$HOST_IP:$HTTP_PORT/install.ign"
  echo "To stop the server: kill $SERVER_PID"
else
  echo "HTTP server not started. Serve $IGNITION_OUT manually (e.g., python -m http.server $HTTP_PORT in $BUILD_DIR)."
fi
