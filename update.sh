#!/bin/bash

# ServiceBay Updater
# Usage: curl -fsSL https://raw.githubusercontent.com/mdopp/servicebay/main/update.sh | bash

set -e

# Configuration
TAR_URL="https://github.com/mdopp/servicebay/releases/latest/download/servicebay-linux-x64.tar.gz"
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

log "Downloading and extracting update..."
# We download to a temp dir to avoid partial overwrites if download fails
TEMP_DIR=$(mktemp -d)
curl -L "$TAR_URL" | tar xz -C "$TEMP_DIR" --strip-components=1

# Replace files
log "Installing new version..."
# Remove old files but keep the directory structure to avoid permission issues?
# Safer to just rsync or cp. 
# Since we want to remove old unused files, we should clear the dir, but we need to be careful.
# Let's stick to the install.sh method: wipe and replace.
rm -rf "$INSTALL_DIR"/*
cp -r "$TEMP_DIR"/* "$INSTALL_DIR/"
rm -rf "$TEMP_DIR"

# Restore config
if [ -f "/tmp/servicebay_config_backup.json" ]; then
    log "Restoring config.json..."
    mv /tmp/servicebay_config_backup.json "$INSTALL_DIR/config.json"
fi

log "Restarting service..."
systemctl --user restart ${SERVICE_NAME}

success "Update complete!"
