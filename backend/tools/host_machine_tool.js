const os = require('os');
const fs = require('fs');
const { exec, execSync } = require('child_process');
const util = require('util');
const path = require('path');
const execPromise = util.promisify(exec);
const { measurePower } = require('./ina219_tool');
const { measureCpuTemp } = require('./temp_tool');

const { resolveSafePath } = require('../utils/pathSecurity');

// Service/task names are only ever alphanumeric plus a few separator characters on both
// Windows (Get-Service/scheduled task names) and Linux (systemd unit names). Rejecting
// anything else closes off shell metacharacters (;, &, |, `, $(), spaces, quotes) before
// the value ever reaches exec() - see SEC-1 in docs/REVIEW_2026-08-03.md.
const SAFE_SERVICE_NAME = /^[a-zA-Z0-9_.-]{1,128}$/;
function isValidServiceName(service) {
  return typeof service === 'string' && SAFE_SERVICE_NAME.test(service);
}

// Uploaded chat attachments are untrusted user content, not something the host-control
// tool should ever be allowed to execute as a script - see SEC-2 in docs/REVIEW_2026-08-03.md.
function isUnderUntrustedUploadDir(absolutePath) {
  const uploadsRoot = path.resolve(process.cwd(), 'chat_attachments') + path.sep;
  return path.resolve(absolutePath).startsWith(uploadsRoot);
}

/**
 * Helper to fetch power/battery info via INA219 helper script.
 */
async function getPowerInfo() {
  try {
    const data = await measurePower();
    if (!data.success) {
      return `### ⚡ Power & Battery Status (Simulated/Warning)
- **Status**: ${data.error || 'Simulated'}
- **Battery Level**: ${data.battery_percent || 0}%
- **Power Draw**: ${data.power_w || 0} W
- **Voltage**: ${data.voltage_v || 0} V
- **Current**: ${data.current_a || 0} A`;
    }

    let statusHeader = `### ⚡ Power & Battery Status`;
    if (data.simulated) {
      statusHeader = `### ⚡ Power & Battery Status (Simulated)`;
    }

    const readingsStr = data.readings.map((r, i) => {
      return `#### Reading ${i + 1}
- **Battery Level**: ${r.battery_percent}%
- **Power Draw**: ${r.power_w} W
- **Voltage**: ${r.voltage_v} V
- **Current**: ${r.current_a} A`;
    }).join('\n\n');

    return `${statusHeader}

${readingsStr}

#### 📊 3-Sample Average
- **Battery Level**: ${data.average.battery_percent}%
- **Power Draw**: ${data.average.power_w} W
- **Voltage**: ${data.average.voltage_v} V
- **Current**: ${data.average.current_a} A`;
  } catch (err) {
    return `### ⚡ Power & Battery Status
- **Error**: Failed to read power telemetry: ${err.message}`;
  }
}

/**
 * Helper to fetch CPU temperature info via native temp_tool.
 */
async function getTemperatureInfo() {
  try {
    const data = await measureCpuTemp();
    if (!data.success) {
      return `### 🌡️ CPU Temperature (Simulated/Warning)
- **Status**: ${data.error || 'Failed to read CPU temperature'}`;
    }

    let statusHeader = `### 🌡️ CPU Temperature`;
    if (data.simulated) {
      statusHeader = `### 🌡️ CPU Temperature (Simulated)`;
    }

    const readingsStr = data.readings.map((r, i) => {
      return `- **Reading ${i + 1}**: ${r.celsius}°C (${r.fahrenheit}°F)`;
    }).join('\n');

    return `${statusHeader}
${readingsStr}

#### 📊 3-Sample Average
- **Average Temperature**: ${data.average.celsius}°C (${data.average.fahrenheit}°F)`;
  } catch (err) {
    return `### 🌡️ CPU Temperature
- **Error**: Failed to read CPU temperature: ${err.message}`;
  }
}

/**
 * Handles operations for the Host Machine Agent.
 * Retrieves CPU, memory, uptime, OS, disk, and power information.
 * 
 * @param {string} action Action to perform
 * @param {object} params Action parameters.
 * @returns {Promise<string>} Report on the host machine specifications.
 */
async function handleHostMachineTool(action, params = {}, userId = 1) {
  const { getDb } = require('../db');
  let deviceType = 'windows';
  let isMainHost = 1;
  if (process.env.DEVICE_TYPE_OVERRIDE) {
    deviceType = process.env.DEVICE_TYPE_OVERRIDE;
  } else {
    try {
      const db = await getDb();
      const settings = await db.get('SELECT device_type, is_main_host FROM user_settings WHERE user_id = ?', [userId]);
      if (settings) {
        deviceType = settings.device_type || 'windows';
        isMainHost = settings.is_main_host;
      }
    } catch (e) {}
  }

  const DEVICE_CAPABILITIES = {
    'windows': { gpio: false, i2c: false, systemd: false, powershell: true, taskManager: true, registry: true, securityScan: true },
    'rpi-zero-2w': { gpio: true, i2c: true, systemd: true, powershell: false, taskManager: false, securityScan: true },
    'rpi-3b': { gpio: true, i2c: true, systemd: true, powershell: false, taskManager: false, securityScan: true },
    'rpi-4b-2gb': { gpio: true, i2c: true, systemd: true, powershell: false, taskManager: false, securityScan: true },
    'rpi-5-8gb': { gpio: true, i2c: true, systemd: true, nvme: true, powershell: false, securityScan: true },
    'rpi-5-16gb': { gpio: true, i2c: true, systemd: true, nvme: true, powershell: false, securityScan: true },
    'esp32': { gpio: true, i2c: true, systemd: false, powershell: false, wifi: true, securityScan: true },
    'esp32-s2': { gpio: true, i2c: true, systemd: false, powershell: false, wifi: true, securityScan: true },
    'esp32-s3': { gpio: true, i2c: true, systemd: false, powershell: false, wifi: true, securityScan: true },
    'esp32-c3': { gpio: true, i2c: true, systemd: false, powershell: false, wifi: true, securityScan: true },
    'esp32-c6': { gpio: true, i2c: true, systemd: false, powershell: false, wifi: true, securityScan: true }
  };
  
  // Use prefix matching for generic rpi or esp32 if exact match not found
  let capabilities = DEVICE_CAPABILITIES[deviceType];
  if (!capabilities) {
    if (deviceType.startsWith('rpi')) capabilities = DEVICE_CAPABILITIES['rpi-5-8gb'];
    else if (deviceType.startsWith('esp32')) capabilities = DEVICE_CAPABILITIES['esp32'];
    else capabilities = DEVICE_CAPABILITIES['windows'];
  }

  if (action === 'get_capabilities') {
    return { deviceType, isMainHost, capabilities };
  }

  if (action === 'get_os_info') {
    return {
      platform: os.platform(),
      type: os.type(),
      release: os.release()
    };
  }

  if (action === 'get_specifications') {
    try {
      let osName = os.type();
      try {
        if (os.platform() === 'win32') {
          // Fetches friendly name like "Microsoft Windows 11 Home"
          const wmicOut = execSync('wmic os get Caption /value', { encoding: 'utf8' });
          const match = wmicOut.match(/Caption=(.*)/);
          if (match) osName = match[1].trim();
        }
      } catch(e) {
        console.error("Friendly OS fetch failed");
      }
      const cpuInfo = os.cpus().length > 0 ? os.cpus()[0].model + ' (' + os.cpus().length + ' cores)' : 'Unknown';
      return { 
        OS: osName, 
        Release: os.release(), 
        Processor: cpuInfo, 
        RAM_GB: (os.totalmem() / (1024 ** 3)).toFixed(2) 
      };
    } catch (err) {
      return `Error retrieving host machine specifications: ${err.message}`;
    }
  }

  if (action === 'get_system_report') {
    const specs = await handleHostMachineTool('get_specifications', params, userId);
    const temp = await getTemperatureInfo();
    const net = await handleHostMachineTool('get_network_info', params, userId);
    const specsStr = `### 🖥️ Host Machine Specifications
- **Operating System**: ${specs.OS || 'Unknown'} (${specs.Release || 'Unknown'})
- **Processor**: ${specs.Processor || 'Unknown'}
- **Memory**: ${specs.RAM_GB || 'Unknown'} GB total`;
    return `${specsStr}\n\n${temp}\n\n${net}`;
  }

  if (action === 'get_power') {
    return await getPowerInfo();
  }
  if (action === 'get_temperature') {
    return await getTemperatureInfo();
  }
  if (action === 'get_network_info') {
    try {
      const platform = os.platform();
      if (platform === 'win32') {
        const { stdout } = await execPromise('ipconfig');
        return `### 📶 Windows Network Information\n\`\`\`\n${stdout}\n\`\`\``;
      } else {
        const { stdout: ipAddr } = await execPromise('ip addr || hostname -I');
        let wifiInfo = '';
        try {
          const { stdout: iw } = await execPromise('iwconfig 2>/dev/null');
          wifiInfo = `\n### 📶 WiFi Configuration\n\`\`\`\n${iw}\n\`\`\``;
        } catch (e) {}
        return `### 📶 Linux Network Information\n\`\`\`\n${ipAddr}\n\`\`\`${wifiInfo}`;
      }
    } catch (err) {
      return `Error retrieving network info: ${err.message}`;
    }
  }
  if (action === 'get_process_list') {
    try {
      const platform = os.platform();
      const cmd = platform === 'win32'
        ? 'tasklist'
        : 'ps aux --sort=-%cpu | head -n 15';
      const { stdout } = await execPromise(cmd);
      const output = stdout.length > 2000 ? stdout.substring(0, 2000) + '\n... [Truncated]' : stdout;
      return `### 📊 Host Process List (Top CPU/Memory)\n\`\`\`\n${output}\n\`\`\``;
    } catch (err) {
      return `Error retrieving process list: ${err.message}`;
    }
  }
  if (action === 'get_service_status') {
    const { service } = params;
    if (!service) return 'Error: "service" parameter is required.';
    if (!isValidServiceName(service)) return 'Error: "service" contains invalid characters. Only letters, numbers, ".", "_", and "-" are allowed.';
    try {
      const platform = os.platform();
      if (platform === 'win32') {
        let taskOutput = '';
        try {
          const { stdout } = await execPromise(`powershell -Command "Get-ScheduledTask -TaskName PATTI-Assistant -ErrorAction SilentlyContinue | Select-Object TaskName, State | Format-List"`);
          taskOutput = stdout.trim() || 'Scheduled Task "PATTI-Assistant" not found.';
        } catch (e) {
          taskOutput = `Scheduled Task check failed: ${e.message}`;
        }
        
        let processOutput = '';
        try {
          const { stdout } = await execPromise(`powershell -Command "Get-Process -Name node -ErrorAction SilentlyContinue | Select-Object Id, CPU, ProcessName | Format-Table"`);
          processOutput = stdout.trim() ? `\n\nActive Node Processes:\n${stdout.trim()}` : '\n\nNo active Node.js processes found.';
        } catch (e) {}

        let serviceOutput = '';
        try {
          const { stdout } = await execPromise(`powershell -Command "Get-Service -Name ${service} -ErrorAction SilentlyContinue | Format-List"`);
          if (stdout.trim()) {
            serviceOutput = `\n\nWindows Service "${service}":\n${stdout.trim()}`;
          }
        } catch (e) {}

        return `### ⚙️ Windows Server Task & Process Status\n\`\`\`\n${taskOutput}${processOutput}${serviceOutput}\n\`\`\``;
      }

      if (!capabilities.systemd) {
        return `Service status check for "${service}" is only supported on devices with systemd (current: ${deviceType}).`;
      }
      const { stdout } = await execPromise(`systemctl status ${service}`);
      return `### ⚙️ Service Status: ${service}\n\`\`\`\n${stdout}\n\`\`\``;
    } catch (err) {
      return `Error checking service status: ${err.message}\nStdout/Stderr:\n${err.stdout || ''}\n${err.stderr || ''}`;
    }
  }
  if (action === 'get_journal_logs') {
    const { service, lines } = params;
    if (!service) return 'Error: "service" parameter is required.';
    if (!isValidServiceName(service)) return 'Error: "service" contains invalid characters. Only letters, numbers, ".", "_", and "-" are allowed.';
    const numLines = Math.max(Number(lines) || 1000, 1000);
    try {
      const platform = os.platform();
      if (platform === 'win32') {
        try {
          const { stdout } = await execPromise(`powershell -Command "Get-EventLog -LogName Application -Newest 100 | Format-Table TimeGenerated, EntryType, Source, Message -Wrap"`);
          return `### 📜 Windows Event Logs (Application - Last 100 entries)\n\`\`\`\n${stdout.trim()}\n\`\`\``;
        } catch (e) {
          return `Error retrieving Windows Event Logs: ${e.message}`;
        }
      }

      if (!capabilities.systemd) {
        return `Service journal log check is only supported on devices with systemd (current: ${deviceType}).`;
      }
      const { stdout } = await execPromise(`journalctl -u ${service} -n ${numLines}`);
      return `### 📜 Journal Logs for ${service} (Last ${numLines} lines)\n\`\`\`\n${stdout}\n\`\`\``;
    } catch (err) {
      return `Error reading journal logs: ${err.message}`;
    }
  }
  if (action === 'restart_service') {
    const { service } = params;
    if (!service) return 'Error: "service" parameter is required.';
    if (!isValidServiceName(service)) return 'Error: "service" contains invalid characters. Only letters, numbers, ".", "_", and "-" are allowed.';
    try {
      const platform = os.platform();
      if (platform === 'win32') {
        try {
          await execPromise(`powershell -Command "Stop-ScheduledTask -TaskName PATTI-Assistant -ErrorAction SilentlyContinue"`);
          await execPromise(`powershell -Command "Start-ScheduledTask -TaskName PATTI-Assistant -ErrorAction SilentlyContinue"`);
          return `Successfully restarted Windows scheduled task "PATTI-Assistant".`;
        } catch (e) {
          try {
            await execPromise(`powershell -Command "Restart-Service -Name ${service} -Force"`);
            return `Successfully restarted Windows service "${service}".`;
          } catch (err2) {
            return `Error restarting Windows service/task: ${e.message} / ${err2.message}`;
          }
        }
      }

      if (!capabilities.systemd) {
        return `Service restart is only supported on devices with systemd (current: ${deviceType}).`;
      }
      await execPromise(`sudo systemctl restart ${service}`);
      return `Successfully restarted service "${service}".`;
    } catch (err) {
      return `Error restarting service: ${err.message}`;
    }
  }
  if (action === 'run_script') {
    const { scriptPath } = params;
    if (!scriptPath) return 'Error: "scriptPath" parameter is required.';
    try {
      const safePath = resolveSafePath(scriptPath);
      if (isUnderUntrustedUploadDir(safePath)) {
        return 'Error: Refusing to execute a script from the chat attachments directory - uploaded files are untrusted user content.';
      }
      if (!fs.existsSync(safePath)) {
        return `Error: Script not found at "${scriptPath}".`;
      }
      const ext = path.extname(safePath);
      const runner = ext === '.py' ? 'python3' : ext === '.sh' ? 'bash' : '';
      const cmd = runner ? `${runner} "${safePath}"` : `"${safePath}"`;
      const { stdout, stderr } = await execPromise(cmd, { cwd: process.cwd() });
      let output = '';
      if (stdout) output += `### Script Output (Stdout):\n${stdout}\n`;
      if (stderr) output += `### Script Error (Stderr):\n${stderr}\n`;
      return output || 'Script executed successfully with no output.';
    } catch (err) {
      return `Script execution failed: ${err.message}\n${err.stdout ? `Stdout:\n${err.stdout}\n` : ''}${err.stderr ? `Stderr:\n${err.stderr}\n` : ''}`;
    }
  }
  if (action === 'check_updates') {
    try {
      if (os.platform() === 'win32') {
        return 'System package update check is only supported on Debian/Ubuntu Linux.';
      }
      const { stdout } = await execPromise('apt-get -s upgrade');
      return `### 🔄 Dry Run System Package Updates (apt-get -s upgrade)\n\`\`\`\n${stdout}\n\`\`\``;
    } catch (err) {
      return `Error checking updates: ${err.message}`;
    }
  }
  if (action === 'security_scan') {
    try {
      const platform = os.platform();
      let output = '### 🛡️ Security Scan Report\n';
      if (platform === 'win32') {
        let firewallInfo = '';
        try {
          const { stdout } = await execPromise('netsh advfirewall show allprofiles state');
          firewallInfo = `\n**Firewall State**:\n\`\`\`\n${stdout.trim()}\n\`\`\``;
        } catch (e) {
          firewallInfo = `\nFailed to retrieve firewall state: ${e.message}`;
        }
        
        let portInfo = '';
        try {
          const { stdout } = await execPromise('netstat -ano | findstr LISTENING | head -n 10 || netstat -ano | findstr LISTENING');
          portInfo = `\n**Top Listening Ports**:\n\`\`\`\n${stdout.trim().substring(0, 1000)}\n\`\`\``;
        } catch (e) {
          portInfo = `\nFailed to retrieve listening ports: ${e.message}`;
        }

        output += `**Platform**: Windows\n${firewallInfo}\n${portInfo}`;
      } else {
        let firewallInfo = '';
        try {
          const { stdout } = await execPromise('sudo ufw status || iptables -L -n | head -n 10');
          firewallInfo = `\n**Firewall State**:\n\`\`\`\n${stdout.trim()}\n\`\`\``;
        } catch (e) {
          firewallInfo = `\nFailed to retrieve firewall/iptables state: ${e.message}`;
        }

        let portInfo = '';
        try {
          const { stdout } = await execPromise('ss -tulpn || netstat -tulpn');
          portInfo = `\n**Listening Ports**:\n\`\`\`\n${stdout.trim().substring(0, 1000)}\n\`\`\``;
        } catch (e) {
          portInfo = `\nFailed to retrieve listening ports: ${e.message}`;
        }

        output += `**Platform**: Linux\n${firewallInfo}\n${portInfo}`;
      }
      return output;
    } catch (err) {
      return `Error running security scan: ${err.message}`;
    }
  }

  try {
    return await handleHostMachineTool('get_specifications', params, userId);
  } catch (err) {
    return `Error retrieving host machine specifications: ${err.message}`;
  }
}

module.exports = { handleHostMachineTool };
