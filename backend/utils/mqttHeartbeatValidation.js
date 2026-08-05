const net = require('net');

// The MQTT broker has no application-level auth of its own by default (see SEC-7 in
// docs/REVIEW_2026-08-03.md) - anything that can publish to nodes/heartbeat can otherwise
// inject/overwrite arbitrary rows in network_nodes. This is a shape check, not real
// authentication (that requires broker-level auth/TLS + updating every field node's
// credentials, an operational change outside this codebase), but it stops obviously
// malformed/garbage payloads from being written.
function isValidHeartbeatPayload(payload) {
  if (!payload || typeof payload.nodeId !== 'string') return false;
  if (payload.nodeId.length === 0 || payload.nodeId.length > 100) return false;
  if (!/^[a-zA-Z0-9_.-]+$/.test(payload.nodeId)) return false;
  if (payload.ip_address !== undefined && payload.ip_address !== null) {
    if (typeof payload.ip_address !== 'string' || net.isIP(payload.ip_address) === 0) return false;
  }
  if (payload.port !== undefined && payload.port !== null) {
    const port = Number(payload.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  }
  if (payload.device_type !== undefined && payload.device_type !== null) {
    if (typeof payload.device_type !== 'string' || payload.device_type.length > 50) return false;
  }
  if (payload.os !== undefined && payload.os !== null) {
    if (typeof payload.os !== 'string' || payload.os.length > 50) return false;
  }
  return true;
}

module.exports = { isValidHeartbeatPayload };
