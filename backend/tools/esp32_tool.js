const mqttService = require('../services/mqtt_service');

// ESP32 boards in this fleet (esp32_firmware/main.py) are MicroPython, MQTT-only - they
// never start an HTTP server, so control commands route over the same MQTT request/response
// channel already proven for get_system_info (see remote_node_tool.js / mqtt_service.js's
// publishAndAwaitResponse). "Not implemented" for a given command is decided by the firmware
// itself (single source of truth), not duplicated as a whitelist here.
const REQUEST_TIMEOUT_MS = 8000;

// Derives the MQTT client/node ID from a network_nodes row the same way remote_node_tool.js
// does: mqtt_topic may be stored as a bare ID or a full "nodes/<id>/responses"-shaped topic.
function deriveMqttId(node) {
  let mqttId = node.mqtt_topic || '';
  return mqttId.replace(/^nodes\//, '').replace(/\/.*$/, '');
}

async function resolveNode(ip) {
  const { getDb } = require('../db');
  const db = await getDb();
  const node = await db.get(
    'SELECT id, node_name, device_type, mqtt_topic FROM network_nodes WHERE ip_address = ?',
    [ip]
  );
  if (!node) {
    return { error: `No registered node found for IP ${ip}. Add it under Field Nodes first.` };
  }
  const mqttId = deriveMqttId(node);
  if (!mqttId) {
    return { error: `Node "${node.node_name}" at ${ip} has no MQTT ID configured. Set its MQTT Topic to the ID the board prints on its serial console at boot (e.g. "esp32_a1b2c3d4e5f6") under Field Nodes.` };
  }
  return { node, mqttId };
}

/**
 * Sends a command to an ESP32 node over MQTT (publish + await correlated response on
 * nodes/<id>/responses), matching the protocol the firmware actually implements.
 */
async function handleEsp32Tool(nodeIp, nodePort, action, params = {}) {
  const ip = nodeIp || process.env.ESP32_DEFAULT_IP || null;
  if (!ip) {
    return 'Error: No ESP32 IP address provided. Pass an IP address or set the ESP32_DEFAULT_IP environment variable.';
  }

  let node;
  let mqttId;
  try {
    const resolved = await resolveNode(ip);
    if (resolved.error) {
      return `Error: ${resolved.error}`;
    }
    node = resolved.node;
    mqttId = resolved.mqttId;
  } catch (err) {
    return `Error: Failed to look up registered node for ${ip}: ${err.message}`;
  }

  const devType = (node.device_type || '').toLowerCase();
  const isEsp32 = !devType || devType.includes('esp32');
  const deviceName = isEsp32 ? 'ESP32' : 'device';

  try {
    const result = await mqttService.publishAndAwaitResponse(mqttId, action, REQUEST_TIMEOUT_MS, params);

    if (result && result.status === 'error') {
      const detail = result.data && result.data.error ? result.data.error : 'ESP32 reported an error.';
      return `Error: ${detail}`;
    }

    return JSON.stringify((result && result.data) || { success: true });
  } catch (err) {
    if (action === 'send_message') {
      return `Error: Failed to communicate with ${deviceName} at ${ip}. The device did not respond over MQTT. Please verify if the device is online and try again with the updated/corrected IP address. (Details: ${err.message})`;
    }
    return `Failed to communicate with ${deviceName} at ${ip}: ${err.message}`;
  }
}

module.exports = {
  handleEsp32Tool
};
