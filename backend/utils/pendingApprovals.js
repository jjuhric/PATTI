const crypto = require('crypto');

// SEC-3 (docs/REVIEW_2026-08-03.md): persists a human-in-the-loop approval request created by
// the real verification code path (coder_tools.js), so the chat-based "yes"/"no" reply can be
// matched against genuine server-side state instead of being re-parsed from the displayed
// message text - which a model that's ingested manipulated content (a web page, a tool result)
// could otherwise be tricked into fabricating.
//
// Best-effort: callers without db/chatId/userId (e.g. the PATTI-client bridge, which doesn't
// run the interactive chat approval loop at all) get `null` back and nothing is persisted -
// their returned message text is unaffected either way.
async function createPendingApproval(options, { action, agentName, command, filePath, fileContent }) {
  const { db, chatId, userId } = options || {};
  if (!db || typeof db.run !== 'function' || !chatId || !userId) return null;

  const token = crypto.randomBytes(16).toString('hex');
  try {
    // Superseding any still-open request for this chat avoids stale rows piling up if the
    // agent proposes a new action before the user ever answered the previous one.
    await db.run(
      "UPDATE pending_approvals SET status = 'superseded', resolved_at = CURRENT_TIMESTAMP WHERE chat_id = ? AND status = 'pending'",
      [chatId]
    );
    await db.run(
      `INSERT INTO pending_approvals (token, user_id, chat_id, action, agent_name, command, file_path, file_content)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [token, userId, chatId, action, agentName || null, command || null, filePath || null, fileContent || null]
    );
  } catch (err) {
    console.error('Failed to persist pending approval:', err.message);
    return null;
  }
  return token;
}

async function getPendingApproval(db, userId, chatId) {
  if (!db || typeof db.get !== 'function' || !chatId || !userId) return null;
  try {
    return await db.get(
      "SELECT * FROM pending_approvals WHERE chat_id = ? AND user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      [chatId, userId]
    );
  } catch (err) {
    console.error('Failed to look up pending approval:', err.message);
    return null;
  }
}

async function resolvePendingApproval(db, id, status) {
  if (!db || typeof db.run !== 'function' || !id) return;
  try {
    await db.run(
      "UPDATE pending_approvals SET status = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?",
      [status, id]
    );
  } catch (err) {
    console.error('Failed to resolve pending approval:', err.message);
  }
}

module.exports = { createPendingApproval, getPendingApproval, resolvePendingApproval };
