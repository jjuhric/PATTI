/**
 * Shared data-gathering helpers for background digests (the daily briefing and
 * recurring tasks). Both need "today's calendar events" and "the user's stored
 * memories" formatted the same way - extracted here rather than duplicated so both
 * schedulers stay in sync, and so this doesn't route through calendar_tool.js's
 * `list` action, whose default date (when none is passed) resolves in UTC rather than
 * the user's own local date - the same class of per-user-timezone bug fixed elsewhere
 * in this codebase. `dateStr` here is always caller-supplied from getUserLocalNow, so
 * the query is always scoped to the user's own local "today".
 */

async function getTodayEventsFormatted(db, userId, dateStr) {
  const events = await db.all(
    `SELECT * FROM calendar_events
     WHERE user_id = ?
       AND (start_time LIKE ? OR start_time LIKE ?)`,
    [userId, `${dateStr}%`, `%${dateStr}%`]
  );
  return events.length > 0
    ? events.map(e => `- [${e.start_time}] ${e.title}: ${e.description || 'No desc'}`).join('\n')
    : 'No events scheduled for today.';
}

async function getUserMemoriesFormatted(db, userId) {
  const memories = await db.all(
    `SELECT content FROM memories
     WHERE user_id = ?
       AND (expires_at IS NULL OR expires_at > datetime('now'))`,
    [userId]
  );
  return memories.length > 0
    ? memories.map(m => `- ${m.content}`).join('\n')
    : 'No stored user memories found.';
}

module.exports = { getTodayEventsFormatted, getUserMemoriesFormatted };
