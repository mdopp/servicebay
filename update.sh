#!/bin/bash

# ServiceBay Updater
# Usage: curl -fsSL https://raw.githubusercontent.com/mdopp/servicebay/main/update.sh | bash

set -e

# Configuration
FULL_TAR_URL="https://github.com/mdopp/servicebay/releases/latest/download/servicebay-linux-x64.tar.gz"
UPDATE_TAR_URL="https://github.com/mdopp/servicebay/releases/latest/download/servicebay-update-linux-x64.tar.gz"
INSTALL_DIR="$HOME/.servicebay"
SERVICE_NAME="servicebay"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }

log "Starting ServiceBay update..."

if [ ! -d "$INSTALL_DIR" ]; then
    echo "ServiceBay is not installed. Please run install.sh first."
    exit 1
fi

# Backup config
if [ -f "$INSTALL_DIR/config.json" ]; then
    log "Backing up config.json..."
    cp "$INSTALL_DIR/config.json" /tmp/servicebay_config_backup.json
fi

log "Checking for updates..."
TEMP_DIR=$(mktemp -d)

# 1. Download update bundle (small)
log "Downloading update bundle..."
if ! curl -L "$UPDATE_TAR_URL" -o "$TEMP_DIR/update.tar.gz" --fail; then
    log "Update bundle not found. Falling back to full bundle."
    USE_FULL=1
else
    # 2. Check if dependencies changed
    # Extract new package-lock.json
    tar -xzf "$TEMP_DIR/update.tar.gz" -C "$TEMP_DIR" --strip-components=1 servicebay/package-lock.json
    
    if [ -f "$INSTALL_DIR/package-lock.json" ] && cmp -s "$INSTALL_DIR/package-lock.json" "$TEMP_DIR/package-lock.json"; then
        log "Dependencies unchanged. Using optimized update."
        USE_FULL=0
    else
        log "Dependencies changed. Downloading full bundle..."
        USE_FULL=1
    fi
fi

if [ "$USE_FULL" -eq 1 ]; then
    # Download full bundle
    curl -L "$FULL_TAR_URL" -o "$TEMP_DIR/full.tar.gz"
    
    log "Installing full version..."
    rm -rf "$INSTALL_DIR"/*
    tar xz -f "$TEMP_DIR/full.tar.gz" -C "$INSTALL_DIR" --strip-components=1
else
    log "Installing optimized version..."
    
    # Move node_modules aside
    if [ -d "$INSTALL_DIR/node_modules" ]; then
        mv "$INSTALL_DIR/node_modules" "$TEMP_DIR/node_modules"
    fi
    
    # Wipe directory
    rm -rf "$INSTALL_DIR"/*
    
    # Extract update
    tar xz -f "$TEMP_DIR/update.tar.gz" -C "$INSTALL_DIR" --strip-components=1
    
    # Restore node_modules
    if [ -d "$TEMP_DIR/node_modules" ]; then
        mv "$TEMP_DIR/node_modules" "$INSTALL_DIR/node_modules"
    fi
fi

# Cleanup
rm -rf "$TEMP_DIR"

# Restore config
if [ -f "/tmp/servicebay_config_backup.json" ]; then
    log "Restoring config.json..."
    mv /tmp/servicebay_config_backup.json "$INSTALL_DIR/config.json"
fi

log "Restarting service..."
systemctl --user restart ${SERVICE_NAME}

success "Update complete!"
