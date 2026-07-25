#!/bin/bash

# Exit on error
set -e

# Configuration
REPO_URL="https://github.com/[USER]/private_ai.git"
TARGET_PARENT_DIR="$HOME/Documents"
TARGET_DIR="$TARGET_PARENT_DIR/private_ai"
SERVICE_NAME="private-ai"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# Parse CLI arguments
NON_INTERACTIVE=false
SKIP_UPDATE=false
for arg in "$@"; do
    if [ "$arg" = "--non-interactive" ]; then
        NON_INTERACTIVE=true
    elif [ "$arg" = "--skip-update" ]; then
        SKIP_UPDATE=true
    fi
done

echo "===================================================="
echo "  Private AI Assistant Setup & Update Utility V4.6.0 "
echo "===================================================="

# Helper function to print logs
log() {
    echo -e "\n[INFO] $1"
}

log_success() {
    echo -e "\n[SUCCESS] $1"
}

log_error() {
    echo -e "\n[ERROR] $1" >&2
}

# Detect presence of configuration targets
if [ ! -f "backend/.env" ]; then
    echo "⚠️ Warning: Target environment layout configuration file [.env] was not found!"
    echo "Would you like to configure mandatory environment properties via this console shell now? (y/N)"
    read -r configure_now
    
    if [ "$configure_now" = "y" ] || [ "$configure_now" = "Y" ]; then
        cp backend/.env.example backend/.env
        echo -n "Enter target uniqueness identifier for this node machine configuration string: "
        read -r node_identity
        sed -i "s/NODE_NAME=.*/NODE_NAME=$node_identity/g" backend/.env
        echo "✅ Basic node parameters logged configuration setups completed."
    else
        echo "💡 Initialization Notice: Missing configurations can be completed using the Setup Wizard Dashboard directly inside your browser once runtime starts up."
    fi
fi

# Update check: If already setup, treat as update
if [ "$SKIP_UPDATE" = false ] && [ -f ".env" ]; then
    log "Existing setup detected (.env file exists). Treating as an update..."

    # Stop existing process listening on port to release file locks
    PORT=$(grep -E "^PORT=" .env | cut -d'=' -f2 || echo "3000")
    if command -v lsof &> /dev/null; then
        PID=$(lsof -t -i:"$PORT" 2>/dev/null || true)
        if [ ! -z "$PID" ]; then
            log "Stopping existing process $PID on port $PORT to release file locks..."
            kill -9 "$PID" 2>/dev/null || true
        fi
        
        # Stop Vite dev server process on port 5173
        VITE_PID=$(lsof -t -i:5173 2>/dev/null || true)
        if [ ! -z "$VITE_PID" ]; then
            log "Stopping Vite development server process $VITE_PID on port 5173 to release file locks..."
            kill -9 "$VITE_PID" 2>/dev/null || true
        fi
        sleep 1
    fi
    
    # Verify Git and pull
    if command -v git &> /dev/null; then
        if [ -d ".git" ]; then
            log "Discarding any local changes and pulling latest updates from git..."
            git checkout . || true
            git reset --hard || true
            git pull || true
        fi
    fi

    # Fresh npm install
    log "Removing existing node_modules directories for a fresh installation..."
    rm -rf node_modules backend/node_modules frontend/node_modules

    log "Installing all dependencies fresh..."
    npm run install:all

    # Re-run setup.sh with --skip-update to complete the setup process
    log "Re-running setup.sh to apply configurations and rebuild..."
    ARGS=()
    if [ "$NON_INTERACTIVE" = true ]; then
        ARGS+=("--non-interactive")
    fi
    ARGS+=("--skip-update")

    exec ./setup.sh "${ARGS[@]}"
fi

# 1. Determine if we are already inside a git clone of this repository
if [ -d ".git" ] && grep -q "private-ai-assistant" package.json 2>/dev/null; then
    TARGET_DIR="$(pwd)"
    TARGET_PARENT_DIR="$(dirname "$TARGET_DIR")"
    log "Detected execution from inside existing clone: $TARGET_DIR"
fi

# 2. Check and install system prerequisites if needed
log "Checking system prerequisites..."

# Verify Git
if ! command -v git &> /dev/null; then
    log "Git is not installed. Installing..."
    sudo apt-get update && sudo apt-get install -y git
else
    log "Git is installed."
fi

# Verify Node.js
if ! command -v node &> /dev/null; then
    log "Node.js is not installed. Installing Node.js (v25)..."
    curl -fsSL https://deb.nodesource.com/setup_25.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    NODE_VERSION=$(node -v | cut -d'v' -f2)
    NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d'.' -f1)
    log "Node.js v$NODE_VERSION is installed."
    if [ "$NODE_MAJOR" -lt 25 ]; then
        log "Node.js version is less than 25. Upgrading Node.js to v25..."
        curl -fsSL https://deb.nodesource.com/setup_25.x | sudo -E bash -
        sudo apt-get install -y nodejs
    fi
fi

# 3. Clone or Update the Project
if [ -d "$TARGET_DIR" ]; then
    log "Project directory exists at $TARGET_DIR. Performing update..."
    cd "$TARGET_DIR"
    
    # Check if there is a git remote first
    if [ "$SKIP_UPDATE" = false ] && git remote &> /dev/null; then
        log "Discarding any local changes and pulling latest updates from Github..."
        git checkout . || true
        git reset --hard || true
        git pull || true
    fi
else
    log "Project directory does not exist at $TARGET_DIR. Performing clean setup..."
    mkdir -p "$TARGET_PARENT_DIR"
    cd "$TARGET_PARENT_DIR"
    
    log "Cloning repository from $REPO_URL..."
    git clone "$REPO_URL"
    
    cd "$TARGET_DIR"
fi

# 4. Load existing defaults from .env and Database
DEFAULT_DEVICE_TYPE="linux"
DEFAULT_IS_MAIN_HOST="y"
DEFAULT_ADMIN_USER="admin"
DEFAULT_ADMIN_PASS="adminpassword"
DEFAULT_LOCAL_URL="http://localhost:1234/v1"
DEFAULT_LOCAL_KEY=""
DEFAULT_ONLINE_KEY=""
DEFAULT_ONLINE_PROVIDER="gemini"
DEFAULT_BUILD_FE="y"
DEFAULT_PORT="3000"
DEFAULT_MAIN_HOST_IP="uhrick-home.local"
DEFAULT_DB_PATH="backend/database.db"
DEFAULT_MQTT_BROKER_URL="mqtt://localhost:1883"
DEFAULT_MQTT_NODE_ID="windows-main"
DEFAULT_MQTT_USERNAME=""
DEFAULT_MQTT_PASSWORD=""
DEFAULT_TOOL_REGISTRY_LOCAL_PATH="./tool_registry"
DEFAULT_USER_NAME=""
DEFAULT_USER_ZIPCODE=""
DEFAULT_WEATHER_KEY=""
DEFAULT_IS_HOST="false"

if [ -f ".env" ]; then
    DEFAULT_PORT=$(grep -E "^PORT=" .env | cut -d'=' -f2 || echo "3000")
    DEFAULT_LOCAL_URL=$(grep -E "^LOCAL_LLM_URL=" .env | cut -d'=' -f2 || echo "http://localhost:1234/v1")
    DEFAULT_LOCAL_KEY=$(grep -E "^LOCAL_LLM_KEY=" .env | cut -d'=' -f2 || echo "")
    DEFAULT_ONLINE_KEY=$(grep -E "^GEMINI_API_KEY=" .env | cut -d'=' -f2 || echo "")
    DEFAULT_ONLINE_PROVIDER=$(grep -E "^ONLINE_PROVIDER=" .env | cut -d'=' -f2 || echo "gemini")
    DEFAULT_WEATHER_KEY=$(grep -E "^WEATHER_API_KEY=" .env | cut -d'=' -f2 || echo "")
    DEFAULT_MAIN_HOST_IP=$(grep -E "^MAIN_HOST_IP=" .env | cut -d'=' -f2 || echo "uhrick-home.local")
    DEFAULT_DB_PATH=$(grep -E "^DB_PATH=" .env | cut -d'=' -f2 || echo "backend/database.db")
    DEFAULT_MQTT_BROKER_URL=$(grep -E "^MQTT_BROKER_URL=" .env | cut -d'=' -f2 || echo "mqtt://localhost:1883")
    DEFAULT_MQTT_NODE_ID=$(grep -E "^MQTT_NODE_ID=" .env | cut -d'=' -f2 || echo "windows-main")
    DEFAULT_MQTT_USERNAME=$(grep -E "^MQTT_USERNAME=" .env | cut -d'=' -f2 || echo "")
    DEFAULT_MQTT_PASSWORD=$(grep -E "^MQTT_PASSWORD=" .env | cut -d'=' -f2 || echo "")
    DEFAULT_TOOL_REGISTRY_LOCAL_PATH=$(grep -E "^TOOL_REGISTRY_LOCAL_PATH=" .env | cut -d'=' -f2 || echo "./tool_registry")
    DEFAULT_IS_HOST=$(grep -E "^IS_HOST=" .env | cut -d'=' -f2 || echo "true")
    
    # Try to load existing settings from database using read_settings.js helper (to override .env defaults if DB is populated)
    if [ -d "backend/node_modules" ]; then
        db_settings=$(node backend/scripts/read_settings.js 2>/dev/null || echo "{}")
        if [ ! -z "$db_settings" ] && [ "$db_settings" != "{}" ]; then
            DEFAULT_ADMIN_USER=$(echo "$db_settings" | node -e "const fs = require('fs'); try { const d = JSON.parse(fs.readFileSync(0, 'utf-8')); console.log(d.username || 'admin'); } catch(e) { console.log('admin'); }")
            DEFAULT_DEVICE_TYPE=$(echo "$db_settings" | node -e "const fs = require('fs'); try { const d = JSON.parse(fs.readFileSync(0, 'utf-8')); console.log(d.device_type || 'linux'); } catch(e) { console.log('linux'); }")
            is_main=$(echo "$db_settings" | node -e "const fs = require('fs'); try { const d = JSON.parse(fs.readFileSync(0, 'utf-8')); console.log(d.is_main_host); } catch(e) { console.log('1'); }")
            if [ "$is_main" = "0" ]; then
                DEFAULT_IS_MAIN_HOST="n"
            else
                DEFAULT_IS_MAIN_HOST="y"
            fi
            DEFAULT_LOCAL_URL=$(echo "$db_settings" | node -e "const fs = require('fs'); try { const d = JSON.parse(fs.readFileSync(0, 'utf-8')); console.log(d.local_url || '$DEFAULT_LOCAL_URL'); } catch(e) { console.log('$DEFAULT_LOCAL_URL'); }")
            DEFAULT_LOCAL_KEY=$(echo "$db_settings" | node -e "const fs = require('fs'); try { const d = JSON.parse(fs.readFileSync(0, 'utf-8')); console.log(d.local_key || '$DEFAULT_LOCAL_KEY'); } catch(e) { console.log('$DEFAULT_LOCAL_KEY'); }")
            DEFAULT_ONLINE_PROVIDER=$(echo "$db_settings" | node -e "const fs = require('fs'); try { const d = JSON.parse(fs.readFileSync(0, 'utf-8')); console.log(d.online_provider || '$DEFAULT_ONLINE_PROVIDER'); } catch(e) { console.log('$DEFAULT_ONLINE_PROVIDER'); }")
            DEFAULT_ONLINE_KEY=$(echo "$db_settings" | node -e "const fs = require('fs'); try { const d = JSON.parse(fs.readFileSync(0, 'utf-8')); console.log(d.online_key || '$DEFAULT_ONLINE_KEY'); } catch(e) { console.log('$DEFAULT_ONLINE_KEY'); }")
            DEFAULT_USER_NAME=$(echo "$db_settings" | node -e "const fs = require('fs'); try { const d = JSON.parse(fs.readFileSync(0, 'utf-8')); console.log(d.name || ''); } catch(e) { console.log(''); }")
            DEFAULT_USER_ZIPCODE=$(echo "$db_settings" | node -e "const fs = require('fs'); try { const d = JSON.parse(fs.readFileSync(0, 'utf-8')); console.log(d.zipcode || ''); } catch(e) { console.log(''); }")
            DEFAULT_WEATHER_KEY=$(echo "$db_settings" | node -e "const fs = require('fs'); try { const d = JSON.parse(fs.readFileSync(0, 'utf-8')); console.log(d.weather_api_key || ''); } catch(e) { console.log(''); }")
        fi
    fi
fi

# 5. Configuration Settings
if [ "$NON_INTERACTIVE" = true ]; then
    log "Running in non-interactive mode. Utilizing existing configuration defaults."
    DEVICE_TYPE="$DEFAULT_DEVICE_TYPE"
    IS_HOST="$DEFAULT_IS_HOST"
    if [ "$DEFAULT_IS_MAIN_HOST" = "y" ]; then
        IS_MAIN_HOST="1"
    else
        IS_MAIN_HOST="0"
    fi
    MAIN_HOST_IP="$DEFAULT_MAIN_HOST_IP"
    ADMIN_USER="$DEFAULT_ADMIN_USER"
    ADMIN_PASS="$DEFAULT_ADMIN_PASS"
    LOCAL_URL="$DEFAULT_LOCAL_URL"
    LOCAL_KEY="$DEFAULT_LOCAL_KEY"
    ONLINE_KEY="$DEFAULT_ONLINE_KEY"
    USER_NAME="$DEFAULT_USER_NAME"
    USER_ZIPCODE="$DEFAULT_USER_ZIPCODE"
    WEATHER_KEY="$DEFAULT_WEATHER_KEY"
    BUILD_FE_YN="y"
    APP_PORT="$DEFAULT_PORT"
else
    echo -e "\n===================================================="
    echo "  Configuration Settings"
    echo "===================================================="
    echo "REQUIRED for PATTI to start at all:"
    echo "  - JWT_SECRET and DB_ENCRYPTION_SECRET (auto-generated below, no action needed)"
    echo "  - Admin Username / Password (used to log in to the web UI)"
    echo "  - Local LLM Base URL (where LM Studio/Ollama/etc is running)"
    echo "Everything else below is OPTIONAL - press Enter to accept the default or leave blank,"
    echo "and you can fill it in later from the Settings page in the app."
    echo ""

    if [ "$DEFAULT_IS_HOST" = "false" ]; then
        DEFAULT_IS_HOST_YN="n"
    else
        DEFAULT_IS_HOST_YN="y"
    fi
    read -p "Is this machine the host? (y/n) [${DEFAULT_IS_HOST_YN}]: " IS_HOST_YN
    IS_HOST_YN=${IS_HOST_YN:-$DEFAULT_IS_HOST_YN}
    if [[ "$IS_HOST_YN" =~ ^[Yy]$ ]]; then
        IS_HOST="true"
    else
        IS_HOST="false"
    fi

    # Device Type selection
    echo "Supported Device Types:"
    echo "  1) Windows"
    echo "  2) General Linux"
    echo "  3) Raspberry Pi 5 (8GB)"
    echo "  4) Raspberry Pi 5 (15GB/16GB)"
    echo "  5) Raspberry Pi 4"
    echo "  6) Raspberry Pi Zero 2W"
    echo "  7) ESP32 Node"
    read -p "Select your device type (current: ${DEFAULT_DEVICE_TYPE}): " DEV_CHOICE
    case $DEV_CHOICE in
        1) DEVICE_TYPE="windows" ;;
        2) DEVICE_TYPE="linux" ;;
        3) DEVICE_TYPE="rpi-5-8gb" ;;
        4) DEVICE_TYPE="rpi-5-16gb" ;;
        5) DEVICE_TYPE="rpi-4b-2gb" ;;
        6) DEVICE_TYPE="rpi-zero-2w" ;;
        7) DEVICE_TYPE="esp32" ;;
        *) DEVICE_TYPE="$DEFAULT_DEVICE_TYPE" ;;
    esac

    if [ "$IS_HOST" = "true" ]; then
        # Main Host role prompt
        read -p "Should this node act as a Main Host (runs LLMs, chat UI, etc)? (y/n) [${DEFAULT_IS_MAIN_HOST}]: " MAIN_HOST_YN
        MAIN_HOST_YN=${MAIN_HOST_YN:-$DEFAULT_IS_MAIN_HOST}
        if [[ "$MAIN_HOST_YN" =~ ^[Yy]$ ]]; then
            IS_MAIN_HOST="1"
        else
            IS_MAIN_HOST="0"
        fi

        MAIN_HOST_IP=""
        if [ "$IS_MAIN_HOST" = "0" ]; then
            read -p "Enter Main Host IP address (optional) [${DEFAULT_MAIN_HOST_IP}]: " MAIN_HOST_IP
            MAIN_HOST_IP=${MAIN_HOST_IP:-$DEFAULT_MAIN_HOST_IP}
        fi

        # Admin account registration
        read -p "Enter Admin Username [${DEFAULT_ADMIN_USER}]: " ADMIN_USER
        ADMIN_USER=${ADMIN_USER:-$DEFAULT_ADMIN_USER}

        read -p "Enter Admin Password [${DEFAULT_ADMIN_PASS}]: " ADMIN_PASS
        ADMIN_PASS=${ADMIN_PASS:-$DEFAULT_ADMIN_PASS}

        # User Profile Info
        read -p "Enter your Name [${DEFAULT_USER_NAME}]: " USER_NAME
        USER_NAME=${USER_NAME:-$DEFAULT_USER_NAME}

        read -p "Enter your Zipcode [${DEFAULT_USER_ZIPCODE}]: " USER_ZIPCODE
        USER_ZIPCODE=${USER_ZIPCODE:-$DEFAULT_USER_ZIPCODE}

        read -p "Enter OpenWeatherMap API Key (optional) [${DEFAULT_WEATHER_KEY}]: " WEATHER_KEY
        WEATHER_KEY=${WEATHER_KEY:-$DEFAULT_WEATHER_KEY}

        # Local LLM address
        read -p "Enter Local LLM Base URL [${DEFAULT_LOCAL_URL}]: " LOCAL_URL
        LOCAL_URL=${LOCAL_URL:-$DEFAULT_LOCAL_URL}

        # Optional Local API Key
        read -p "Enter Local LLM API Key (optional) [${DEFAULT_LOCAL_KEY}]: " LOCAL_KEY
        LOCAL_KEY=${LOCAL_KEY:-$DEFAULT_LOCAL_KEY}

        # Online Gemini Key (Optional)
        read -p "Enter Online Gemini API Key (optional) [${DEFAULT_ONLINE_KEY}]: " ONLINE_KEY
        ONLINE_KEY=${ONLINE_KEY:-$DEFAULT_ONLINE_KEY}

        # Deployment mode / Frontend compilation check
        read -p "Build React Frontend on this node? (y/n) [y]: " BUILD_FE_YN
        BUILD_FE_YN=${BUILD_FE_YN:-y}

        # Server port configuration
        read -p "Enter Server PORT [${DEFAULT_PORT}]: " APP_PORT
        APP_PORT=${APP_PORT:-$DEFAULT_PORT}
    else
        # Node Client Configuration
        read -p "Enter Main Host's IP address [${DEFAULT_MAIN_HOST_IP}]: " MAIN_HOST_IP
        MAIN_HOST_IP=${MAIN_HOST_IP:-$DEFAULT_MAIN_HOST_IP}
        APP_PORT="$DEFAULT_PORT"
        BUILD_FE_YN="n"
        IS_MAIN_HOST="0"
    fi
fi

# Create .env config file
log "Configuring environment variables (.env)..."
if [ ! -f ".env" ]; then
    cp .env.example .env
fi

write_env_var() {
    local key=$1
    local val=$2
    if grep -q "^${key}=" .env; then
        # Replace existing key (using | to handle URLs with slashes)
        sed -i "s|^${key}=.*|${key}=${val}|" .env
    else
        # Append new key
        echo "${key}=${val}" >> .env
    fi
}

write_env_var "PORT" "${APP_PORT}"
write_env_var "IS_HOST" "${IS_HOST:-true}"
write_env_var "DB_PATH" "${DEFAULT_DB_PATH}"
write_env_var "LOCAL_LLM_URL" "${LOCAL_URL}"
write_env_var "LOCAL_LLM_KEY" "${LOCAL_KEY}"
write_env_var "GEMINI_API_KEY" "${ONLINE_KEY}"
write_env_var "WEATHER_API_KEY" "${WEATHER_KEY}"
write_env_var "PREFERRED_LOCAL_MODEL" "qwen2.5-coder-7b-instruct"
write_env_var "PREFERRED_ONLINE_MODEL" "qwen2.5-coder-7b-instruct"
write_env_var "SUPERVISOR_MODEL" "qwen2.5-coder-7b-instruct"
if [ "$IS_MAIN_HOST" = "0" ]; then
    MQTT_BROKER_URL="mqtt://${MAIN_HOST_IP:-localhost}:1883"
    MQTT_NODE_ID=$(hostname 2>/dev/null || echo "field-node")
else
    MQTT_BROKER_URL="${DEFAULT_MQTT_BROKER_URL}"
    MQTT_NODE_ID="${DEFAULT_MQTT_NODE_ID}"
fi

write_env_var "MQTT_BROKER_URL" "${MQTT_BROKER_URL}"
write_env_var "MQTT_NODE_ID" "${MQTT_NODE_ID}"
write_env_var "MQTT_USERNAME" "${DEFAULT_MQTT_USERNAME}"
write_env_var "MQTT_PASSWORD" "${DEFAULT_MQTT_PASSWORD}"
write_env_var "TOOL_REGISTRY_LOCAL_PATH" "${DEFAULT_TOOL_REGISTRY_LOCAL_PATH}"
if [ "$IS_MAIN_HOST" = "0" ]; then
    write_env_var "MAIN_HOST_IP" "${MAIN_HOST_IP}"
fi

if [[ "$BUILD_FE_YN" =~ ^[Yy]$ ]]; then
    sed -i "s/^DEPLOY_MODE=.*/# DEPLOY_MODE=backend-only/" .env
    DEPLOY_MODE=""
else
    if grep -q "DEPLOY_MODE" .env; then
        sed -i "s/^#\?\s*DEPLOY_MODE=.*/DEPLOY_MODE=backend-only/" .env
    else
        echo "DEPLOY_MODE=backend-only" >> .env
    fi
    DEPLOY_MODE="backend-only"
fi

# Generate strong random values for the two secrets the server refuses to start without
# (backend/middleware/auth.js and backend/utils/crypto.js both hard-exit if these are
# unset in production). Replaces whatever placeholder value is currently set - matches
# on a "placeholder_" prefix or an empty value rather than one exact hardcoded string, so
# this keeps working even if .env.example's placeholder text changes later.
set_random_secret_if_placeholder() {
    local key=$1
    local current_val
    current_val=$(grep -E "^${key}=" .env | cut -d'=' -f2- || echo "")
    if [ -z "$current_val" ] || [[ "$current_val" == placeholder_* ]]; then
        local new_secret
        new_secret=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
        sed -i "s|^${key}=.*|${key}=${new_secret}|" .env
        log "Generated a new random ${key}."
    fi
}

set_random_secret_if_placeholder "JWT_SECRET"
set_random_secret_if_placeholder "DB_ENCRYPTION_SECRET"

if [ "$IS_HOST" = "true" ]; then
    # 6. Install Dependencies
    if [ "$SKIP_UPDATE" = false ]; then
        log "Installing project dependencies (this may take a few minutes)..."
        npm run install:all
    else
        log "Skipping project dependencies install since it was completed during the update phase."
    fi

    # 7. Database Initialization & Seeding
    RESET_DB=false
    if [ "$NON_INTERACTIVE" = false ]; then
        read -p "Do you want to reset the database and start fresh (deletes all users)? (y/n) [n]: " RESET_DB_YN
        RESET_DB_YN=${RESET_DB_YN:-n}
        if [[ "$RESET_DB_YN" =~ ^[Yy]$ ]]; then
            RESET_DB=true
        fi
    fi

    if [ "$RESET_DB" = true ]; then
        log "Wiping existing database for a fresh setup..."
        rm -f backend/database.db backend/database.db-wal backend/database.db-shm
    fi

    log "Initializing database and seeding configuration..."
    node backend/scripts/seed_settings.js \
        --username="$ADMIN_USER" \
        --password="$ADMIN_PASS" \
        --device_type="$DEVICE_TYPE" \
        --is_main_host="$IS_MAIN_HOST" \
        --local_url="$LOCAL_URL" \
        --local_key="$LOCAL_KEY" \
        --online_key="$ONLINE_KEY" \
        --online_provider="$DEFAULT_ONLINE_PROVIDER" \
        --name="$USER_NAME" \
        --zipcode="$USER_ZIPCODE" \
        --weather_api_key="$WEATHER_KEY"

    # 8. Build Frontend (if requested)
    if [[ "$BUILD_FE_YN" =~ ^[Yy]$ ]]; then
        log "Building frontend application..."
        npm run build
    else
        log "Skipping frontend compilation (backend-only deployment)."
    fi
else
    # Install Node Client dependencies
    if [ "$SKIP_UPDATE" = false ] || [ ! -d "node_client/node_modules/express" ]; then
        log "Installing minimal Node Client dependencies..."
        mkdir -p node_client
        cat << 'EOF' > node_client/package.json
{
  "name": "private-ai-node-client",
  "version": "1.0.0",
  "dependencies": {
    "mqtt": "^5.5.0",
    "dotenv": "^16.4.5",
    "macaddress": "^0.2.9",
    "express": "^4.19.2"
  }
}
EOF
        npm install --prefix node_client
    else
        log "Skipping Node Client dependency install."
    fi
fi

# 8.5. Configure Tailscale HTTPS (Optional)
if command -v tailscale &> /dev/null; then
    if tailscale status &> /dev/null; then
        TS_DNS_NAME=$(tailscale status --json | grep -o '"DNSName": "[^"]*"' | head -n1 | cut -d'"' -f4 | sed 's/\.$//' || true)
        if [ -n "$TS_DNS_NAME" ]; then
            log "Tailscale connection detected. MagicDNS name: $TS_DNS_NAME"
            log "Attempting to retrieve SSL/TLS certificate from Tailscale..."
            mkdir -p backend/certs
            if tailscale cert --cert-file backend/certs/tailscale.crt --key-file backend/certs/tailscale.key "$TS_DNS_NAME" &> /dev/null || \
               sudo tailscale cert --cert-file backend/certs/tailscale.crt --key-file backend/certs/tailscale.key "$TS_DNS_NAME" &> /dev/null; then
                log_success "Successfully retrieved and configured Tailscale HTTPS certificates!"
                sudo chmod 600 backend/certs/tailscale.key &>/dev/null || chmod 600 backend/certs/tailscale.key &>/dev/null || true
                sudo chmod 644 backend/certs/tailscale.crt &>/dev/null || chmod 644 backend/certs/tailscale.crt &>/dev/null || true
            else
                log_warn "Could not retrieve Tailscale certificate. Ensure 'Enable HTTPS' is toggled in Tailscale Admin DNS settings."
            fi
        fi
    fi
fi

# 9. Setup systemd Service (if not Windows/ESP32 choice)
if [ "$DEVICE_TYPE" != "windows" ] && [ "$DEVICE_TYPE" != "esp32" ]; then
    if command -v systemctl &> /dev/null && [ "$(id -u)" -eq 0 -o -n "$(command -v sudo)" ]; then
        log "Configuring systemd background service..."
        NODE_PATH=$(which node || echo "/usr/bin/node")

        if [ "$IS_HOST" = "true" ]; then
            SERVICE_DESC="Private AI Assistant Service"
            START_CMD="$(which npm || echo "/usr/bin/npm") start"
        else
            SERVICE_DESC="Private AI Node Edge Client"
            START_CMD="$NODE_PATH node_client/client.js"
        fi

        # Create or overwrite systemd service file
        sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=$SERVICE_DESC
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$TARGET_DIR
ExecStart=$START_CMD
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

        log "Reloading systemd daemon..."
        sudo systemctl daemon-reload

        log "Enabling $SERVICE_NAME service to start on boot..."
        sudo systemctl enable "$SERVICE_NAME".service

        log "Restarting $SERVICE_NAME service..."
        sudo systemctl restart "$SERVICE_NAME".service

        # Verify status
        if sudo systemctl is-active --quiet "$SERVICE_NAME".service; then
            log_success "$SERVICE_DESC is running in the background!"
            log "Check status: sudo systemctl status $SERVICE_NAME"
            log "Check logs: journalctl -u $SERVICE_NAME -f"
        else
            log_error "Failed to start $SERVICE_NAME service. Please check systemctl logs."
        fi
    else
        log_warn "systemd not available or sudo permissions missing. Starting process in background via nohup fallback..."
        
        if [ "$IS_HOST" = "true" ]; then
            # Stop any existing process running on the port
            if command -v lsof &> /dev/null; then
                PORT_PID=$(lsof -t -i:"$APP_PORT" -sTCP:LISTEN || true)
                if [ -n "$PORT_PID" ]; then
                    log "Stopping existing process $PORT_PID on port $APP_PORT..."
                    kill -9 "$PORT_PID"
                    sleep 2
                fi
            fi
            nohup npm start > /dev/null 2>&1 &
        else
            nohup node node_client/client.js > /dev/null 2>&1 &
        fi
        log_success "Successfully started the background application process."
    fi
fi

echo -e "\n===================================================="
echo "  Setup Completed Successfully!"
echo "===================================================="
echo "Device Type : $DEVICE_TYPE"
echo "Is Host     : $IS_HOST"
if [ "$IS_HOST" = "true" ]; then
    echo "Main Host   : $IS_MAIN_HOST"
    echo "Port        : $APP_PORT"
    echo "Build UI    : $BUILD_FE_YN"
else
    echo "Main Host IP: $MAIN_HOST_IP"
fi
echo "===================================================="
