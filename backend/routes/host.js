const express = require('express');
const router = express.Router();
const os = require('os');
const { authenticateToken } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/adminAuth');
const { handleHostMachineTool } = require('../tools/host_machine_tool');
const { getDb } = require('../db');

router.get('/status', authenticateToken, async (req, res) => {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const uptime = os.uptime();
    
    // CPU usage estimation
    const cpus = os.cpus();
    const cpuModel = cpus[0]?.model || 'Unknown';
    const cpuCores = cpus.length;

    // Get telemetry from tools
    const tempReport = await handleHostMachineTool('get_temperature');
    const powerReport = await handleHostMachineTool('get_power');
    const netReport = await handleHostMachineTool('get_network_info');
    const capabilities = await handleHostMachineTool('get_capabilities', {}, req.user.id);

    res.json({
      deviceType: capabilities.deviceType,
      isMainHost: capabilities.isMainHost,
      capabilities: capabilities.capabilities,
      cpu: {
        model: cpuModel,
        cores: cpuCores,
        loadAvg: os.loadavg()
      },
      memory: {
        total: totalMem,
        free: freeMem,
        used: totalMem - freeMem,
        percentage: ((totalMem - freeMem) / totalMem * 100).toFixed(1)
      },
      uptime: uptime,
      telemetry: {
        temperature: tempReport,
        power: powerReport,
        network: netReport
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restart systemd service - admin only: this runs a real shell command on the host.
router.post('/service/restart', authenticateToken, requireAdmin, async (req, res) => {
  const { service } = req.body;
  if (!service) return res.status(400).json({ error: 'Service name is required' });
  
  try {
    const result = await handleHostMachineTool('restart_service', { service });
    if (result.includes('Successfully')) {
      res.json({ success: true, message: result });
    } else {
      res.status(400).json({ error: result });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger GPIO script execution - admin only: this executes an arbitrary script on the host.
router.post('/gpio/run', authenticateToken, requireAdmin, async (req, res) => {
  const { scriptPath } = req.body;
  if (!scriptPath) return res.status(400).json({ error: 'scriptPath is required' });

  try {
    const result = await handleHostMachineTool('run_script', { scriptPath });
    res.json({ success: true, output: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Retrieve the last 200 lines of application logs
router.get('/logs', authenticateToken, async (req, res) => {
  const fs = require('fs');
  const path = require('path');
  try {
    const logPath = path.join(__dirname, '../../app.log');
    if (!fs.existsSync(logPath)) {
      return res.json({ logs: 'No logs file found yet.' });
    }
    const logsContent = fs.readFileSync(logPath, 'utf8');
    const lines = logsContent.split('\n');
    const lastLines = lines.slice(-200).join('\n');
    res.json({ logs: lastLines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;



