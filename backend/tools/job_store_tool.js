const logger = require('../utils/logger');

const DEFAULT_CHUNK_SIZE = 4000;

/**
 * General-purpose DB-backed context paging, available to every worker agent. Lets a large
 * task description (a 'spec', written by a caller like the Supervisor's delegation path)
 * or an agent's own working notes (a 'note', written by the agent itself as it makes
 * progress) live in SQLite instead of the live LLM prompt - only a small job_id pointer
 * and a paged read need to be resident in context at any one time. See agent_job_store in
 * backend/schema.sql.
 *
 * @param {import('sqlite').Database} db SQLite DB instance
 * @param {string} action 'read_spec' | 'write_note' | 'read_notes'
 * @param {object} params Action-specific parameters
 * @returns {Promise<string>} Text result for the calling agent
 */
async function handleJobStoreTool(db, action, params = {}) {
  if (!db) {
    return 'Error: Database connection is not available.';
  }
  try {
    if (action === 'read_spec') return await readEntries(db, params, 'spec');
    if (action === 'write_note') return await writeNote(db, params);
    if (action === 'read_notes') return await readEntries(db, params, 'note');
    return `Error: Unknown Job Store action "${action}". Valid actions: read_spec, write_note, read_notes.`;
  } catch (err) {
    logger.error('Job store tool error:', err);
    return `Error: ${err.message}`;
  }
}

function extractJobId(params) {
  return params.job_id || params.jobId || null;
}

async function readEntries(db, params, entryType) {
  const jobId = extractJobId(params);
  if (!jobId) {
    return 'Error: "job_id" parameter is required.';
  }
  const seq = Number.isInteger(params.seq) ? params.seq : parseInt(params.seq, 10) || 0;

  const totalRow = await db.get(
    'SELECT COUNT(*) as count FROM agent_job_store WHERE job_id = ? AND entry_type = ?',
    [jobId, entryType]
  );
  const totalChunks = totalRow ? totalRow.count : 0;

  if (totalChunks === 0) {
    return JSON.stringify({ content: '', seq: 0, hasMore: false, totalChunks: 0 });
  }

  const row = await db.get(
    'SELECT content FROM agent_job_store WHERE job_id = ? AND entry_type = ? AND seq = ?',
    [jobId, entryType, seq]
  );
  if (!row) {
    return `Error: No ${entryType} chunk at seq ${seq} for job "${jobId}" (${totalChunks} chunk(s) total, valid seq range 0-${totalChunks - 1}).`;
  }

  return JSON.stringify({
    content: row.content,
    seq,
    hasMore: seq + 1 < totalChunks,
    totalChunks
  });
}

async function writeNote(db, params) {
  const jobId = extractJobId(params);
  if (!jobId) {
    return 'Error: "job_id" parameter is required.';
  }
  const content = typeof params.content === 'string' ? params.content.trim() : '';
  if (!content) {
    return 'Error: "content" parameter is required.';
  }

  const nextSeqRow = await db.get(
    "SELECT COALESCE(MAX(seq), -1) + 1 as nextSeq FROM agent_job_store WHERE job_id = ? AND entry_type = 'note'",
    [jobId]
  );
  const seq = nextSeqRow ? nextSeqRow.nextSeq : 0;

  await db.run(
    'INSERT INTO agent_job_store (job_id, entry_type, seq, content) VALUES (?, ?, ?, ?)',
    [jobId, 'note', seq, content]
  );
  return `Note saved for job "${jobId}" at seq ${seq}.`;
}

/**
 * Splits `content` into sequential chunks and inserts them as agent_job_store rows.
 * Used by callers that need to hand a worker agent a large body of text without putting
 * it directly into the live prompt (e.g. agent_loop.js's delegation path for an oversized
 * task, or dev_project_tool.js persisting its build plan).
 *
 * @returns {Promise<number>} Number of chunks written.
 */
async function storeChunked(db, jobId, entryType, content, chunkSize = DEFAULT_CHUNK_SIZE) {
  const text = String(content || '');
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  if (chunks.length === 0) chunks.push('');

  for (let seq = 0; seq < chunks.length; seq++) {
    await db.run(
      'INSERT INTO agent_job_store (job_id, entry_type, seq, content) VALUES (?, ?, ?, ?)',
      [jobId, entryType, seq, chunks[seq]]
    );
  }
  return chunks.length;
}

module.exports = { handleJobStoreTool, storeChunked, DEFAULT_CHUNK_SIZE };
