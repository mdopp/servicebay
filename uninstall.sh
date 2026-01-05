#!/bin/bash

# ServiceBay Uninstaller
# Usage: curl -fsSL https://raw.githubusercontent.com/mdopp/servicebay/main/uninstall.sh | bash

set -e

# Configuration
SERVICE_NAME="servicebay"
SYSTEMD_DIR="$HOME/.config/containers/systemd"
CONFIG_DIR="$HOME/.servicebay"
IMAGE_NAME="ghcr.io/mdopp/servicebay:latest"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

echo -e "${RED}   _____                 _           ____              ${NC}"
echo -e "${RED}  / ____|               (_)         |  _ \             ${NC}"
echo -e "${RED} | (___   ___ _ ____   ___  ___ ___ | |_) | __ _ _   _ ${NC}"
echo -e "${RED}  \___ \ / _ \ '__\ \ / / |/ __/ _ \|  _ < / _\` | | | |${NC}"
echo -e "${RED}  ____) |  __/ |   \ V /| | (_|  __/| |_) | (_| | |_| |${NC}"
echo -e "${RED} |_____/ \___|_|    \_/ |_|\___\___||____/ \__,_|\__, |${NC}"
echo -e "${RED}                                                  __/ |${NC}"
echo -e "${RED}                                                 |___/ ${NC}"
echo ""
log "Starting ServiceBay uninstallation..."

# --- Stop Service ---

if systemctl --user is-active --quiet "$SERVICE_NAME"; then
    log "Stopping ServiceBay service..."
    systemctl --user stop "$SERVICE_NAME"
fi

if systemctl --user is-enabled --quiet "$SERVICE_NAME"; then
    log "Disabling ServiceBay service..."
    systemctl --user disable "$SERVICE_NAME"
fi

# --- Remove Quadlet ---

CONTAINER_FILE="$SYSTEMD_DIR/$SERVICE_NAME.container"
if [ -f "$CONTAINER_FILE" ]; then
    log "Removing systemd unit file: $CONTAINER_FILE"
    rm "$CONTAINER_FILE"
else
    warn "Systemd unit file not found: $CONTAINER_FILE"
fi

# --- Remove Legacy/Conflicting Service Files ---

LEGACY_SERVICE_FILE="$HOME/.config/systemd/user/$SERVICE_NAME.service"
if [ -f "$LEGACY_SERVICE_FILE" ]; then
    log "Found legacy/conflicting service file: $LEGACY_SERVICE_FILE"
    rm "$LEGACY_SERVICE_FILE"
    success "Removed legacy service file."
fi

log "Reloading systemd daemon..."
systemctl --user daemon-reload

# --- Remove Data ---

if [ -d "$CONFIG_DIR" ]; then
    echo ""
    warn "Found configuration/data directory at: $CONFIG_DIR"
    read -p "Do you want to delete this directory and all data? (y/N) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        log "Removing data directory..."
        rm -rf "$CONFIG_DIR"
        success "Data directory removed."
    else
        log "Skipping data removal."
    fi
fi

# --- Remove Image ---

echo ""
read -p "Do you want to remove the ServiceBay docker image? (y/N) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    log "Removing image $IMAGE_NAME..."
    podman rmi "$IMAGE_NAME" || warn "Failed to remove image (might be in use or not found)."
else
    log "Skipping image removal."
fi

echo ""
success "ServiceBay uninstalled successfully."
