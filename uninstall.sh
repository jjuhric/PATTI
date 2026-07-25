#!/bin/bash

# Determine the absolute directory containing the script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Uninstall script for Private AI Assistant
# Removes systemd service, cron jobs, environment configurations, logs, databases, and dependencies

echo "============================================="
echo "❌ Uninstalling Private AI Assistant Node"
echo "============================================="

# 1. Stop and disable systemd service if running
SERVICE_NAME="patti"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

if [ -f "$SERVICE_FILE" ]; then
    echo "Stopping and disabling systemd service..."
    sudo systemctl stop "$SERVICE_NAME".service 2>/dev/null
    sudo systemctl disable "$SERVICE_NAME".service 2>/dev/null
    sudo rm -f "$SERVICE_FILE"
    sudo systemctl daemon-reload
    echo "✅ Systemd service removed."
fi

# 2. Remove cron job autoupdate entry
if command -v crontab &> /dev/null; then
    echo "Removing autoupdate task from cron..."
    crontab -l 2>/dev/null | grep -v "setup.sh --non-interactive" | crontab - 2>/dev/null
    echo "✅ Autoupdate cron job removed."
fi

# 3. Clean files and directories inside the repo, then remove the repository folder itself
echo "Deleting Private AI directory at $SCRIPT_DIR..."
if [ -d "$SCRIPT_DIR" ]; then
    # Perform cleanups
    rm -f "$SCRIPT_DIR/.env" "$SCRIPT_DIR/app.log"
    rm -rf "$SCRIPT_DIR/node_modules" "$SCRIPT_DIR/backend/node_modules" "$SCRIPT_DIR/frontend/node_modules" "$SCRIPT_DIR/frontend/dist"
    rm -rf "$SCRIPT_DIR/tool_registry/staging" "$SCRIPT_DIR/tool_registry/tools"
    rm -f "$SCRIPT_DIR/backend/database.db" "$SCRIPT_DIR/backend/database.db-wal" "$SCRIPT_DIR/backend/database.db-shm"
    rm -f "$SCRIPT_DIR/backend/test_database.db" "$SCRIPT_DIR/backend/test_database.db-wal" "$SCRIPT_DIR/backend/test_database.db-shm"
    
    # Remove the entire directory (including this uninstall script!)
    cd ~
    rm -rf "$SCRIPT_DIR"
    echo "✅ Directory and all files deleted."
fi

echo "============================================="
echo "🎉 Private AI has been uninstalled successfully!"
echo "============================================="
