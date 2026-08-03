const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');

// Maps each connected client's response stream to the userId that authenticated it.
// System-status alerts (streaming_status, agent_status, tool_call, ai_state,
// node_status_change, error/warning) are intentionally broadcast to everyone regardless
// of userId - the standalone monitor_dashboard app connects here too, with its own
// token, specifically to watch this activity across whichever user is active on the
// main app. Only alerts that carry real per-user content (see broadcastAlert's userId
// param) get scoped to a single user's own connections.
const activeClients = new Map();

router.get('/stream', authenticateToken, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  activeClients.set(res, req.user.id);
  logger.info(`[Alerts Stream] Client connected. Total active clients: ${activeClients.size}`);

  // Send keep-alive heartbeat
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    activeClients.delete(res);
    logger.info(`[Alerts Stream] Client disconnected. Total active clients: ${activeClients.size}`);
  });
});

// `userId` is optional: omit it (as every existing system-status caller does) to
// broadcast to every connected client, unchanged from this function's original
// behavior. Pass it to scope delivery to only that user's own connected tabs/devices -
// used for alerts that carry real private content (see utils/notifications.js).
function broadcastAlert(alert, userId) {
  logger.info(`[Alerts Stream] Broadcasting system alert${userId ? ` (userId=${userId})` : ''}: ${JSON.stringify(alert)}`);
  const data = typeof alert === 'object' ? JSON.stringify(alert) : alert;

  for (const [client, clientUserId] of activeClients) {
    if (userId && clientUserId !== userId) continue;
    try {
      client.write(`data: ${data}\n\n`);
    } catch (err) {
      logger.error('[Alerts Stream] Failed to write alert to client:', err);
    }
  }
}

module.exports = router;
module.exports.broadcastAlert = broadcastAlert;
