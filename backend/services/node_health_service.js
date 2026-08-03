const { getDb } = require('../db');
const net = require('net');
const logger = require('../utils/logger');
const { broadcastAlert } = require('../routes/alerts');

let isRunning = false;
let timerId = null;

function checkIpPort(ip, port, timeout = 600) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let isDone = false;
    
    socket.setTimeout(timeout);
    
    socket.on('connect', () => {
      socket.destroy();
      if (!isDone) {
        isDone = true;
        resolve(true);
      }
    });
    
    const handleError = () => {
      socket.destroy();
      if (!isDone) {
        isDone = true;
        resolve(false);
      }
    };
    
    socket.on('error', handleError);
    socket.on('timeout', handleError);
    
    socket.connect(port, ip);
  });
}

// ESP32 boards (esp32_firmware/main.py) are MQTT-only - they never listen on any TCP
// port, so HTTP/TCP probing (below) can never succeed for one. The only real signal of
// life is a round trip over the same MQTT request/response channel esp32_tool.js and
// remote_node_tool.js already use.
async function checkEsp32Health(node) {
  let mqttId = (node.mqtt_topic || '').replace(/^nodes\//, '').replace(/\/.*$/, '');
  if (!mqttId) return false;
  try {
    const mqttService = require('./mqtt_service');
    const result = await mqttService.publishAndAwaitResponse(mqttId, 'get_system_info', 4000);
    return !!(result && result.status === 'success');
  } catch (e) {
    return false;
  }
}

async function checkNodeHealth(node) {
  const deviceType = (node.device_type || '').toLowerCase();
  if (deviceType.includes('esp32')) {
    return checkEsp32Health(node);
  }

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
  if (!isOnline && deviceType !== 'google assistant') {
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
    isOnline = await checkIpPort(node.ip_address, node.port, 400);
  }

  return isOnline;
}

async function runHealthCheck() {
  if (isRunning) return;
  isRunning = true;
  
  try {
    const db = await getDb();
    const nodes = await db.all('SELECT id, node_name, ip_address, port, device_type, is_online, mqtt_topic FROM network_nodes');
    
    await Promise.all(
      nodes.map(async (node) => {
        const isOnline = await checkNodeHealth(node);
        const isOnlineVal = isOnline ? 1 : 0;
        
        // If status has changed, update DB and broadcast SSE alert
        if (isOnlineVal !== node.is_online) {
          logger.info(`[Node Health Daemon] Node ${node.node_name} (${node.ip_address}) changed status from ${node.is_online ? 'online' : 'offline'} to ${isOnline ? 'online' : 'offline'}`);
          
          await db.run(
            'UPDATE network_nodes SET is_online = ?, last_seen = CASE WHEN ? = 1 THEN datetime("now") ELSE last_seen END WHERE id = ?',
            [isOnlineVal, isOnlineVal, node.id]
          );
          
          broadcastAlert({
            type: 'node_status_change',
            nodeId: node.id,
            status: isOnline ? 'online' : 'offline',
            nodeName: node.node_name,
            ipAddress: node.ip_address
          });
        }
      })
    );
  } catch (err) {
    logger.error('[Node Health Daemon] Error during background health check:', err);
  } finally {
    isRunning = false;
    // Schedule next run in 10 seconds
    timerId = setTimeout(runHealthCheck, 10000);
  }
}

function startDaemon() {
  if (timerId) return;
  logger.info('[Node Health Daemon] Starting background node health check daemon...');
  // Run first check after 2 seconds
  timerId = setTimeout(runHealthCheck, 2000);
}

function stopDaemon() {
  if (timerId) {
    clearTimeout(timerId);
    timerId = null;
    logger.info('[Node Health Daemon] Stopped background node health check daemon.');
  }
}

module.exports = {
  startDaemon,
  stopDaemon,
  checkNodeHealth
};
