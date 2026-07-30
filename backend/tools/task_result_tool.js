const logger = require('../utils/logger');

// Defensive ceiling on a single subtask_results row's content, independent of
// the aggregate cap enforced by the caller (backend/services/synthesis_gather.js) -
// protects against one pathologically large row (e.g. a runaway tool result)
// blowing out a single read regardless of how the aggregate budget is spent.
const TASK_RESULT_READ_CAP = 20000;

/**
 * Lets an agent (the Supervisor, or the synthesis gather loop) read
 * subtask_results rows by id instead of having the full text inlined into
 * its prompt by the caller. Mirrors job_store_tool.js's list/read shape, but
 * pages by ROW (each subtask_results row is already a discrete delegated
 * result) rather than by byte-offset chunk like agent_job_store.
 *
 * `context.requestId` is the only source of scoping - it is always supplied
 * by the server-side caller, never read from `params`, so a hallucinated or
 * injected request_id/id can never leak another chat's data.
 *
 * @param {import('sqlite').Database} db SQLite DB instance
 * @param {string} action 'list' | 'read'
 * @param {object} params Action-specific parameters
 * @param {object} context Must include `requestId`
 * @returns {Promise<string>} JSON (or plain "Error: ..." string) result for the calling agent
 */
async function handleTaskResultTool(db, action, params = {}, context = {}) {
  if (!db) {
    return 'Error: Database connection is not available.';
  }
  const requestId = context.requestId;
  if (!requestId) {
    return 'Error: No request_id in scope for this task_result lookup.';
  }
  try {
    if (action === 'list') return await listResults(db, requestId);
    if (action === 'read') return await readResult(db, requestId, params);
    return `Error: Unknown task_result action "${action}". Valid actions: list, read.`;
  } catch (err) {
    logger.error('Task result tool error:', err);
    return `Error: ${err.message}`;
  }
}

async function listResults(db, requestId) {
  const results = await db.all(
    'SELECT id, agent_name, task_label, status, LENGTH(result_text) as char_count FROM subtask_results WHERE request_id = ? ORDER BY id',
    [requestId]
  );
  return JSON.stringify({ results: results || [], count: results ? results.length : 0 });
}

async function readResult(db, requestId, params) {
  const id = params.id ?? params.result_id;
  if (id === undefined || id === null || id === '') {
    return 'Error: "id" parameter is required.';
  }
  const row = await db.get(
    'SELECT id, agent_name, task_label, result_text, status FROM subtask_results WHERE id = ? AND request_id = ?',
    [id, requestId]
  );
  if (!row) {
    return `Error: No subtask result with id ${id} for this request.`;
  }

  const fullText = row.result_text || '';
  const truncated = fullText.length > TASK_RESULT_READ_CAP;
  const content = truncated ? fullText.slice(0, TASK_RESULT_READ_CAP) + '\n... [TRUNCATED: Response too large for context]' : fullText;

  return JSON.stringify({
    id: row.id,
    agent_name: row.agent_name,
    task_label: row.task_label,
    status: row.status,
    content,
    char_count: fullText.length,
    truncated
  });
}

module.exports = { handleTaskResultTool, TASK_RESULT_READ_CAP };
