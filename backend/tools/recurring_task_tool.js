// Recurring automated task management (SQLite-backed). Creation/listing/pausing/
// deleting of a user-defined recurring request (e.g. "every weekday at 7am, give me
// weather and Cowboys news") - see utils/recurring_tasks_scheduler.js for execution.

const VALID_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAY = ['mon', 'tue', 'wed', 'thu', 'fri'];
const WEEKEND = ['sat', 'sun'];
// Mirrors the fan-out guards already used elsewhere for unbounded conversational
// resource creation (e.g. sports_tool.js's MAX_FAVORITE_TEAMS_PER_LOOKUP).
const MAX_ACTIVE_TASKS_PER_USER = 20;

// Accepts whatever loose day-pattern token the LLM produces - shorthand
// ("daily"/"weekday"/"weekend"), full day names, abbreviations, mixed case/spacing -
// and normalizes it to a sorted, deduped comma list of 3-letter lowercase codes.
// Returns null if any token isn't recognizable, so the caller can report a clear error.
function normalizeDaysOfWeek(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (['daily', 'every day', 'everyday', 'all', 'all days'].includes(s)) return VALID_DAYS.join(',');
  if (['weekday', 'weekdays'].includes(s)) return WEEKDAY.join(',');
  if (['weekend', 'weekends'].includes(s)) return WEEKEND.join(',');

  const tokens = s.split(/[,\s]+/).filter(Boolean);
  const resolved = tokens.map(t => {
    const abbr = t.slice(0, 3);
    return VALID_DAYS.includes(abbr) ? abbr : null;
  });
  if (resolved.length === 0 || resolved.some(d => !d)) return null;
  return [...new Set(resolved)]
    .sort((a, b) => VALID_DAYS.indexOf(a) - VALID_DAYS.indexOf(b))
    .join(',');
}

function deriveLabel(prompt) {
  const clean = prompt.trim().replace(/\s+/g, ' ');
  return clean.length <= 40 ? clean : clean.slice(0, 37).trimEnd() + '...';
}

async function handleRecurringTaskTool(db, userId, action, params = {}) {
  if (action === 'create') {
    const { prompt, days_of_week, hour, label, news_query } = params;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return JSON.stringify({ error: 'prompt is required' });
    }
    const normalizedDays = normalizeDaysOfWeek(days_of_week);
    if (!normalizedDays) {
      return JSON.stringify({ error: `Could not understand the day pattern "${days_of_week}". Use "daily", "weekday", "weekend", or a list like "mon,wed,fri".` });
    }

    let normalizedHour = 7;
    if (hour !== undefined && hour !== null && hour !== '') {
      const h = Number(hour);
      if (!Number.isInteger(h) || h < 0 || h > 23) {
        return JSON.stringify({ error: `hour must be an integer 0-23, got "${hour}"` });
      }
      normalizedHour = h;
    }

    const activeCount = await db.get(
      'SELECT COUNT(*) as count FROM recurring_tasks WHERE user_id = ? AND is_active = 1',
      [userId]
    );
    if (activeCount.count >= MAX_ACTIVE_TASKS_PER_USER) {
      return JSON.stringify({ error: `You already have ${MAX_ACTIVE_TASKS_PER_USER} active recurring tasks, which is the limit. Pause or delete one before creating another.` });
    }

    const cleanLabel = (label && label.trim()) || deriveLabel(prompt);
    const result = await db.run(
      `INSERT INTO recurring_tasks (user_id, label, prompt, news_query, days_of_week, hour) VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, cleanLabel, prompt.trim(), news_query ? news_query.trim() : null, normalizedDays, normalizedHour]
    );
    return JSON.stringify({
      success: true,
      taskId: result.lastID,
      label: cleanLabel,
      days_of_week: normalizedDays,
      hour: normalizedHour,
      message: `Recurring task "${cleanLabel}" created: runs on ${normalizedDays} at ${normalizedHour}:00.`
    });
  }

  if (action === 'list') {
    const tasks = await db.all(
      'SELECT id, label, prompt, days_of_week, hour, is_active, last_run_at FROM recurring_tasks WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
    return JSON.stringify(tasks);
  }

  if (action === 'pause' || action === 'resume') {
    const { taskId } = params;
    if (!taskId) return JSON.stringify({ error: 'taskId is required' });

    if (action === 'resume') {
      // Same cap check as 'create' - without it, pause + create-more + resume can push
      // a user past MAX_ACTIVE_TASKS_PER_USER, since only 'create' enforced the ceiling.
      const activeCount = await db.get(
        'SELECT COUNT(*) as count FROM recurring_tasks WHERE user_id = ? AND is_active = 1',
        [userId]
      );
      if (activeCount.count >= MAX_ACTIVE_TASKS_PER_USER) {
        return JSON.stringify({ error: `You already have ${MAX_ACTIVE_TASKS_PER_USER} active recurring tasks, which is the limit. Pause or delete one before resuming another.` });
      }
    }

    const result = await db.run(
      'UPDATE recurring_tasks SET is_active = ? WHERE id = ? AND user_id = ?',
      [action === 'resume' ? 1 : 0, taskId, userId]
    );
    if (result.changes === 0) return JSON.stringify({ error: `No recurring task found with id ${taskId}` });
    return JSON.stringify({ success: true, message: `Task ${taskId} ${action === 'resume' ? 'resumed' : 'paused'}.` });
  }

  if (action === 'delete') {
    const { taskId } = params;
    if (!taskId) return JSON.stringify({ error: 'taskId is required' });
    const result = await db.run('DELETE FROM recurring_tasks WHERE id = ? AND user_id = ?', [taskId, userId]);
    if (result.changes === 0) return JSON.stringify({ error: `No recurring task found with id ${taskId}` });
    return JSON.stringify({ success: true, message: `Task ${taskId} deleted.` });
  }

  return JSON.stringify({ error: 'Unknown recurring_task action' });
}

module.exports = { handleRecurringTaskTool, normalizeDaysOfWeek, MAX_ACTIVE_TASKS_PER_USER };
