#!/usr/bin/env node
// PATTI unified setup/stop/uninstall CLI - replaces the old setup.ps1/setup.sh/stop.ps1/
// stop.sh/uninstall.ps1/uninstall.sh. Works identically on Windows and Linux/macOS since
// Node is already a hard PATTI dependency; only shells out to OS-native commands where
// unavoidable (Scheduled Tasks / netsh on Windows, systemd / ufw on Linux).
//
// Usage:
//   node patti-cli.js [install]        Interactive install/update wizard (default)
//   node patti-cli.js stop             Stop the running background service
//   node patti-cli.js uninstall        Remove the service and (optionally) all files
//
// Flags:
//   --non-interactive       Use existing .env/DB values (or sensible defaults) with no prompts
//   --skip-update           Skip git pull / fresh npm install (used internally on re-exec)
//   --role=host|node|client Non-interactive role selection (default: existing .env role, else host)
//   --force                 Replace an existing PATTI client pairing / skip uninstall confirmation

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { execSync, spawnSync } = require('child_process');

const ROOT = __dirname;
const IS_WINDOWS = process.platform === 'win32';
const ENV_PATH = path.join(ROOT, '.env');
const ENV_EXAMPLE_PATH = path.join(ROOT, '.env.example');

// Task/service names. Host keeps the original "PATTI-Assistant"/"patti" names since
// backend/tools/host_machine_tool.js already hardcodes them for host self-restart.
const SERVICE_NAMES = {
  host: { task: 'PATTI-Assistant', systemd: 'patti', desc: 'PATTI Host (LLM + full app)' },
  node: { task: 'PATTI-Node', systemd: 'patti-node', desc: 'PATTI Node (sensor/actuator edge client)' },
  client: { task: 'PATTI-Client', systemd: 'patti-client', desc: 'PATTI Client (full app, host-provided LLM)' }
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function log(msg) { console.log(`\n[INFO] ${msg}`); }
function logSuccess(msg) { console.log(`\n[SUCCESS] ${msg}`); }
function logWarn(msg) { console.log(`\n[WARN] ${msg}`); }
function logError(msg) { console.error(`\n[ERROR] ${msg}`); }

function readEnvVar(key, fallback = '') {
  if (!fs.existsSync(ENV_PATH)) return fallback;
  const content = fs.readFileSync(ENV_PATH, 'utf8');
  const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : fallback;
}

function writeEnvVar(key, val) {
  let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(content)) {
    content = content.replace(pattern, `${key}=${val}`);
  } else {
    if (content.length && !content.endsWith('\n')) content += '\n';
    content += `${key}=${val}\n`;
  }
  fs.writeFileSync(ENV_PATH, content);
}

function ensureRandomSecret(key) {
  const current = readEnvVar(key, '');
  if (current === '' || current.startsWith('placeholder_')) {
    writeEnvVar(key, crypto.randomBytes(32).toString('hex'));
    log(`Generated a new random ${key}.`);
  }
}

function run(cmd, opts = {}) {
  try {
    execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
    return true;
  } catch (err) {
    if (opts.allowFail) return false;
    throw err;
  }
}

function runQuiet(cmd) {
  try {
    return { ok: true, output: execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString() };
  } catch (err) {
    return { ok: false, output: (err.stdout || err.stderr || '').toString() };
  }
}

function commandExists(cmd) {
  const probe = IS_WINDOWS ? `where ${cmd}` : `command -v ${cmd}`;
  return runQuiet(probe).ok;
}

function isWindowsElevated() {
  return runQuiet('net session').ok;
}

function isLinuxRootOrPasswordlessSudo() {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return true;
  return runQuiet('sudo -n true').ok;
}

function findListeningPid(port) {
  if (IS_WINDOWS) {
    const res = runQuiet(`powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)"`);
    const pid = res.output.trim();
    return /^\d+$/.test(pid) ? pid : null;
  }
  if (!commandExists('lsof')) return null;
  const res = runQuiet(`lsof -t -i:${port} -sTCP:LISTEN`);
  const pid = res.output.trim().split('\n')[0];
  return /^\d+$/.test(pid) ? pid : null;
}

function killPort(port, label) {
  const pid = findListeningPid(port);
  if (!pid) return false;
  if (IS_WINDOWS) {
    runQuiet(`powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue"`);
  } else {
    runQuiet(`kill -9 ${pid}`);
  }
  log(`Stopped ${label} (port ${port}), PID ${pid}.`);
  return true;
}

function createPrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask(question) {
      return new Promise(resolve => rl.question(question, answer => resolve(answer)));
    },
    close() { rl.close(); }
  };
}

async function askWithDefault(prompter, question, defaultVal) {
  const answer = await prompter.ask(`${question} [${defaultVal}]: `);
  const trimmed = answer.trim();
  return trimmed === '' ? defaultVal : trimmed;
}

async function askYesNo(prompter, question, defaultYes) {
  const suffix = defaultYes ? 'Y/n' : 'y/N';
  const answer = (await prompter.ask(`${question} (${suffix}): `)).trim().toLowerCase();
  if (answer === '') return defaultYes;
  return answer === 'y' || answer === 'yes';
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const subcommand = args.find(a => !a.startsWith('--')) || 'install';
  const flags = {
    nonInteractive: args.includes('--non-interactive'),
    skipUpdate: args.includes('--skip-update'),
    force: args.includes('--force'),
    role: null
  };
  const roleArg = args.find(a => a.startsWith('--role='));
  if (roleArg) flags.role = roleArg.split('=')[1];
  return { subcommand, flags };
}

// ---------------------------------------------------------------------------
// Firewall
// ---------------------------------------------------------------------------

function ensureFirewallRule(ports, description) {
  const portList = Array.isArray(ports) ? ports : [ports];
  log(`Checking firewall rules for ${description} (port${portList.length > 1 ? 's' : ''} ${portList.join(', ')})...`);

  if (IS_WINDOWS) {
    const ruleName = `PATTI-${description.replace(/[^a-zA-Z0-9]+/g, '-')}`;
    if (!isWindowsElevated()) {
      logWarn('Not running as Administrator - cannot create firewall rules automatically.');
      console.log(`\nTo allow ${description} through Windows Firewall, run this in an Administrator PowerShell:\n`);
      console.log(`  New-NetFirewallRule -DisplayName "${ruleName}" -Direction Inbound -LocalPort ${portList.join(',')} -Protocol TCP -Action Allow\n`);
      return false;
    }
    const check = runQuiet(`powershell -NoProfile -Command "Get-NetFirewallRule -DisplayName '${ruleName}' -ErrorAction SilentlyContinue"`);
    if (check.ok && check.output.trim()) {
      log(`Firewall rule "${ruleName}" already exists.`);
      return true;
    }
    const result = runQuiet(`powershell -NoProfile -Command "New-NetFirewallRule -DisplayName '${ruleName}' -Direction Inbound -LocalPort ${portList.join(',')} -Protocol TCP -Action Allow | Out-Null"`);
    if (result.ok) {
      logSuccess(`Created Windows Firewall rule "${ruleName}" for port${portList.length > 1 ? 's' : ''} ${portList.join(', ')}.`);
      return true;
    }
    logWarn(`Failed to create firewall rule automatically: ${result.output.trim()}`);
    console.log(`\nRun this yourself in an Administrator PowerShell:\n`);
    console.log(`  New-NetFirewallRule -DisplayName "${ruleName}" -Direction Inbound -LocalPort ${portList.join(',')} -Protocol TCP -Action Allow\n`);
    return false;
  }

  // Linux
  if (!commandExists('ufw')) {
    logWarn('ufw not found - skipping automatic firewall configuration.');
    console.log(`\nIf you use a firewall, allow inbound TCP on port${portList.length > 1 ? 's' : ''} ${portList.join(', ')} for ${description}, e.g.:`);
    for (const p of portList) console.log(`  sudo ufw allow ${p}/tcp`);
    console.log('');
    return false;
  }
  const statusRes = runQuiet('sudo -n ufw status 2>/dev/null || ufw status');
  const ufwActive = /Status:\s*active/i.test(statusRes.output);
  if (!ufwActive) {
    log('ufw is installed but not active - leaving it as-is (not enabling a firewall you did not turn on).');
    return true;
  }
  if (!isLinuxRootOrPasswordlessSudo()) {
    logWarn('No passwordless sudo available - cannot configure ufw automatically.');
    console.log(`\nRun this yourself:\n`);
    for (const p of portList) console.log(`  sudo ufw allow ${p}/tcp`);
    console.log('');
    return false;
  }
  let allOk = true;
  for (const p of portList) {
    const result = runQuiet(`sudo -n ufw allow ${p}/tcp`);
    if (result.ok) {
      logSuccess(`Allowed port ${p}/tcp through ufw.`);
    } else {
      allOk = false;
      logWarn(`Failed to allow port ${p}/tcp through ufw: ${result.output.trim()}`);
    }
  }
  return allOk;
}

// ---------------------------------------------------------------------------
// Service registration (start on boot / at login)
// ---------------------------------------------------------------------------

function generateWindowsLauncherVbs(targetScript) {
  const nodePath = runQuiet('where node').output.split('\n')[0].trim() || 'node';
  const vbsContent = `Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = scriptDir
Do
  WshShell.Run """${nodePath}"" ${targetScript}", 0, true
  WScript.Sleep 5000
Loop
`;
  const vbsPath = path.join(ROOT, 'run-background.vbs');
  fs.writeFileSync(vbsPath, vbsContent);
  return vbsPath;
}

function registerWindowsTask(role, targetScript) {
  const { task: taskName, desc } = SERVICE_NAMES[role];
  log(`Configuring Windows background task "${taskName}"...`);
  const vbsPath = generateWindowsLauncherVbs(targetScript);

  runQuiet(`powershell -NoProfile -Command "Stop-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue"`);

  const psScript = `
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument '"${vbsPath}"'
$trigger = New-ScheduledTaskTrigger -AtLogon
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "${taskName}" -Action $action -Trigger $trigger -Settings $settings -Description "${desc}" -Force | Out-Null
Start-ScheduledTask -TaskName "${taskName}"
`.trim();

  const result = runQuiet(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`);
  if (result.ok) {
    logSuccess(`Registered and started scheduled task "${taskName}".`);
    return true;
  }
  logWarn(`Could not register scheduled task automatically (${result.output.trim()}). Starting directly in the background instead...`);
  const child = spawnSync('wscript.exe', [vbsPath], { cwd: ROOT, detached: true, stdio: 'ignore' });
  return child.error ? false : true;
}

function registerLinuxService(role, startCmd) {
  const { systemd: serviceName, desc } = SERVICE_NAMES[role];
  const serviceFile = `/etc/systemd/system/${serviceName}.service`;

  if (!commandExists('systemctl') || !isLinuxRootOrPasswordlessSudo()) {
    logWarn('systemd not available or passwordless sudo missing - starting in the background via nohup instead...');
    spawnSync('/bin/sh', ['-c', `nohup ${startCmd} > /dev/null 2>&1 &`], { cwd: ROOT, detached: true, stdio: 'ignore' });
    logSuccess('Started the application process directly (will not survive a reboot - re-run this script after boot, or configure systemd manually).');
    return false;
  }

  log(`Configuring systemd service "${serviceName}"...`);
  const unit = `[Unit]
Description=${desc}
After=network.target

[Service]
Type=simple
User=${os.userInfo().username}
WorkingDirectory=${ROOT}
ExecStart=${startCmd}
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`;
  const tmpUnitPath = path.join(os.tmpdir(), `${serviceName}.service`);
  fs.writeFileSync(tmpUnitPath, unit);
  runQuiet(`sudo -n cp "${tmpUnitPath}" "${serviceFile}"`);
  runQuiet('sudo -n systemctl daemon-reload');
  runQuiet(`sudo -n systemctl enable ${serviceName}.service`);
  const restartResult = runQuiet(`sudo -n systemctl restart ${serviceName}.service`);
  const activeCheck = runQuiet(`sudo -n systemctl is-active --quiet ${serviceName}.service`);
  if (restartResult.ok && activeCheck.ok) {
    logSuccess(`${desc} is running as systemd service "${serviceName}".`);
    log(`Check status: sudo systemctl status ${serviceName}`);
    log(`Check logs:   journalctl -u ${serviceName} -f`);
    return true;
  }
  logWarn(`Failed to start systemd service "${serviceName}". Check: sudo systemctl status ${serviceName}`);
  return false;
}

function stopWindowsTask(role) {
  const { task: taskName } = SERVICE_NAMES[role];
  const check = runQuiet(`powershell -NoProfile -Command "Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue"`);
  let stoppedAnything = false;
  if (check.ok && check.output.trim()) {
    runQuiet(`powershell -NoProfile -Command "Stop-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue; Disable-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue | Out-Null"`);
    log(`Stopped and disabled scheduled task "${taskName}".`);
    stoppedAnything = true;
  }
  const wscriptRes = runQuiet(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'wscript.exe'\\" | Where-Object { $_.CommandLine -match 'run-background\\.vbs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Output $_.ProcessId }"`);
  if (wscriptRes.ok && wscriptRes.output.trim()) {
    log(`Stopped background launcher process(es): ${wscriptRes.output.trim()}`);
    stoppedAnything = true;
  }
  return stoppedAnything;
}

function stopLinuxService(role) {
  const { systemd: serviceName } = SERVICE_NAMES[role];
  if (!commandExists('systemctl')) return false;
  const listed = runQuiet(`systemctl list-unit-files 2>/dev/null | grep -q "^${serviceName}.service"`);
  if (!listed.ok) return false;
  const active = runQuiet(`systemctl is-active --quiet ${serviceName}`);
  if (!active.ok) return false;
  runQuiet(`sudo -n systemctl stop ${serviceName}`);
  log(`Stopped systemd service "${serviceName}".`);
  return true;
}

function unregisterWindowsTask(role) {
  const { task: taskName } = SERVICE_NAMES[role];
  const check = runQuiet(`powershell -NoProfile -Command "Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue"`);
  if (check.ok && check.output.trim()) {
    runQuiet(`powershell -NoProfile -Command "Stop-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false -ErrorAction SilentlyContinue"`);
    logSuccess(`Removed scheduled task "${taskName}".`);
  }
}

function removeLinuxService(role) {
  const { systemd: serviceName } = SERVICE_NAMES[role];
  const serviceFile = `/etc/systemd/system/${serviceName}.service`;
  if (!fs.existsSync(serviceFile)) return;
  runQuiet(`sudo -n systemctl stop ${serviceName}.service`);
  runQuiet(`sudo -n systemctl disable ${serviceName}.service`);
  runQuiet(`sudo -n rm -f ${serviceFile}`);
  runQuiet('sudo -n systemctl daemon-reload');
  logSuccess(`Removed systemd service "${serviceName}".`);
}

function currentRole() {
  const isHost = readEnvVar('IS_HOST', 'true') !== 'false';
  if (!isHost) return 'node';
  return readEnvVar('PATTI_ROLE', 'host') === 'client' ? 'client' : 'host';
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

async function installFlow(flags) {
  console.log('====================================================');
  console.log('  PATTI Setup Wizard');
  console.log('====================================================');

  const hasEnv = fs.existsSync(ENV_PATH);

  // Treat an existing .env as an update: stop what's running, pull latest, fresh install,
  // then re-exec with --skip-update to run the rest of this same flow cleanly.
  if (!flags.skipUpdate && hasEnv) {
    log('Existing setup detected (.env file exists). Treating as an update...');
    const port = readEnvVar('PORT', '3000');
    killPort(port, 'existing backend');
    killPort('5173', 'Vite dev server');

    if (commandExists('git') && fs.existsSync(path.join(ROOT, '.git'))) {
      log('Discarding any local changes and pulling latest updates from git...');
      run('git checkout .', { allowFail: true });
      run('git reset --hard', { allowFail: true });
      run('git pull', { allowFail: true });
    }

    log('Removing existing node_modules directories for a fresh installation...');
    for (const dir of ['node_modules', 'backend/node_modules', 'frontend/node_modules']) {
      fs.rmSync(path.join(ROOT, dir), { recursive: true, force: true });
    }
    log('Installing all dependencies fresh...');
    run('npm run install:all');

    log('Re-running setup to apply configuration and rebuild...');
    const reArgs = ['install', '--skip-update'];
    if (flags.nonInteractive) reArgs.push('--non-interactive');
    if (flags.role) reArgs.push(`--role=${flags.role}`);
    run(`node "${path.join(ROOT, 'patti-cli.js')}" ${reArgs.join(' ')}`);
    return;
  }

  // Prerequisites
  log('Checking system prerequisites...');
  if (!commandExists('git')) {
    logError('Git is not installed. Please install Git and run this setup again.');
    process.exit(1);
  }
  if (!commandExists('node')) {
    logError('Node.js is not installed. Please install Node.js v25+ and run this setup again.');
    process.exit(1);
  }
  log(`Node.js ${process.version} is installed.`);

  if (!fs.existsSync(ENV_PATH)) {
    fs.copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
  }

  const prompter = flags.nonInteractive ? null : createPrompter();

  // ---- Role selection ----
  let role = flags.role || currentRole();
  if (!flags.nonInteractive) {
    console.log('\nWhat is this machine?');
    console.log('  1) Host        - runs the LLM and the full PATTI app (this is your main machine)');
    console.log('  2) Node        - lightweight sensor/actuator edge device (temperature, power, etc.)');
    console.log('  3) PATTI Client - full PATTI app on this device, using the Host machine\'s LLM');
    const choice = await askWithDefault(prompter, 'Select an option', role === 'client' ? '3' : role === 'node' ? '2' : '1');
    role = choice === '2' ? 'node' : choice === '3' ? 'client' : 'host';
  }
  log(`Selected role: ${role}`);

  if (role === 'host') {
    await installHost(prompter, flags);
  } else if (role === 'node') {
    await installNode(prompter, flags);
  } else {
    await installClient(prompter, flags);
  }

  if (prompter) prompter.close();
}

async function installHost(prompter, flags) {
  const defaults = {
    deviceType: readEnvVar('DEVICE_TYPE', IS_WINDOWS ? 'windows' : 'linux'),
    adminUser: 'admin',
    adminPass: 'adminpassword',
    localUrl: readEnvVar('LOCAL_LLM_URL', 'http://localhost:1234/v1'),
    localKey: readEnvVar('LOCAL_LLM_KEY', ''),
    onlineKey: readEnvVar('GEMINI_API_KEY', ''),
    onlineProvider: 'gemini',
    userName: '',
    userZipcode: '',
    weatherKey: readEnvVar('WEATHER_API_KEY', ''),
    port: readEnvVar('PORT', '3000'),
    buildFe: true
  };

  if (fs.existsSync(path.join(ROOT, 'backend/node_modules'))) {
    const dbSettings = runQuiet('node backend/scripts/read_settings.js');
    if (dbSettings.ok) {
      try {
        const parsed = JSON.parse(dbSettings.output.trim() || '{}');
        if (parsed.username) defaults.adminUser = parsed.username;
        if (parsed.device_type) defaults.deviceType = parsed.device_type;
        if (parsed.local_url) defaults.localUrl = parsed.local_url;
        if (parsed.local_key) defaults.localKey = parsed.local_key;
        if (parsed.online_provider) defaults.onlineProvider = parsed.online_provider;
        if (parsed.online_key) defaults.onlineKey = parsed.online_key;
        if (parsed.name) defaults.userName = parsed.name;
        if (parsed.zipcode) defaults.userZipcode = parsed.zipcode;
        if (parsed.weather_api_key) defaults.weatherKey = parsed.weather_api_key;
      } catch (e) { /* ignore malformed DB settings JSON */ }
    }
  }

  let cfg = { ...defaults };
  if (flags.nonInteractive) {
    log('Running in non-interactive mode. Using existing configuration defaults.');
  } else {
    console.log('\n====================================================');
    console.log('  Configuration Settings');
    console.log('====================================================');
    console.log('REQUIRED for PATTI to start at all:');
    console.log('  - JWT_SECRET and DB_ENCRYPTION_SECRET (auto-generated, no action needed)');
    console.log('  - Admin Username / Password (used to log in to the web UI)');
    console.log('  - Local LLM Base URL (where LM Studio/Ollama/etc is running)');
    console.log('Everything else is OPTIONAL - press Enter to accept the default,');
    console.log('and you can fill it in later from the Settings page.\n');

    cfg.adminUser = await askWithDefault(prompter, 'Enter Admin Username', defaults.adminUser);
    cfg.adminPass = await askWithDefault(prompter, 'Enter Admin Password', defaults.adminPass);
    cfg.userName = await askWithDefault(prompter, 'Enter your Name', defaults.userName);
    cfg.userZipcode = await askWithDefault(prompter, 'Enter your Zipcode', defaults.userZipcode);
    cfg.weatherKey = await askWithDefault(prompter, 'Enter OpenWeatherMap API Key (optional)', defaults.weatherKey);
    cfg.localUrl = await askWithDefault(prompter, 'Enter Local LLM Base URL', defaults.localUrl);
    cfg.localKey = await askWithDefault(prompter, 'Enter Local LLM API Key (optional)', defaults.localKey);
    cfg.onlineKey = await askWithDefault(prompter, 'Enter Online Gemini API Key (optional)', defaults.onlineKey);
    cfg.buildFe = await askYesNo(prompter, 'Build React Frontend on this device?', true);
    cfg.port = await askWithDefault(prompter, 'Enter Server PORT', defaults.port);
  }

  writeEnvVar('PORT', cfg.port);
  writeEnvVar('IS_HOST', 'true');
  writeEnvVar('PATTI_ROLE', 'host');
  writeEnvVar('DB_PATH', readEnvVar('DB_PATH', 'backend/database.db'));
  writeEnvVar('LOCAL_LLM_URL', cfg.localUrl);
  writeEnvVar('LOCAL_LLM_KEY', cfg.localKey);
  writeEnvVar('GEMINI_API_KEY', cfg.onlineKey);
  writeEnvVar('WEATHER_API_KEY', cfg.weatherKey);
  writeEnvVar('MQTT_BROKER_URL', 'mqtt://localhost:1883');
  writeEnvVar('MQTT_NODE_ID', IS_WINDOWS ? 'windows-main' : os.hostname());
  ensureRandomSecret('JWT_SECRET');
  ensureRandomSecret('DB_ENCRYPTION_SECRET');
  ensureRandomSecret('OTA_SECRET');

  if (!flags.skipUpdate) {
    log('Installing NPM dependencies (this might take a few minutes)...');
    run('npm run install:all');
  }

  let resetDb = false;
  if (!flags.nonInteractive) {
    resetDb = await askYesNo(prompter, 'Reset the database and start fresh (deletes all users)?', false);
  }
  if (resetDb) {
    log('Wiping existing database for a fresh setup...');
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(path.join(ROOT, `backend/database.db${suffix}`), { force: true });
    }
  }

  log('Seeding local database...');
  run(`node backend/scripts/seed_settings.js --username="${cfg.adminUser}" --password="${cfg.adminPass}" --device_type="${defaults.deviceType}" --is_main_host="1" --local_url="${cfg.localUrl}" --local_key="${cfg.localKey}" --online_key="${cfg.onlineKey}" --online_provider="${defaults.onlineProvider}" --name="${cfg.userName}" --zipcode="${cfg.userZipcode}" --weather_api_key="${cfg.weatherKey}"`);

  if (cfg.buildFe) {
    log('Building frontend assets...');
    run('npm run build');
  }

  ensureFirewallRule([cfg.port, 1883], 'PATTI Host (app + MQTT)');

  if (IS_WINDOWS) {
    killPort(cfg.port, 'existing backend');
    registerWindowsTask('host', 'backend/server.js');
  } else {
    killPort(cfg.port, 'existing backend');
    const npmPath = runQuiet('which npm').output.trim() || 'npm';
    registerLinuxService('host', `${npmPath} start`);
  }

  printSummary('host', { port: cfg.port });
}

async function installNode(prompter, flags) {
  const defaults = {
    mainHostIp: readEnvVar('MAIN_HOST_IP', 'localhost'),
    port: readEnvVar('PORT', '3000')
  };
  let mainHostIp = defaults.mainHostIp;
  if (!flags.nonInteractive) {
    mainHostIp = await askWithDefault(prompter, "Enter the Host machine's IP address", defaults.mainHostIp);
  }

  writeEnvVar('PORT', defaults.port);
  writeEnvVar('IS_HOST', 'false');
  writeEnvVar('MAIN_HOST_IP', mainHostIp);
  writeEnvVar('MQTT_BROKER_URL', `mqtt://${mainHostIp}:1883`);
  writeEnvVar('MQTT_NODE_ID', os.hostname() || 'field-node');
  ensureRandomSecret('JWT_SECRET');
  ensureRandomSecret('DB_ENCRYPTION_SECRET');

  if (!flags.skipUpdate) {
    log('Installing minimal Node Client dependencies...');
    const nodeClientDir = path.join(ROOT, 'node_client');
    if (!fs.existsSync(nodeClientDir)) fs.mkdirSync(nodeClientDir, { recursive: true });
    const pkgPath = path.join(nodeClientDir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      fs.writeFileSync(pkgPath, JSON.stringify({
        name: 'patti-node-client',
        version: '1.0.0',
        dependencies: { mqtt: '^5.5.0', dotenv: '^16.4.5', macaddress: '^0.2.9', express: '^4.19.2' }
      }, null, 2));
    }
    run('npm install --prefix node_client');
  }

  ensureFirewallRule(defaults.port, 'PATTI Node');

  if (IS_WINDOWS) {
    registerWindowsTask('node', 'node_client/client.js');
  } else {
    const nodePath = runQuiet('which node').output.trim() || 'node';
    registerLinuxService('node', `${nodePath} node_client/client.js`);
  }

  printSummary('node', { mainHostIp });
}

async function installClient(prompter, flags) {
  const defaults = {
    hostIp: readEnvVar('HOST_BRIDGE_URL', '').replace(/^https?:\/\//, '').split(':')[0] || 'localhost',
    hostPort: '3000',
    port: readEnvVar('PORT', '3000'),
    deviceType: readEnvVar('DEVICE_TYPE', 'rpi-5-8gb')
  };

  if (flags.nonInteractive && !(process.env.PATTI_CLIENT_HOST_USER && process.env.PATTI_CLIENT_HOST_PASS)) {
    logError('PATTI Client setup needs your host admin credentials to pair - set PATTI_CLIENT_HOST_IP, PATTI_CLIENT_HOST_USER and PATTI_CLIENT_HOST_PASS env vars before running with --non-interactive, or run interactively.');
    process.exit(1);
  }

  let hostIp = defaults.hostIp;
  let hostPort = defaults.hostPort;
  let hostAdminUsername = process.env.PATTI_CLIENT_HOST_USER || '';
  let hostAdminPassword = process.env.PATTI_CLIENT_HOST_PASS || '';
  let nodeName = os.hostname() || 'patti-client';
  let localPort = defaults.port;

  if (!flags.nonInteractive) {
    console.log('\nA PATTI Client needs to pair with your Host machine using its admin login.');
    console.log('Only one PATTI client can be paired at a time.\n');
    hostIp = await askWithDefault(prompter, "Enter the Host machine's IP address or hostname", process.env.PATTI_CLIENT_HOST_IP || defaults.hostIp);
    hostPort = await askWithDefault(prompter, "Enter the Host's PATTI port", defaults.hostPort);
    hostAdminUsername = await askWithDefault(prompter, 'Enter the Host admin username', hostAdminUsername);
    hostAdminPassword = await prompter.ask('Enter the Host admin password: ');
    nodeName = await askWithDefault(prompter, 'Enter a name for this device', nodeName);
    localPort = await askWithDefault(prompter, 'Enter the PORT this client should run on', defaults.port);
  } else {
    hostIp = process.env.PATTI_CLIENT_HOST_IP || defaults.hostIp;
  }

  const hostBridgeUrl = `http://${hostIp}:${hostPort}`;
  log(`Pairing with host at ${hostBridgeUrl}...`);

  let pairResult = await registerWithHost(hostBridgeUrl, { hostAdminUsername, hostAdminPassword, nodeName, deviceType: defaults.deviceType, port: localPort, force: flags.force });

  if (pairResult.status === 409 && !flags.force) {
    logWarn(pairResult.body.error || 'A PATTI client is already registered.');
    let replace = flags.force;
    if (!flags.nonInteractive) {
      replace = await askYesNo(prompter, 'Replace the existing PATTI client with this device?', false);
    }
    if (!replace) {
      logError('Pairing cancelled - only one PATTI client may be registered at a time.');
      process.exit(1);
    }
    pairResult = await registerWithHost(hostBridgeUrl, { hostAdminUsername, hostAdminPassword, nodeName, deviceType: defaults.deviceType, port: localPort, force: true });
  }

  if (!pairResult.ok) {
    logError(`Pairing with the host failed: ${pairResult.body && pairResult.body.error ? pairResult.body.error : pairResult.error || 'Unknown error'}`);
    process.exit(1);
  }

  logSuccess(`Paired successfully! Host is running PATTI v${pairResult.body.hostVersion || 'unknown'}.`);

  writeEnvVar('PORT', localPort);
  writeEnvVar('IS_HOST', 'true');
  writeEnvVar('PATTI_ROLE', 'client');
  writeEnvVar('HOST_BRIDGE_URL', hostBridgeUrl);
  writeEnvVar('HOST_BRIDGE_SECRET', pairResult.body.bridgeSecret);
  writeEnvVar('DB_PATH', readEnvVar('DB_PATH', 'backend/database.db'));
  ensureRandomSecret('JWT_SECRET');
  ensureRandomSecret('DB_ENCRYPTION_SECRET');
  ensureRandomSecret('OTA_SECRET');

  if (!flags.skipUpdate) {
    log('Installing NPM dependencies (this might take a few minutes)...');
    run('npm run install:all');
  }

  log('Seeding local database with your device login (same credentials used to pair)...');
  run(`node backend/scripts/seed_settings.js --username="${hostAdminUsername}" --password="${hostAdminPassword}" --device_type="${defaults.deviceType}" --is_main_host="0" --local_url="" --local_key="" --online_key="" --online_provider="gemini" --name="" --zipcode="" --weather_api_key=""`);

  log('Building frontend assets...');
  run('npm run build');

  ensureFirewallRule(localPort, 'PATTI Client');

  if (IS_WINDOWS) {
    killPort(localPort, 'existing backend');
    registerWindowsTask('client', 'backend/server.js');
  } else {
    killPort(localPort, 'existing backend');
    const npmPath = runQuiet('which npm').output.trim() || 'npm';
    registerLinuxService('client', `${npmPath} start`);
  }

  printSummary('client', { hostBridgeUrl, port: localPort });
}

function registerWithHost(hostBridgeUrl, { hostAdminUsername, hostAdminPassword, nodeName, deviceType, port, force }) {
  return fetch(`${hostBridgeUrl}/api/nodes/register-client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hostAdminUsername,
      hostAdminPassword,
      nodeName,
      deviceType,
      ipAddress: getLocalIpAddress(),
      port: Number(port),
      force: !!force
    })
  }).then(async res => {
    let body = {};
    try { body = await res.json(); } catch (e) { /* non-JSON error body */ }
    return { ok: res.ok, status: res.status, body };
  }).catch(err => ({ ok: false, error: err.message }));
}

function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function printSummary(role, extra) {
  console.log('\n====================================================');
  console.log('  Setup Completed Successfully!');
  console.log('====================================================');
  console.log(`Role : ${role}`);
  if (extra.port) console.log(`Port : ${extra.port}`);
  if (extra.mainHostIp) console.log(`Host IP : ${extra.mainHostIp}`);
  if (extra.hostBridgeUrl) console.log(`Host Bridge URL : ${extra.hostBridgeUrl}`);
  console.log('====================================================');
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

function stopFlow() {
  console.log('====================================================');
  console.log('  Stopping PATTI');
  console.log('====================================================');

  const role = currentRole();
  let stoppedAnything = IS_WINDOWS ? stopWindowsTask(role) : stopLinuxService(role);

  const port = readEnvVar('PORT', '3000');
  if (killPort(port, `backend (port ${port})`)) stoppedAnything = true;
  if (killPort('5173', 'Vite dev server (port 5173)')) stoppedAnything = true;

  console.log('\n====================================================');
  console.log(stoppedAnything ? '  PATTI has been stopped.' : '  Nothing was running - PATTI was already stopped.');
  console.log('====================================================');
  console.log('To start it again: node patti-cli.js (re-enables the scheduled task/service) or npm start.');
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

async function uninstallFlow(flags) {
  console.log('====================================================');
  console.log('  Uninstalling PATTI');
  console.log('====================================================');

  const role = currentRole();

  if (!flags.force) {
    const prompter = createPrompter();
    const confirmed = await askYesNo(prompter, `This will remove PATTI (role: ${role}), its service registration, database, and node_modules from ${ROOT}. Continue?`, false);
    prompter.close();
    if (!confirmed) {
      log('Uninstall cancelled.');
      return;
    }
  }

  if (IS_WINDOWS) {
    if (isWindowsElevated()) {
      unregisterWindowsTask(role);
    } else {
      logWarn('Not running as Administrator - could not remove the scheduled task automatically. Remove it yourself: Unregister-ScheduledTask -TaskName "' + SERVICE_NAMES[role].task + '"');
    }
  } else {
    removeLinuxService(role);
  }

  const port = readEnvVar('PORT', '3000');
  killPort(port, `backend (port ${port})`);

  log('Removing dependencies, database, and generated files...');
  for (const relPath of [
    'node_modules', 'backend/node_modules', 'frontend/node_modules', 'node_client/node_modules',
    'frontend/dist', 'tool_registry/staging', 'tool_registry/tools',
    'backend/database.db', 'backend/database.db-wal', 'backend/database.db-shm',
    'backend/test_database.db', 'backend/test_database.db-wal', 'backend/test_database.db-shm',
    '.env', 'run-background.vbs'
  ]) {
    fs.rmSync(path.join(ROOT, relPath), { recursive: true, force: true });
  }

  logSuccess('PATTI has been uninstalled. The project files themselves were left in place - delete this folder manually if you no longer need it.');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const { subcommand, flags } = parseArgs();
  if (subcommand === 'stop') {
    stopFlow();
  } else if (subcommand === 'uninstall') {
    await uninstallFlow(flags);
  } else if (subcommand === 'install') {
    await installFlow(flags);
  } else {
    logError(`Unknown subcommand "${subcommand}". Use: install (default), stop, or uninstall.`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => {
    logError(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, currentRole, SERVICE_NAMES };
