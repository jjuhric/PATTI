[CmdletBinding()]
param (
    [switch]$NonInteractive,
    [switch]$SkipUpdate
)

# Windows Setup & Update Script for Private AI Assistant
# Requires PowerShell 5.1 or higher

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "  Private AI Assistant Windows Setup Utility V4.8.0 " -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

# 1. Helper function for logs
function Write-Log ($Msg, $Color = "White") {
    Write-Host "`n[INFO] $Msg" -ForegroundColor $Color
}

$EnvPath = "backend\.env"
if (-not (Test-Path $EnvPath)) {
    Write-Host "⚠️ Warning: Environment file [.env] not detected in target project root path mappings." -ForegroundColor Yellow
    $Choice = Read-Host "Would you like to provision missing initial environment context keys right now? (y/N)"
    
    if ($Choice -eq "y" -or $Choice -eq "Y") {
        Copy-Item "backend\.env.example" $EnvPath
        $NodeName = Read-Host "Enter descriptive uniqueness text profile name for this machine registry key"
        (Get-Content $EnvPath) -replace 'NODE_NAME=.*', "NODE_NAME=$NodeName" | Set-Content $EnvPath
        Write-Host "✅ Configuration initialized successfully." -ForegroundColor Green
    } else {
        Write-Host "💡 Note: You can complete missing properties using the Setup Wizard layout directly in-app." -ForegroundColor Blue
    }
}

# Update check: If already setup, treat as update
if (-not $SkipUpdate -and (Test-Path ".env")) {
    Write-Log "Existing setup detected (.env file exists). Treating as an update..." "Yellow"

    # Stop existing process listening on port before running npm install
    $envLines = Get-Content ".env"
    $port = "3000"
    foreach ($line in $envLines) {
        if ($line -match "^PORT=(.*)") { $port = $Matches[1].Trim() }
    }
    $proc = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc) {
        $pidToKill = $proc.OwningProcess
        Write-Log "Stopping existing process $pidToKill on port $port to release file locks..." "Yellow"
        Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
    }
    # Stop Vite dev server listening on port 5173
    $viteProc = Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($viteProc) {
        $pidToKill = $viteProc.OwningProcess
        Write-Log "Stopping Vite development server process $pidToKill on port 5173 to release file locks..." "Yellow"
        Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 1
    
    # Verify Git
    $gitCheck = Get-Command git -ErrorAction SilentlyContinue
    if (-not $gitCheck) {
        Write-Host "[ERROR] Git is not installed. Unable to pull updates." -ForegroundColor Red
    } else {
        if (Test-Path ".git") {
            Write-Log "Discarding any local changes and pulling latest updates from git..." "Cyan"
            & git checkout .
            & git reset --hard
            & git pull
            if ($LASTEXITCODE -ne 0) {
                Write-Host "⚠️ Warning: git pull failed (exit code $LASTEXITCODE). Continuing setup anyway..." -ForegroundColor Yellow
            }
        }
    }

    # Fresh npm install
    Write-Log "Removing existing node_modules directories for a fresh installation..." "Cyan"
    $modulePaths = @("node_modules", "backend/node_modules", "frontend/node_modules")
    foreach ($path in $modulePaths) {
        if (Test-Path $path) {
            Write-Log "Deleting $path..." "Gray"
            cmd.exe /c "rmdir /s /q `"$path`""
            if (Test-Path $path) {
                Remove-Item -Path $path -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }

    Write-Log "Installing all dependencies fresh..." "Cyan"
    & npm run install:all

    # Re-run setup.ps1 with -SkipUpdate to complete the setup process
    Write-Log "Re-running setup.ps1 to apply configurations and rebuild..." "Cyan"
    $params = @()
    if ($NonInteractive) { $params += "-NonInteractive" }
    $params += "-SkipUpdate"

    & powershell.exe -File .\setup.ps1 $params
    Exit $LASTEXITCODE
}

# 2. Check Prerequisites
Write-Log "Checking system prerequisites..."

# Verify Git
$gitCheck = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCheck) {
    Write-Host "[ERROR] Git is not installed on this system. Please install Git for Windows (https://git-scm.com/) and run this setup again." -ForegroundColor Red
    Exit 1
} else {
    Write-Log "Git is installed." "Green"
}

# Verify Node.js
$nodeCheck = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCheck) {
    Write-Host "[ERROR] Node.js is not installed on this system. Please install Node.js v25+ (https://nodejs.org/) and run this setup again." -ForegroundColor Red
    Exit 1
} else {
    $nodeVer = & node -v
    Write-Log "Node.js $nodeVer is installed." "Green"
}

# 3. Pull latest git changes if in a repo clone
if (-not $SkipUpdate -and (Test-Path ".git")) {
    Write-Log "Repository detected. Discarding local changes and fetching latest commits..."
    & git checkout .
    & git reset --hard
    & git pull
    if ($LASTEXITCODE -ne 0) {
        Write-Host "⚠️ Warning: git pull failed (exit code $LASTEXITCODE). Continuing setup anyway..." -ForegroundColor Yellow
    }
}

# 4. Load existing defaults from .env and Database
$defaultDeviceType = "windows"
$defaultIsMainHostYN = "y"
$defaultAdminUser = "admin"
$defaultAdminPass = "adminpassword"
$defaultLocalUrl = "http://localhost:1234/v1"
$defaultLocalKey = ""
$defaultOnlineKey = ""
$defaultOnlineProvider = "gemini"
$defaultBuildFe = "y"
$defaultPort = "3000"
$defaultMainHostIp = "uhrick-home.local"
$defaultDbPath = "backend/database.db"
$defaultMqttBrokerUrl = "mqtt://localhost:1883"
$defaultMqttNodeId = "windows-main"
$defaultMqttUsername = ""
$defaultMqttPassword = ""
$defaultToolRegistryLocalPath = "./tool_registry"
$defaultUserName = ""
$defaultUserZipcode = ""
$defaultWeatherKey = ""
$defaultIsHost = "true"

if (Test-Path ".env") {
    $envLines = Get-Content ".env"
    foreach ($line in $envLines) {
        if ($line -match "^PORT=(.+)") { $defaultPort = $Matches[1].Trim() }
        if ($line -match "^IS_HOST=(.+)") { $defaultIsHost = $Matches[1].Trim() }
        if ($line -match "^LOCAL_LLM_URL=(.*)") { $defaultLocalUrl = $Matches[1].Trim() }
        if ($line -match "^LOCAL_LLM_KEY=(.*)") { $defaultLocalKey = $Matches[1].Trim() }
        if ($line -match "^GEMINI_API_KEY=(.*)") { $defaultOnlineKey = $Matches[1].Trim() }
        if ($line -match "^WEATHER_API_KEY=(.*)") { $defaultWeatherKey = $Matches[1].Trim() }
        if ($line -match "^ONLINE_PROVIDER=(.*)") { $defaultOnlineProvider = $Matches[1].Trim() }
        if ($line -match "^MAIN_HOST_IP=(.*)") { $defaultMainHostIp = $Matches[1].Trim() }
        if ($line -match "^DB_PATH=(.*)") { $defaultDbPath = $Matches[1].Trim() }
        if ($line -match "^MQTT_BROKER_URL=(.*)") { $defaultMqttBrokerUrl = $Matches[1].Trim() }
        if ($line -match "^MQTT_NODE_ID=(.*)") { $defaultMqttNodeId = $Matches[1].Trim() }
        if ($line -match "^MQTT_USERNAME=(.*)") { $defaultMqttUsername = $Matches[1].Trim() }
        if ($line -match "^MQTT_PASSWORD=(.*)") { $defaultMqttPassword = $Matches[1].Trim() }
        if ($line -match "^TOOL_REGISTRY_LOCAL_PATH=(.*)") { $defaultToolRegistryLocalPath = $Matches[1].Trim() }
    }
    
    if (Test-Path "backend/node_modules") {
        $dbSettingsJson = & node backend/scripts/read_settings.js *>$null
        if ($dbSettingsJson -and $dbSettingsJson -ne "{}") {
            try {
                $dbSettings = ConvertFrom-Json $dbSettingsJson
                if ($dbSettings.username) { $defaultAdminUser = $dbSettings.username }
                if ($dbSettings.device_type) { $defaultDeviceType = $dbSettings.device_type }
                if ($dbSettings.is_main_host -eq 0) { $defaultIsMainHostYN = "n" }
                if ($dbSettings.local_url) { $defaultLocalUrl = $dbSettings.local_url }
                if ($dbSettings.local_key) { $defaultLocalKey = $dbSettings.local_key }
                if ($dbSettings.online_provider) { $defaultOnlineProvider = $dbSettings.online_provider }
                if ($dbSettings.online_key) { $defaultOnlineKey = $dbSettings.online_key }
                if ($dbSettings.name) { $defaultUserName = $dbSettings.name }
                if ($dbSettings.zipcode) { $defaultUserZipcode = $dbSettings.zipcode }
                if ($dbSettings.weather_api_key) { $defaultWeatherKey = $dbSettings.weather_api_key }
            } catch {}
        }
    }
}

# 5. Configuration Settings
if ($NonInteractive) {
    Write-Log "Running in non-interactive mode. Utilizing configuration defaults." "Yellow"
    $deviceType = $defaultDeviceType
    $isMainHost = if ($defaultIsMainHostYN -eq "y") { "1" } else { "0" }
    $isHost = $defaultIsHost
    $mainHostIp = $defaultMainHostIp
    $adminUser = $defaultAdminUser
    $adminPass = $defaultAdminPass
    $localUrl = $defaultLocalUrl
    $localKey = $defaultLocalKey
    $onlineKey = $defaultOnlineKey
    $userName = $defaultUserName
    $userZipcode = $defaultUserZipcode
    $weatherKey = $defaultWeatherKey
    $buildFeYN = "y"
    $appPort = $defaultPort
} else {
    Write-Host "`n====================================================" -ForegroundColor Cyan
    Write-Host "  Configuration Settings" -ForegroundColor Cyan
    Write-Host "====================================================" -ForegroundColor Cyan
    Write-Host "REQUIRED for PATTI to start at all:" -ForegroundColor Yellow
    Write-Host "  - JWT_SECRET and DB_ENCRYPTION_SECRET (auto-generated below, no action needed)" -ForegroundColor Yellow
    Write-Host "  - Admin Username / Password (used to log in to the web UI)" -ForegroundColor Yellow
    Write-Host "  - Local LLM Base URL (where LM Studio/Ollama/etc is running)" -ForegroundColor Yellow
    Write-Host "Everything else below is OPTIONAL - press Enter to accept the default or leave blank," -ForegroundColor Yellow
    Write-Host "and you can fill it in later from the Settings page in the app.`n" -ForegroundColor Yellow

    $isHostDefaultStr = if ($defaultIsHost -eq "false") { "n" } else { "y" }
    $isHostYN = Read-Host "Is this machine the host? (y/n) [$isHostDefaultStr]"
    if ([string]::IsNullOrWhiteSpace($isHostYN)) { $isHostYN = $isHostDefaultStr }
    $isHost = "true"
    if ($isHostYN -eq "n" -or $isHostYN -eq "N") {
        $isHost = "false"
    }

    $deviceType = Read-Host "Enter Device Type (windows, linux, rpi-5-8gb, rpi-5-16gb, rpi-zero-2w, esp32) [$defaultDeviceType]"
    if ([string]::IsNullOrWhiteSpace($deviceType)) { $deviceType = $defaultDeviceType }

    if ($isHost -eq "true") {
        $isMainHostYN = Read-Host "Should this node act as a Main Host (runs LLMs, chat UI, etc)? (y/n) [$defaultIsMainHostYN]"
        if ([string]::IsNullOrWhiteSpace($isMainHostYN)) { $isMainHostYN = $defaultIsMainHostYN }
        $isMainHost = "0"
        if ($isMainHostYN -eq "y" -or $isMainHostYN -eq "Y") {
            $isMainHost = "1"
        }

        $mainHostIp = ""
        if ($isMainHost -eq "0") {
            $mainHostIp = Read-Host "Enter Main Host IP address (optional) [$defaultMainHostIp]"
            if ([string]::IsNullOrWhiteSpace($mainHostIp)) { $mainHostIp = $defaultMainHostIp }
        }

        $adminUser = Read-Host "Enter Admin Username [$defaultAdminUser]"
        if ([string]::IsNullOrWhiteSpace($adminUser)) { $adminUser = $defaultAdminUser }

        $adminPass = Read-Host "Enter Admin Password [$defaultAdminPass]"
        if ([string]::IsNullOrWhiteSpace($adminPass)) { $adminPass = $defaultAdminPass }

        # User Profile Info
        $userName = Read-Host "Enter your Name [$defaultUserName]"
        if ([string]::IsNullOrWhiteSpace($userName)) { $userName = $defaultUserName }

        $userZipcode = Read-Host "Enter your Zipcode [$defaultUserZipcode]"
        if ([string]::IsNullOrWhiteSpace($userZipcode)) { $userZipcode = $defaultUserZipcode }

        $weatherKey = Read-Host "Enter OpenWeatherMap API Key (optional) [$defaultWeatherKey]"
        if ([string]::IsNullOrWhiteSpace($weatherKey)) { $weatherKey = $defaultWeatherKey }

        # Local LLM address
        $localUrl = Read-Host "Enter Local LLM Base URL [$defaultLocalUrl]"
        if ([string]::IsNullOrWhiteSpace($localUrl)) { $localUrl = $defaultLocalUrl }

        # Optional Local API Key
        $localKey = Read-Host "Enter Local LLM API Key (optional) [$defaultLocalKey]"
        if ([string]::IsNullOrWhiteSpace($localKey)) { $localKey = $defaultLocalKey }

        # Online Gemini Key (Optional)
        $onlineKey = Read-Host "Enter Online Gemini API Key (optional) [$defaultOnlineKey]"
        if ([string]::IsNullOrWhiteSpace($onlineKey)) { $onlineKey = $defaultOnlineKey }

        $buildFeYN = Read-Host "Build React Frontend on this node? (y/n) [y]"
        if ([string]::IsNullOrWhiteSpace($buildFeYN)) { $buildFeYN = "y" }

        $appPort = Read-Host "Enter Server PORT [$defaultPort]"
        if ([string]::IsNullOrWhiteSpace($appPort)) { $appPort = $defaultPort }
    } else {
        # Node Client Configuration
        $mainHostIp = Read-Host "Enter Main Host's IP address [$defaultMainHostIp]"
        if ([string]::IsNullOrWhiteSpace($mainHostIp)) { $mainHostIp = $defaultMainHostIp }
        $appPort = $defaultPort
        $buildFeYN = "n"
        $isMainHost = "0"
    }
}

# 6. Create or Configure .env
Write-Log "Writing configuration to .env file..."
if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
}

# 6. Create or Configure .env
Write-Log "Writing configuration to .env file..."
if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
}

# Helper to write/update key-value pair in .env
function Write-EnvVar ($Key, $Val) {
    $envPath = ".env"
    $lines = Get-Content $envPath
    $found = $false
    for ($i=0; $i -lt $lines.Length; $i++) {
        if ($lines[$i] -match "^$Key=") {
            $lines[$i] = "$Key=$Val"
            $found = $true
            break
        }
    }
    if (-not $found) {
        $lines += "$Key=$Val"
    }
    Set-Content -Path $envPath -Value $lines
}

Write-EnvVar "PORT" $appPort
Write-EnvVar "IS_HOST" $isHost
Write-EnvVar "DB_PATH" $defaultDbPath
Write-EnvVar "LOCAL_LLM_URL" $localUrl
Write-EnvVar "LOCAL_LLM_KEY" $localKey
Write-EnvVar "GEMINI_API_KEY" $onlineKey
Write-EnvVar "WEATHER_API_KEY" $weatherKey
Write-EnvVar "PREFERRED_LOCAL_MODEL" "qwen2.5-coder-7b-instruct"
Write-EnvVar "PREFERRED_ONLINE_MODEL" "qwen2.5-coder-7b-instruct"
Write-EnvVar "SUPERVISOR_MODEL" "qwen2.5-coder-7b-instruct"
if ($isMainHost -eq "0") {
    $mqttBrokerUrl = "mqtt://${mainHostIp}:1883"
    $mqttNodeId = $env:COMPUTERNAME.ToLower()
    if ([string]::IsNullOrWhiteSpace($mqttNodeId)) { $mqttNodeId = "field-node" }
} else {
    $mqttBrokerUrl = $defaultMqttBrokerUrl
    $mqttNodeId = $defaultMqttNodeId
}

Write-EnvVar "MQTT_BROKER_URL" $mqttBrokerUrl
Write-EnvVar "MQTT_NODE_ID" $mqttNodeId
Write-EnvVar "MQTT_USERNAME" $defaultMqttUsername
Write-EnvVar "MQTT_PASSWORD" $defaultMqttPassword
Write-EnvVar "TOOL_REGISTRY_LOCAL_PATH" $defaultToolRegistryLocalPath
if ($isMainHost -eq "0") {
    Write-EnvVar "MAIN_HOST_IP" $mainHostIp
}

# Read env content
$envContent = Get-Content ".env" -Raw

if ($buildFeYN -eq "y" -or $buildFeYN -eq "Y") {
    $envContent = $envContent -replace "DEPLOY_MODE=backend-only", "# DEPLOY_MODE=backend-only"
} else {
    $envContent = $envContent -replace "#\s*DEPLOY_MODE=backend-only", "DEPLOY_MODE=backend-only"
    $envContent = $envContent -replace "DEPLOY_MODE=backend-only", "DEPLOY_MODE=backend-only"
}

# Save env file
Set-Content -Path ".env" -Value $envContent

# Generate strong random values for the two secrets the server refuses to start without
# (backend/middleware/auth.js and backend/utils/crypto.js both hard-exit if these are
# unset in production). Replaces whatever placeholder value is currently set - matches
# on a "placeholder_" prefix or an empty value rather than one exact hardcoded string, so
# this keeps working even if .env.example's placeholder text changes later.
function New-RandomSecret {
    $bytes = New-Object Byte[] 32
    $rand = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rand.GetBytes($bytes)
    $rand.Dispose()
    return ($bytes | ForEach-Object { "{0:x2}" -f $_ }) -join ""
}

function Set-RandomSecretIfPlaceholder ($Key) {
    $lines = Get-Content ".env"
    for ($i = 0; $i -lt $lines.Length; $i++) {
        if ($lines[$i] -match "^$Key=(.*)$") {
            $currentVal = $Matches[1].Trim()
            if ($currentVal -eq "" -or $currentVal -like "placeholder_*") {
                $lines[$i] = "$Key=$(New-RandomSecret)"
                Write-Log "Generated a new random $Key." "Green"
            }
            break
        }
    }
    Set-Content -Path ".env" -Value $lines
}

Set-RandomSecretIfPlaceholder "JWT_SECRET"
Set-RandomSecretIfPlaceholder "DB_ENCRYPTION_SECRET"

if ($isHost -eq "true") {
    # 7. Install Dependencies (Host)
    if (-not $SkipUpdate) {
        Write-Log "Installing NPM dependencies (this might take a few minutes)..."
        & npm run install:all
    } else {
        Write-Log "Skipping NPM dependencies install since it was completed during the update phase." "Green"
    }

    # 8. Database Seeding
    $resetDb = $false
    if (-not $NonInteractive) {
        $resetDbYN = Read-Host "Do you want to reset the database and start fresh (deletes all users)? (y/n) [n]"
        if ($resetDbYN -eq "y" -or $resetDbYN -eq "Y") {
            $resetDb = $true
        }
    }

    if ($resetDb) {
        Write-Log "Wiping existing database for a fresh setup..." "Yellow"
        $dbPath = "backend/database.db"
        foreach ($suffix in ("", "-wal", "-shm")) {
            $file = $dbPath + $suffix
            if (Test-Path $file) {
                Remove-Item $file -Force -ErrorAction SilentlyContinue
            }
        }
    }

    Write-Log "Seeding local database..."
    $seedCmd = "backend/scripts/seed_settings.js"
    & node $seedCmd `
        --username="$adminUser" `
        --password="$adminPass" `
        --device_type="$deviceType" `
        --is_main_host="$isMainHost" `
        --local_url="$localUrl" `
        --local_key="$localKey" `
        --online_key="$onlineKey" `
        --online_provider="$defaultOnlineProvider" `
        --name="$userName" `
        --zipcode="$userZipcode" `
        --weather_api_key="$weatherKey"

    # 9. Build Frontend
    if ($buildFeYN -eq "y" -or $buildFeYN -eq "Y") {
        Write-Log "Compiling frontend assets..."
        & npm run build
    } else {
        Write-Log "Skipped frontend compilation (backend-only deployment mode)."
    }
} else {
    # 7. Install Dependencies (Lightweight Node Client)
    if (-not $SkipUpdate) {
        Write-Log "Installing minimal Node Client dependencies..."
        if (-not (Test-Path "node_client")) {
            New-Item -ItemType Directory -Path "node_client" | Out-Null
        }
        if (-not (Test-Path "node_client/package.json")) {
            $clientPkgJson = @'
{
  "name": "private-ai-node-client",
  "version": "1.0.0",
  "dependencies": {
    "mqtt": "^5.5.0",
    "dotenv": "^16.4.5",
    "macaddress": "^0.2.9"
  }
}
'@
            Set-Content -Path "node_client/package.json" -Value $clientPkgJson
        }
        & npm install --prefix node_client
    } else {
        Write-Log "Skipping Node Client dependency install." "Green"
    }
}

# 10. Register Startup Task
Write-Log "Configuring Windows background service..."
$scriptRoot = Resolve-Path "."
$taskName = "PrivateAI-Assistant"
$taskStarted = $false

try {
    # Stop existing scheduled task if running
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

    $nodePath = (Get-Command node).Source
    $targetScript = if ($isHost -eq "true") { "backend/server.js" } else { "node_client/client.js" }
    
    # Dynamically generate run-background.vbs with absolute node path to avoid path resolution issues
    $vbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = scriptDir
Do
  WshShell.Run """$nodePath"" $targetScript", 0, true
  WScript.Sleep 5000
Loop
"@
    [System.IO.File]::WriteAllText("$scriptRoot\run-background.vbs", $vbsContent)

    if ($isHost -eq "true") {
        # Stop any existing process running on the port before registering/starting
        $portProcess = Get-NetTCPConnection -LocalPort $appPort -State Listen -ErrorAction SilentlyContinue
        if ($portProcess) {
            $procId = $portProcess.OwningProcess
            Write-Log "Stopping existing process $procId on port $appPort..." "Yellow"
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
    }

    # Register Scheduled Task
    $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$scriptRoot\run-background.vbs`""
    $trigger = New-ScheduledTaskTrigger -AtLogon
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    
    $desc = if ($isHost -eq "true") { "Private AI Assistant Background Web Server" } else { "Private AI Node Edge Client" }
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description $desc -Force | Out-Null
    Write-Log "Successfully registered/updated background scheduled task '$taskName' to run on Logon." "Green"

    # Start Scheduled Task
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    Write-Log "Successfully started the background scheduled task '$taskName'." "Green"
    $taskStarted = $true

} catch {
    Write-Log "Failed to register or start Scheduled Tasks: $_" "Yellow"
}

if (-not $taskStarted) {
    Write-Log "Falling back to starting application directly in background..." "Yellow"
    
    if ($isHost -eq "true") {
        # Stop any existing process running on the port
        $portProcess = Get-NetTCPConnection -LocalPort $appPort -State Listen -ErrorAction SilentlyContinue
        if ($portProcess) {
            $procId = $portProcess.OwningProcess
            Write-Log "Stopping existing process $procId on port $appPort..." "Yellow"
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
    }

    # Dynamically generate run-background.vbs with absolute node path if not already done
    $nodePath = (Get-Command node).Source
    $targetScript = if ($isHost -eq "true") { "backend/server.js" } else { "node_client/client.js" }
    $vbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = scriptDir
Do
  WshShell.Run """$nodePath"" $targetScript", 0, true
  WScript.Sleep 5000
Loop
"@
    [System.IO.File]::WriteAllText("$scriptRoot\run-background.vbs", $vbsContent)

    # Fallback to direct hidden wscript process
    Start-Process "wscript.exe" -ArgumentList "run-background.vbs" -WorkingDirectory $scriptRoot
    Write-Log "Successfully started the background application process directly." "Green"
}

Write-Host "`n====================================================" -ForegroundColor Green
Write-Host "  Setup Completed Successfully!" -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Green
Write-Host "Device Type : $deviceType" -ForegroundColor Green
Write-Host "Is Host     : $isHost" -ForegroundColor Green
if ($isHost -eq "true") {
    Write-Host "Main Host   : $isMainHost" -ForegroundColor Green
    Write-Host "PORT        : $appPort" -ForegroundColor Green
    Write-Host "Build UI    : $buildFeYN" -ForegroundColor Green
} else {
    Write-Host "Main Host IP: $mainHostIp" -ForegroundColor Green
}
Write-Host "====================================================" -ForegroundColor Green
