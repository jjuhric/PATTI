# SEC-7 (docs/REVIEW_2026-08-03.md): flips the local Mosquitto broker from allow_anonymous to
# requiring a username/password, and updates this Host's own .env so the PATTI backend
# authenticates too. Deliberately NOT run automatically by any other script or on install -
# run this by hand, only when you're ready to also update every already-deployed field device,
# since anything still using stale/no credentials will fail to reconnect the moment this lands:
#   - RPi/Linux node_client instances: SSH in, set MQTT_USERNAME/MQTT_PASSWORD in their own
#     .env to match what this script writes below (check this Host's own .env after running),
#     then `sudo systemctl restart patti-node`.
#   - ESP32 boards: no remote update path exists. Edit MQTT_USER/MQTT_PASS in
#     esp32_firmware/main.py to match, then reflash via Thonny. They will NOT reconnect until
#     this is done by hand, per board.
#
# Usage: powershell -ExecutionPolicy Bypass -File backend\scripts\enable_mqtt_auth.ps1
# Optional: -Username <name> to override the default "patti" username.

param(
  [string]$Username = "patti",
  [string]$MosquittoDir = "C:\Program Files\mosquitto"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$confPath = Join-Path $MosquittoDir "mosquitto.conf"
$passwdExe = Join-Path $MosquittoDir "mosquitto_passwd.exe"
$pwdFilePath = Join-Path $MosquittoDir "passwordfile"
$envPath = Join-Path $RepoRoot ".env"

if (-not (Test-Path $confPath)) {
  throw "mosquitto.conf not found at $confPath - pass -MosquittoDir if Mosquitto is installed elsewhere."
}
if (-not (Test-Path $passwdExe)) {
  throw "mosquitto_passwd.exe not found at $passwdExe."
}
if (-not (Test-Path $envPath)) {
  throw ".env not found at $envPath - run this from a checked-out PATTI install with an existing .env."
}

Write-Output "Generating a new random MQTT password..."
$bytes = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$password = [Convert]::ToBase64String($bytes) -replace '[+/=]', ''

Write-Output "Writing Mosquitto password file for user '$Username'..."
& $passwdExe -c -b $pwdFilePath $Username $password
if ($LASTEXITCODE -ne 0) { throw "mosquitto_passwd failed (exit code $LASTEXITCODE)." }

$confContent = Get-Content $confPath -Raw
if ($confContent -notmatch '(?m)^\s*password_file') {
  Add-Content $confPath "`npassword_file $pwdFilePath"
}
if ($confContent -match '(?m)^\s*allow_anonymous\s+true') {
  (Get-Content $confPath) -replace '(?m)^\s*allow_anonymous\s+true', 'allow_anonymous false' | Set-Content $confPath
} elseif ($confContent -notmatch '(?m)^\s*allow_anonymous') {
  Add-Content $confPath "`nallow_anonymous false"
}

Write-Output "Updating $envPath with MQTT_USERNAME/MQTT_PASSWORD..."
$envLines = Get-Content $envPath | Where-Object { $_ -notmatch '^(MQTT_USERNAME|MQTT_PASSWORD)=' }
$envLines += "MQTT_USERNAME=$Username"
$envLines += "MQTT_PASSWORD=$password"
Set-Content $envPath $envLines

Write-Output "Restarting Mosquitto service..."
Restart-Service mosquitto

Write-Output "Restarting PATTI backend to pick up new credentials..."
& powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "restart_patti_service.ps1")

Write-Output ""
Write-Output "Done. The broker now requires auth (username: $Username, password written to .env)."
Write-Output "Any RPi/Linux node or ESP32 board still using old credentials will NOT reconnect"
Write-Output "until you update it - see this script's header comment for the per-device steps."
