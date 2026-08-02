const logger = require('./logger');
const { broadcastAlert } = require('../routes/alerts');

// Persists a background-job notification (deep research, course generation, dev builds,
// daily briefing) so it survives even if no browser tab was connected to the SSE stream
// when it happened, then does the same live broadcastAlert() every other alert already
// uses so open tabs still see it immediately. `notificationId` in the broadcast payload
// lets the frontend tell "a real persisted notification" apart from the many other
// broadcastAlert types (agent_status, tool_call, streaming_status, ai_state, etc.)
// without needing to enumerate/exclude those by `type`.
async function notifyUser(db, userId, { type = 'info', message, chatId = null } = {}) {
  if (!message) {
    throw new Error('notifyUser requires a message.');
  }

  const result = await db.run(
    'INSERT INTO notifications (user_id, type, message, chat_id) VALUES (?, ?, ?, ?)',
    [userId, type, message, chatId || null]
  );
  const notificationId = result.lastID;

  try {
    broadcastAlert({ type, message, chatId: chatId || null, notificationId, timestamp: new Date().toISOString() });
  } catch (err) {
    logger.warn('[Notifications] Failed to broadcast live alert:', err.message);
  }

  return notificationId;
}

module.exports = { notifyUser };
