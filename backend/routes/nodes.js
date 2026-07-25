const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { getDb } = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');
const {
  checkTcpPort,
  discoverAndSyncNodes
} = require('../utils/network_discovery');

// Public discovery endpoint
router.get('/discovery', async (req, res) => {
  try {
    const db = await getDb();
    const settings = await db.get('SELECT device_type, is_main_host FROM user_settings LIMIT 1') || {};
    res.json({
      success: true,
      device_type: settings.device_type || 'unknown',
      is_main_host: settings.is_main_host === 1,
      port: process.env.PORT || 3000
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Authenticated network scan endpoint - discovers real, reachable devices (mDNS Cast,
// other PATTI nodes, or anything answering GET /health) and syncs them into network_nodes.
router.post('/scan', authenticateToken, async (req, res) => {
  try {
    const db = await getDb();
    const nodes = await discoverAndSyncNodes(db, req.user.id);
    res.json({ success: true, nodes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all network nodes
router.get('/', authenticateToken, async (req, res) => {
  try {
    const db = await getDb();
    const nodes = await db.all('SELECT id, node_name, device_type, ip_address, port, last_seen, is_online, created_at, ssh_username, ssh_password, ssh_key FROM network_nodes WHERE user_id = ?', [req.user.id]);
    const decryptedNodes = nodes.map(node => ({
      ...node,
      ssh_password: node.ssh_password ? decrypt(node.ssh_password) : '',
      ssh_key: node.ssh_key ? decrypt(node.ssh_key) : ''
    }));
    res.json(decryptedNodes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a new node
router.post('/', authenticateToken, async (req, res) => {
  const { node_name, device_type, ip_address, port, bridge_secret, ssh_username, ssh_password, ssh_key } = req.body;
  
  if (!node_name || !device_type || !ip_address) {
    return res.status(400).json({ error: 'node_name, device_type, and ip_address are required' });
  }

  const targetPort = port || 3000;

  try {
    const db = await getDb();

    // Check if the node is already registered
    const existing = await db.get(
      'SELECT id FROM network_nodes WHERE user_id = ? AND ip_address = ? AND port = ?',
      [req.user.id, ip_address, targetPort]
    );
    if (existing) {
      return res.status(400).json({ error: 'Node with this IP address and port is already registered' });
    }

    const encPassword = ssh_password ? encrypt(ssh_password) : null;
    const encKey = ssh_key ? encrypt(ssh_key) : null;

    const result = await db.run(
      'INSERT INTO network_nodes (user_id, node_name, device_type, ip_address, port, bridge_secret, last_seen, is_online, ssh_username, ssh_password, ssh_key) VALUES (?, ?, ?, ?, ?, ?, datetime("now"), 1, ?, ?, ?)',
      [req.user.id, node_name, device_type, ip_address, targetPort, bridge_secret || null, ssh_username || null, encPassword, encKey]
    );
    
    res.json({ id: result.lastID, success: true, message: 'Node added successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a node
router.put('/:id', authenticateToken, async (req, res) => {
  const { node_name, device_type, ip_address, port, is_online, ssh_username, ssh_password, ssh_key } = req.body;
  const { id } = req.params;

  try {
    const db = await getDb();
    
    const encPassword = ssh_password ? encrypt(ssh_password) : null;
    const encKey = ssh_key ? encrypt(ssh_key) : null;
    
    await db.run(
      'UPDATE network_nodes SET node_name = ?, device_type = ?, ip_address = ?, port = ?, is_online = ?, ssh_username = ?, ssh_password = ?, ssh_key = ? WHERE id = ? AND user_id = ?',
      [node_name, device_type, ip_address, port, is_online, ssh_username || null, encPassword, encKey, id, req.user.id]
    );
    res.json({ success: true, message: 'Node updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a node
router.delete('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const db = await getDb();
    await db.run('DELETE FROM network_nodes WHERE id = ? AND user_id = ?', [id, req.user.id]);
    res.json({ success: true, message: 'Node deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ping a node to update last_seen and online status (simulated heartbeat)
router.post('/:id/ping', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const db = await getDb();
    await db.run('UPDATE network_nodes SET last_seen = datetime("now"), is_online = 1 WHERE id = ? AND user_id = ?', [id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check health of all registered nodes from the backend (avoiding CORS and JWT issues)
router.get('/health-check', authenticateToken, async (req, res) => {
  try {
    const db = await getDb();
    const nodes = await db.all('SELECT id, ip_address, port, device_type FROM network_nodes WHERE user_id = ?', [req.user.id]);
    
    const results = {};
    await Promise.all(
      nodes.map(async (node) => {
        let isOnline = false;
        
        // 1. Try health endpoint check
        try {
          const controller = new AbortController();
          const tId = setTimeout(() => controller.abort(), 600);
          const targetUrl = `http://${node.ip_address}:${node.port}/health`;
          const fetchRes = await fetch(targetUrl, { signal: controller.signal });
          clearTimeout(tId);
          if (fetchRes.ok) {
            const data = await fetchRes.json();
            if (data.ok === true || data.status === 'online') {
              isOnline = true;
            }
          }
        } catch (e) {
          // ignore
        }
        
        // 2. Fallback to /api/bridge/health for older configurations or setups
        if (!isOnline && node.device_type !== 'ESP32' && node.device_type !== 'Google Assistant') {
          try {
            const controller = new AbortController();
            const tId = setTimeout(() => controller.abort(), 600);
            const targetUrl = `http://${node.ip_address}:${node.port}/api/bridge/health`;
            const fetchRes = await fetch(targetUrl, { signal: controller.signal });
            clearTimeout(tId);
            if (fetchRes.ok) {
              isOnline = true;
            }
          } catch (e) {
            // ignore
          }
        }
        
        // 3. Fallback to raw TCP port check
        if (!isOnline) {
          isOnline = await checkTcpPort(node.ip_address, node.port, 400);
        }
        
        const isOnlineVal = isOnline ? 1 : 0;
        await db.run(
          'UPDATE network_nodes SET is_online = ?, last_seen = CASE WHEN ? = 1 THEN datetime("now") ELSE last_seen END WHERE id = ?',
          [isOnlineVal, isOnlineVal, node.id]
        );
        
        results[node.id] = { status: isOnline ? 'online' : 'offline' };
      })
    );
    
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sync network nodes - same underlying discovery as /scan (kept as a separate endpoint
// since the Device Messenger UI already calls this path, but no longer a different
// implementation: no hardcoded seed devices, no /message-POST ESP32 guessing).
router.post('/sync', authenticateToken, async (req, res) => {
  try {
    const db = await getDb();
    const nodes = await discoverAndSyncNodes(db, req.user.id);
    res.json({ success: true, nodes });
  } catch (err) {
    console.error('[Sync Network Error]:', err);
    res.status(500).json({ error: err.message });
  }
});

// Send a message to a network node / device (ESP32, Google Assistant, etc.)
router.post('/send-message', authenticateToken, async (req, res) => {
  const { ip_address, device_type, message } = req.body;
  
  if (!ip_address || !device_type || !message) {
    return res.status(400).json({ error: 'ip_address, device_type, and message are required' });
  }

  // Enforce 240 character limit locally
  if (message.length > 240) {
    const diff = message.length - 240;
    return res.status(400).json({
      ok: false,
      error: `message exceeds max length 240 by ${diff} characters`
    });
  }

  try {
    if (device_type === 'Google Assistant') {
      const db = await getDb();
      const { handleGoogleHomeTool } = require('../tools/google_home_tool');
      const toolResult = await handleGoogleHomeTool(db, req.user.id, 'speak_text', { text: message, device_ip: ip_address });
      
      try {
        const parsed = JSON.parse(toolResult);
        if (parsed.success) {
          return res.json({ ok: true, message: 'Message spoken successfully' });
        } else {
          return res.status(500).json({ ok: false, error: parsed.error || toolResult });
        }
      } catch (e) {
        return res.json({ ok: true, output: toolResult });
      }
    } else {
      // Treat other devices (ESP32, RPi, Windows) using the handleEsp32Tool message endpoint
      const { handleEsp32Tool } = require('../tools/esp32_tool');
      const toolResult = await handleEsp32Tool(ip_address, null, 'send_message', { message });
      
      if (toolResult.startsWith('Error:')) {
        return res.status(500).json({ ok: false, error: toolResult });
      }

      try {
        const parsed = JSON.parse(toolResult);
        if (parsed.ok !== false && parsed.success !== false) {
          return res.json({ ok: true, data: parsed });
        } else {
          return res.status(500).json({ ok: false, error: parsed.error || toolResult });
        }
      } catch (e) {
        return res.json({ ok: true, output: toolResult });
      }
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Toggle the screen on an ESP32 device: POST http://{ip}:{port}/screen
// with body { "action": "toggle screen" } (handleEsp32Tool builds this).
router.post('/toggle-screen', authenticateToken, async (req, res) => {
  const { ip_address } = req.body;

  if (!ip_address) {
    return res.status(400).json({ error: 'ip_address is required' });
  }

  try {
    const { handleEsp32Tool } = require('../tools/esp32_tool');
    const toolResult = await handleEsp32Tool(ip_address, null, 'toggle_screen', {});

    if (toolResult.startsWith('Error:') || toolResult.startsWith('Failed to communicate')) {
      return res.status(500).json({ ok: false, error: toolResult });
    }

    try {
      const parsed = JSON.parse(toolResult);
      if (parsed.ok !== false && parsed.success !== false) {
        return res.json({ ok: true, data: parsed });
      } else {
        return res.status(500).json({ ok: false, error: parsed.error || toolResult });
      }
    } catch (e) {
      return res.json({ ok: true, output: toolResult });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
