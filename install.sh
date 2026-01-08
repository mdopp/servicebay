#!/bin/bash

# ServiceBay Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/mdopp/servicebay/main/install.sh | bash

set -e

# Configuration
IMAGE_NAME="ghcr.io/mdopp/servicebay:latest"
SERVICE_NAME="servicebay"
PORT=3000
SYSTEMD_DIR="$HOME/.config/containers/systemd"
CONFIG_DIR="$HOME/.servicebay"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

echo -e "${GREEN}   _____                 _           ____              ${NC}"
echo -e "${GREEN}  / ____|               (_)         |  _ \             ${NC}"
echo -e "${GREEN} | (___   ___ _ ____   ___  ___ ___ | |_) | __ _ _   _ ${NC}"
echo -e "${GREEN}  \___ \ / _ \ '__\ \ / / |/ __/ _ \|  _ < / _\` | | | |${NC}"
echo -e "${GREEN}  ____) |  __/ |   \ V /| | (_|  __/| |_) | (_| | |_| |${NC}"
echo -e "${GREEN} |_____/ \___|_|    \_/ |_|\___\___||____/ \__,_|\__, |${NC}"
echo -e "${GREEN}                                                  __/ |${NC}"
echo -e "${GREEN}                                                 |___/ ${NC}"
echo ""
log "Starting ServiceBay installation..."

# --- Dependency Checks ---

if ! command -v podman &> /dev/null; then
    error "Podman is not installed. Please install Podman first."
    exit 1
fi

# --- Setup Directories ---

mkdir -p "$SYSTEMD_DIR"
mkdir -p "$CONFIG_DIR"

# --- Configuration Prompt ---

# When running via curl | bash, stdin is the script itself.
# We must read from /dev/tty to get user input.
if [ -c /dev/tty ]; then
    read -p "Enter the port to run ServiceBay on [3000]: " INPUT_PORT < /dev/tty
else
    log "No terminal detected. Using default port 3000."
fi
PORT=${INPUT_PORT:-3000}

# --- Authentication Setup ---

# We use the config.json in the data directory to store credentials safely
# This avoids environment variable leakage via 'podman inspect'
CONFIG_FILE="$CONFIG_DIR/config.json"
HAS_AUTH=false
ADMIN_USER="admin"

if [ -f "$CONFIG_FILE" ]; then
    # Check if auth is already defined in json using grep (simple check)
    if grep -q '"auth"' "$CONFIG_FILE"; then
        log "Existing authentication configuration found in config.json."
        HAS_AUTH=true
        # Try to extract user/pass for display (best effort with grep/sed as jq might not be present)
        # Note: This is fragile but sufficient for the installer output
        ADMIN_USER=$(grep -o '"username": *"[^"]*"' "$CONFIG_FILE" | cut -d'"' -f4)
        ADMIN_PASS="******** (hidden)" 
    fi
fi

if [ "$HAS_AUTH" = false ]; then
    log "Generating new administrative configuration..."
    
    # Generate a random password
    if command -v openssl &> /dev/null; then
        ADMIN_PASS=$(openssl rand -base64 12)
    else
        ADMIN_PASS="admin-$(date +%s)"
    fi
    
    # We need to construct or merge the json. 
    # Since we can't assume 'jq' is installed, we'll do a basic write if file doesn't exist,
    # or rely on the user to configure it if the file exists but has no auth.
    
    # But usually this is a fresh install or re-install where we want to ensure access.
    # If config.json exists but no auth, we append it? No, JSON editing with bash is hard.
    # We will write a NEW config if it doesn't exist.
    
    if [ ! -f "$CONFIG_FILE" ]; then
        cat > "$CONFIG_FILE" <<EOF
{
  "auth": {
    "username": "admin",
    "password": "$ADMIN_PASS"
  }
}
EOF
        log "Created new configuration at $CONFIG_FILE"
    else
        # Config exists but no auth. We can't safely edit JSON without jq.
        # Fallback to creating a separate auth.json that the app could merge?
        # Or just warn the user.
        # Let's try to overwrite if it's minimal, otherwise instruction.
        log "WARNING: config.json exists but no 'auth' section found."
        log "Please manually add the following to $CONFIG_FILE:"
        echo '  "auth": { "username": "admin", "password": "YOUR_PASSWORD" }'
        ADMIN_PASS="<CHECK_CONFIG_FILE>"
    fi
fi

# --- Create nodes.json if not exists ---
NODES_FILE="$CONFIG_DIR/nodes.json"
if [ ! -f "$NODES_FILE" ]; then
    log "Configuring Local node..."
    cat > "$NODES_FILE" <<NODESEOF
[
  {
    "Name": "Local",
    "URI": "local",
    "Identity": "",
    "Default": true
  }
]
NODESEOF
fi

# --- Create Quadlet ---

log "Creating systemd service..."

cat > "$SYSTEMD_DIR/$SERVICE_NAME.container" <<INNEREOF
[Unit]
Description=ServiceBay Container Management Interface
After=network-online.target

[Container]
Image=$IMAGE_NAME
ContainerName=$SERVICE_NAME
AutoUpdate=registry
UserNS=keep-id
Network=host
Volume=$CONFIG_DIR:/app/data
Volume=$HOME/.ssh:/root/.ssh:ro
Volume=/run/user/$(id -u)/podman/podman.sock:/run/podman/podman.sock
Environment=CONTAINER_HOST=unix:///run/podman/podman.sock
Environment=NODE_ENV=production
Environment=PORT=$PORT

[Install]
WantedBy=default.target
INNEREOF



# --- Reload and Start ---

log "Reloading systemd..."
systemctl --user daemon-reload

log "Starting ServiceBay..."
# For Quadlets, we just start the service. Enablement is handled by the [Install] section in the .container file
# which the generator should handle, but sometimes 'enable' fails on generated units.
# We try to start it first.
systemctl --user start "$SERVICE_NAME"

# Try to enable it, but don't fail if it complains about being transient (it might already be enabled by generator)
systemctl --user enable "$SERVICE_NAME" || true

success "ServiceBay installed successfully!"
echo -e "Access it at: http://$(hostname):$PORT"
echo -e "Login with username: ${BLUE}$ADMIN_USER${NC} and password: ${BLUE}$ADMIN_PASS${NC}"

if [[ "$ADMIN_PASS" == *"hidden"* ]]; then
  echo -e "To view the password, run: ${BLUE}grep -A 3 \"auth\" $CONFIG_FILE${NC}"
fi


