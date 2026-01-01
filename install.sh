#!/bin/bash

# ServiceBay Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/mdopp/servicebay/main/install.sh | bash

set -e

# Configuration
FULL_TAR_URL="https://github.com/mdopp/servicebay/releases/latest/download/servicebay-linux-x64.tar.gz"
UPDATE_TAR_URL="https://github.com/mdopp/servicebay/releases/latest/download/servicebay-update-linux-x64.tar.gz"
INSTALL_DIR="$HOME/.servicebay"
SERVICE_NAME="servicebay"
DEFAULT_PORT=3000

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

MISSING_DEPS=0

check_cmd() {
    if ! command -v "$1" &> /dev/null; then
        error "$1 is not installed."
        MISSING_DEPS=1
    else
        success "$1 found."
    fi
}

log "Checking dependencies..."
check_cmd "curl"
check_cmd "tar"
check_cmd "node"
check_cmd "npm"
check_cmd "podman"
check_cmd "systemctl"

if [ $MISSING_DEPS -eq 1 ]; then
    echo ""
    echo "Please install the missing dependencies and try again."
    echo "  - curl/tar: Download tools"
    echo "  - node/npm: Runtime (v18+ recommended)"
    echo "  - podman: Container engine"
    echo "  - systemctl: Service manager"
    exit 1
fi

# --- Installation Strategy ---

if [ -d "$INSTALL_DIR" ]; then
    IS_UPDATE=1
    log "Found existing installation at $INSTALL_DIR."
else
    IS_UPDATE=0
    log "Starting fresh installation..."
fi

# Backup Config
if [ -f "$INSTALL_DIR/config.json" ]; then
    log "Backing up config.json..."
    cp "$INSTALL_DIR/config.json" /tmp/servicebay_config_backup.json
fi

# Determine Install Strategy
TEMP_DIR=$(mktemp -d)
USE_FULL=1

if [ "$IS_UPDATE" -eq 1 ]; then
    log "Checking for optimized update..."
    # Try download update bundle
    if curl -L "$UPDATE_TAR_URL" -o "$TEMP_DIR/update.tar.gz" --fail --silent; then
        # Check dependencies
        tar -xzf "$TEMP_DIR/update.tar.gz" -C "$TEMP_DIR" --strip-components=1 servicebay/package-lock.json
        if [ -f "$INSTALL_DIR/package-lock.json" ] && cmp -s "$INSTALL_DIR/package-lock.json" "$TEMP_DIR/package-lock.json"; then
            log "Dependencies unchanged. Using optimized update."
            USE_FULL=0
        else
            log "Dependencies changed. Using full bundle."
        fi
    else
        log "Update bundle not found. Using full bundle."
    fi
fi

# Perform Install
if [ "$USE_FULL" -eq 0 ]; then
    # Optimized Update
    log "Installing optimized version..."
    
    if [ -d "$INSTALL_DIR/node_modules" ]; then
        mv "$INSTALL_DIR/node_modules" "$TEMP_DIR/node_modules"
    fi
    
    rm -rf "$INSTALL_DIR"/*
    mkdir -p "$INSTALL_DIR"
    tar xz -f "$TEMP_DIR/update.tar.gz" -C "$INSTALL_DIR" --strip-components=1
    
    if [ -d "$TEMP_DIR/node_modules" ]; then
        mv "$TEMP_DIR/node_modules" "$INSTALL_DIR/node_modules"
    fi
else
    # Full Install
    log "Downloading full release..."
    # Extract to temp/full first to avoid partial install on failure
    mkdir -p "$TEMP_DIR/full"
    curl -L "$FULL_TAR_URL" | tar xz -C "$TEMP_DIR/full" --strip-components=1
    
    log "Installing full version..."
    rm -rf "$INSTALL_DIR"
    mkdir -p "$INSTALL_DIR"
    
    # Move files
    cp -r "$TEMP_DIR/full/"* "$INSTALL_DIR/"
    cp -r "$TEMP_DIR/full/".* "$INSTALL_DIR/" 2>/dev/null || true
fi

# Restore Config
if [ -f "/tmp/servicebay_config_backup.json" ]; then
    log "Restoring config.json..."
    mv /tmp/servicebay_config_backup.json "$INSTALL_DIR/config.json"
fi

rm -rf "$TEMP_DIR"

# --- Registry Configuration ---

CONFIG_FILE="$INSTALL_DIR/config.json"

# Ensure config exists
if [ ! -f "$CONFIG_FILE" ]; then
    echo "{}" > "$CONFIG_FILE"
fi

# Helper to write JSON
add_registry() {
    local name="$1"
    local url="$2"
    local branch="$3"
    node -e "
        const fs = require('fs');
        try {
            const c = require('$CONFIG_FILE');
            if (Array.isArray(c.registries)) {
                c.registries = { enabled: true, items: c.registries };
            }
            c.registries = c.registries || { enabled: true, items: [] };
            if (!c.registries.items.find(r => r.name === '$name')) {
                c.registries.items.push({ name: '$name', url: '$url', branch: '$branch' || undefined });
                fs.writeFileSync('$CONFIG_FILE', JSON.stringify(c, null, 2));
            }
        } catch (e) { console.error(e); }
    "
}

if [ -c /dev/tty ]; then
    echo ""
    log "--- Template Registries ---"
    
    # Check if default registry is configured
    HAS_DEFAULT=$(node -e "
        try { 
            const c = require('$CONFIG_FILE'); 
            let items = [];
            if (Array.isArray(c.registries)) items = c.registries;
            else if (c.registries) items = c.registries.items || [];
            console.log(items.some(r => r.name === 'default') ? 'yes' : 'no'); 
        } catch { console.log('no'); }
    ")

    if [ "$HAS_DEFAULT" == "no" ]; then
        read -p "Add default template registry (recommended)? [Y/n]: " ADD_DEFAULT < /dev/tty
        ADD_DEFAULT=${ADD_DEFAULT:-Y}
        if [[ "$ADD_DEFAULT" =~ ^[Yy]$ ]]; then
            add_registry "default" "https://github.com/mdopp/servicebay-templates.git" "main"
            success "Added default registry."
        fi
    fi

    while true; do
        echo ""
        echo "Current Registries:"
        node -e "
            try {
                const c = require('$CONFIG_FILE');
                let items = [];
                if (Array.isArray(c.registries)) items = c.registries;
                else if (c.registries) items = c.registries.items || [];
                
                items.forEach(r => console.log(' - ' + r.name + ' (' + r.url + ')'));
                if (!items.length) console.log('   (none)');
            } catch {}
        "
        echo ""
        read -p "Add another registry? [y/N]: " ADD_MORE < /dev/tty
        ADD_MORE=${ADD_MORE:-N}
        
        if [[ ! "$ADD_MORE" =~ ^[Yy]$ ]]; then
            break
        fi

        read -p "Registry Name: " REG_NAME < /dev/tty
        read -p "Git URL: " REG_URL < /dev/tty
        read -p "Branch (optional): " REG_BRANCH < /dev/tty

        if [ -n "$REG_NAME" ] && [ -n "$REG_URL" ]; then
            add_registry "$REG_NAME" "$REG_URL" "$REG_BRANCH"
            success "Added registry '$REG_NAME'."
        else
            error "Name and URL are required."
        fi
    done
fi

log "Verifying installation..."
if [ ! -f "$INSTALL_DIR/server.js" ]; then
    error "Installation failed: server.js not found."
    exit 1
fi

# --- Service Setup ---

SERVICE_FILE="$HOME/.config/systemd/user/${SERVICE_NAME}.service"

if [ -f "$SERVICE_FILE" ] && [ "$IS_UPDATE" -eq 1 ]; then
    log "Service file exists. Restarting..."
    systemctl --user daemon-reload
    systemctl --user restart ${SERVICE_NAME}
else
    log "Configuring systemd service..."
    
    # Port Selection
    if [ -f "$SERVICE_FILE" ]; then
        EXISTING_PORT=$(grep "Environment=PORT=" "$SERVICE_FILE" | cut -d= -f3)
        if [ -n "$EXISTING_PORT" ]; then
            DEFAULT_PORT=$EXISTING_PORT
        fi
    fi

    echo ""
    if [ -c /dev/tty ]; then
        read -p "Enter desired port [$DEFAULT_PORT]: " INPUT_PORT < /dev/tty
        PORT=${INPUT_PORT:-$DEFAULT_PORT}
    else
        log "Non-interactive mode detected. Using default port $DEFAULT_PORT."
        PORT=$DEFAULT_PORT
    fi

    if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
        error "Invalid port: $PORT. Using default $DEFAULT_PORT."
        PORT=$DEFAULT_PORT
    fi
    
    mkdir -p ~/.config/systemd/user

    # Get absolute path to node
    NODE_PATH=$(which node)

    # Generate a random secret for session encryption
    AUTH_SECRET=$($NODE_PATH -e "console.log(crypto.randomBytes(32).toString('hex'))")

    cat <<EOF > "$SERVICE_FILE"
[Unit]
Description=ServiceBay - Podman Systemd Manager
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_PATH} server.js
Restart=always
Environment=NODE_ENV=production
Environment=PORT=${PORT}
Environment=AUTH_SECRET=${AUTH_SECRET}
# Capture current PATH to ensure node/podman are found
Environment="PATH=$PATH"

[Install]
WantedBy=default.target
EOF

    systemctl --user daemon-reload
    systemctl --user enable --now ${SERVICE_NAME}
    log "Service started and enabled."
fi

# --- Final Output ---

# Get IP address (simple attempt)
IP_ADDR=$(hostname -I | awk '{print $1}')
if [ -z "$IP_ADDR" ]; then
    IP_ADDR="localhost"
fi

echo ""
echo -e "${GREEN}==========================================${NC}"
echo -e "${GREEN}   ServiceBay Installed Successfully!     ${NC}"
echo -e "${GREEN}==========================================${NC}"
echo ""
echo -e "Access the dashboard at:"
echo -e "  ${BLUE}http://localhost:${PORT}${NC}"
echo -e "  ${BLUE}http://${IP_ADDR}:${PORT}${NC}"
echo ""
echo -e "Manage the service with:"
echo -e "  systemctl --user status ${SERVICE_NAME}"
echo -e "  systemctl --user restart ${SERVICE_NAME}"
echo -e "  systemctl --user stop ${SERVICE_NAME}"
echo ""
log "Installation complete."
