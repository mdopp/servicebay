#!/bin/bash

# ServiceBay Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/mdopp/servicebay/main/install.sh | bash

set -e

# Configuration
# Use the latest release tarball instead of source code
TAR_URL="https://github.com/mdopp/servicebay/releases/latest/download/servicebay-linux-x64.tar.gz"
INSTALL_DIR="$HOME/.servicebay"
SERVICE_NAME="servicebay"
PORT=3000

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

# Check for build tools (required for node-pty native module)
if ! command -v make &> /dev/null || ! command -v g++ &> /dev/null; then
    echo ""
    log "Warning: Build tools (make, g++) seem to be missing."
    echo "       The 'Terminal' feature requires compiling native modules."
    echo "       If the installation fails below, please install build tools:"
    echo "       Debian/Ubuntu: sudo apt install -y build-essential python3"
    echo "       Fedora/RHEL:   sudo dnf groupinstall -y 'Development Tools'"
    echo ""
fi

# --- Configuration ---

echo ""
if [ -c /dev/tty ]; then
    read -p "Enter desired port [3000]: " INPUT_PORT < /dev/tty
    PORT=${INPUT_PORT:-3000}
else
    log "Non-interactive mode detected (no /dev/tty). Using default port 3000."
    PORT=3000
fi

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    error "Invalid port: $PORT. Using default 3000."
    PORT=3000
fi
log "Using port: $PORT"

# --- Installation ---

if [ -d "$INSTALL_DIR" ]; then
    log "Removing old installation..."
    rm -rf "$INSTALL_DIR"
fi

log "Downloading release..."
mkdir -p "$INSTALL_DIR"
curl -L "$TAR_URL" | tar xz -C "$INSTALL_DIR" --strip-components=1
cd "$INSTALL_DIR"

# --- Dependencies ---
log "Installing production dependencies..."

# Remove 'prepare' script (husky) to prevent failure in production (husky is devDep)
npm pkg delete scripts.prepare || true

# We need to install dependencies that might be missing from the standalone build
# (like socket.io, node-pty) and ensure native modules match the system.
if ! npm install --production --no-audit --no-fund; then
    echo ""
    error "Dependency installation failed."
    echo "       This is likely due to missing build tools for 'node-pty'."
    echo "       Please install 'build-essential' (Ubuntu/Debian) or 'Development Tools' (Fedora)"
    echo "       and try again."
    exit 1
fi

# --- Build ---
# Since we download a pre-built release, we don't need to build anything!
# We just need to ensure node is available.

log "Verifying installation..."
if [ ! -f "server.js" ]; then
    error "Installation failed: server.js not found."
    exit 1
fi

# --- Service Setup ---

log "Configuring systemd user service..."
mkdir -p ~/.config/systemd/user

# Get absolute path to node
NODE_PATH=$(which node)

# Generate a random secret for session encryption
AUTH_SECRET=$($NODE_PATH -e "console.log(crypto.randomBytes(32).toString('hex'))")

cat <<EOF > ~/.config/systemd/user/${SERVICE_NAME}.service
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

log "Reloading systemd..."
systemctl --user daemon-reload

log "Enabling and starting service..."
systemctl --user enable --now ${SERVICE_NAME}

# --- Finish ---

echo ""
success "Installation complete!"
echo "--------------------------------------------------"
echo "Web Interface: http://localhost:${PORT}"
echo "Service Status: systemctl --user status ${SERVICE_NAME}"
echo "Logs: journalctl --user -u ${SERVICE_NAME} -f"
echo "--------------------------------------------------"
