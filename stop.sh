#!/bin/bash

# Linux Stop Script for Private AI Assistant (PATTI)
# Stops all of PATTI's background processes WITHOUT removing anything - the systemd
# service definition, database, and .env configuration are left in place so re-running
# `setup.sh` or `sudo systemctl start private-ai` brings everything back exactly as it was.

SERVICE_NAME="private-ai"

echo "===================================================="
echo "  Stopping Private AI Assistant (PATTI)"
echo "===================================================="

log() {
    echo "[INFO] $1"
}

STOPPED_ANYTHING=false

# 1. Stop the systemd service if one is registered (setup.sh registers this for non-
# Windows/ESP32 device types when systemd + sudo are available).
if command -v systemctl &> /dev/null && systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE_NAME}.service"; then
    if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        sudo systemctl stop "$SERVICE_NAME"
        log "Stopped systemd service '$SERVICE_NAME'."
        STOPPED_ANYTHING=true
    fi
fi

# 2. Kill whatever is listening on the app port (from .env, default 3000) and the Vite
# dev server port (5173) - covers the nohup fallback and `npm start`/`npm run dev` run
# directly in a terminal.
APP_PORT=3000
if [ -f ".env" ]; then
    APP_PORT=$(grep -E "^PORT=" .env | cut -d'=' -f2 || echo "3000")
fi

if command -v lsof &> /dev/null; then
    for PORT_INFO in "$APP_PORT:backend" "5173:Vite dev server"; do
        PORT="${PORT_INFO%%:*}"
        LABEL="${PORT_INFO##*:}"
        PID=$(lsof -t -i:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
        if [ -n "$PID" ]; then
            kill "$PID" 2>/dev/null || true
            log "Stopped $LABEL (port $PORT), PID $PID."
            STOPPED_ANYTHING=true
        fi
    done
else
    log "lsof not found - cannot check for processes on ports $APP_PORT/5173. Install lsof for full coverage."
fi

echo ""
echo "===================================================="
if [ "$STOPPED_ANYTHING" = true ]; then
    echo "  PATTI has been stopped."
else
    echo "  Nothing was running - PATTI was already stopped."
fi
echo "===================================================="
echo "To start it again: sudo systemctl start $SERVICE_NAME (if using systemd) or 'npm start'."
