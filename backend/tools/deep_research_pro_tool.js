const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { notifyUser } = require('../utils/notifications');

const RESULTS_CHAT_TITLE = 'Deep Research Results';

const DEEP_RESEARCH_SCRAPER_DIR = process.env.DEEP_RESEARCH_SCRAPER_DIR;
const PYTHON_EXE = process.env.DEEP_RESEARCH_SCRAPER_PYTHON ||
  (DEEP_RESEARCH_SCRAPER_DIR ? path.join(DEEP_RESEARCH_SCRAPER_DIR, '.venv', 'Scripts', 'python.exe') : null);

// The two CLI commands label their output file differently ("research" prints
// "Report written to:", "study-guide" prints "Study guide written to:" plus a
// separate "PDF written to:" line) - see deep_research_scraper/cli.py.
const REPORT_LINE_LABEL = {
  research: 'Report written to:',
  study_guide: 'Study guide written to:'
};
const PDF_LINE_LABEL = 'PDF written to:';

/**
 * Builds the environment for the Python subprocess so it talks to the SAME local LLM server
 * and model PATTI itself is already using, rather than whatever the standalone
 * deep_research_scraper project's own .env happens to have configured.
 *
 * This matters because both processes share one LM Studio server: if the Python project's own
 * LLM_MODEL (a stale hardcoded default, historically "qwen2.5-coder-7b-instruct") names a
 * different model than the one PATTI already has loaded, LM Studio loads a SECOND model
 * alongside the first to satisfy the mismatched request - on a shared-memory system that can
 * exhaust RAM and crash the research process outright (observed: the process exited with code 1
 * and an empty stderr, consistent with an OS-level OOM kill rather than a normal Python
 * exception, which would have printed a traceback).
 *
 * Only overrides anything when PATTI itself is in 'local' mode - if the user is on an online
 * provider there is no shared local model to collide with, so the Python project's own
 * independent configuration is left alone.
 */
async function buildResearchProcessEnv(db, userId) {
  const env = { ...process.env };
  try {
    const settings = await db.get('SELECT * FROM user_settings WHERE user_id = ?', [userId]);
    if (settings && settings.provider === 'local') {
      env.LLM_PROVIDER = 'lmstudio';
      env.LLM_BASE_URL = settings.local_url || process.env.LOCAL_LLM_URL || 'http://localhost:1234/v1';
      env.LLM_MODEL = settings.preferred_local_model || settings.model_name || env.LLM_MODEL || '';
      const { decrypt } = require('../utils/crypto');
      const localKey = decrypt(settings.local_key);
      if (localKey && localKey !== 'lm-studio') env.LLM_API_KEY = localKey;
    }
  } catch (err) {
    console.error('Deep research pro: failed to build LLM env for subprocess, using its own .env config:', err.message);
  }
  return env;
}

/**
 * Handles the deep_research_pro tool: starts a genuinely thorough, multi-minute
 * background research crawl (or a full certification/skill study-guide build) using
 * the standalone Python deep_research_scraper project, and posts the finished
 * report into a dedicated "Deep Research Results" chat once it completes. Unlike
 * the existing `deep_research` tool (fast, cache-first, ~25s budget), this is for
 * requests that genuinely need depth and are fine waiting - it returns immediately
 * after starting the background job rather than blocking the chat turn.
 *
 * @param {import('sqlite').Database} db SQLite DB instance
 * @param {number} userId The user's ID
 * @param {string} action 'start_research' | 'check_status'
 * @param {object} params Action-specific parameters
 * @returns {Promise<string>} Text result for the worker agent
 */
async function handleDeepResearchProTool(db, userId, action, params = {}) {
  if (!db) {
    return 'Error: Database connection is not available.';
  }
  if (!DEEP_RESEARCH_SCRAPER_DIR || !PYTHON_EXE) {
    return 'Error: DEEP_RESEARCH_SCRAPER_DIR is not configured on the server (see .env).';
  }

  try {
    if (action === 'start_research') {
      return await handleStartResearch(db, userId, params);
    }
    if (action === 'check_status') {
      return await handleCheckStatus(db, userId, params);
    }
    return `Error: Unknown Deep Research Pro action "${action}".`;
  } catch (err) {
    console.error('Deep research pro tool error:', err);
    return `Error starting deep research: ${err.message}`;
  }
}

async function handleStartResearch(db, userId, params) {
  const { topic, mode } = params;
  if (!topic || typeof topic !== 'string' || !topic.trim()) {
    return 'Error: "topic" parameter is required.';
  }

  // Guard against firing off multiple concurrent research crawls - each one spawns an
  // external Python subprocess with a multi-minute time budget (up to 480s), unlike the
  // synchronous deep_research_tool which already throttles itself. Only one may run per user.
  const runningJob = await db.get(
    "SELECT job_id, topic FROM deep_research_jobs WHERE user_id = ? AND status = 'running'",
    [userId]
  );
  if (runningJob) {
    return `A deep research job is already running ("${runningJob.topic}", job ${runningJob.job_id}). ` +
      'Wait for it to finish before starting another.';
  }

  const cleanTopic = topic.trim();
  const cleanMode = mode === 'study_guide' ? 'study_guide' : 'research';
  const jobId = crypto.randomUUID();

  await db.run(
    'INSERT INTO deep_research_jobs (job_id, user_id, topic, mode, status) VALUES (?, ?, ?, ?, ?)',
    [jobId, userId, cleanTopic, cleanMode, 'running']
  );

  const args = cleanMode === 'study_guide'
    ? ['-m', 'deep_research_scraper', 'study-guide', cleanTopic,
       '--max-pages-per-domain', '20', '--depth-per-domain', '3', '--time-budget-per-domain', '240']
    : ['-m', 'deep_research_scraper', 'research', cleanTopic,
       '--max-pages', '100', '--time-budget', '480'];

  let child;
  try {
    const env = await buildResearchProcessEnv(db, userId);
    child = spawn(PYTHON_EXE, args, { cwd: DEEP_RESEARCH_SCRAPER_DIR, env });
  } catch (err) {
    await finishJobWithFailure(db, userId, jobId, cleanTopic, `Failed to start research process: ${err.message}`);
    return `Error: Could not start the research process for "${cleanTopic}": ${err.message}`;
  }

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  child.on('error', (err) => {
    finishJobWithFailure(db, userId, jobId, cleanTopic, `Research process failed to run: ${err.message}`);
  });

  child.on('close', (code) => {
    finalizeJob(db, userId, jobId, cleanTopic, cleanMode, code, stdout, stderr).catch((err) => {
      console.error('Deep research pro: error finalizing job', err);
    });
  });

  return `Started a deep research job on "${cleanTopic}" (job ${jobId}, mode: ${cleanMode}). This runs in ` +
    `the background and can take several minutes - I'll add the results to your "${RESULTS_CHAT_TITLE}" ` +
    'chat (and send a notification) when it\'s done. Tell the user this has started; do not wait or poll for it now.';
}

async function finalizeJob(db, userId, jobId, topic, mode, exitCode, stdout, stderr) {
  if (exitCode !== 0) {
    const snippet = (stderr || '').trim().slice(-1500);
    const message = snippet
      ? `Research process exited with code ${exitCode}.\n${snippet}`
      : `Research process exited with code ${exitCode}.`;
    await finishJobWithFailure(db, userId, jobId, topic, message);
    return;
  }

  const reportPath = extractLabeledPath(stdout, REPORT_LINE_LABEL[mode]);
  if (!reportPath) {
    await finishJobWithFailure(db, userId, jobId, topic, 'Research process finished but no report path was found in its output.');
    return;
  }

  const absoluteReportPath = path.isAbsolute(reportPath) ? reportPath : path.join(DEEP_RESEARCH_SCRAPER_DIR, reportPath);
  let content;
  try {
    content = fs.readFileSync(absoluteReportPath, 'utf-8');
  } catch (err) {
    await finishJobWithFailure(db, userId, jobId, topic, `Report file could not be read: ${err.message}`);
    return;
  }

  let message = `# Deep research complete: ${topic}\n\n${content}`;
  if (mode === 'study_guide') {
    const pdfPath = extractLabeledPath(stdout, PDF_LINE_LABEL);
    if (pdfPath) {
      message += `\n\n---\n*A PDF version of this study guide was also saved at: ${pdfPath}*`;
    }
  }

  // Post the message BEFORE flipping the job to 'completed': callers (e.g. check_status,
  // or this same test suite) may poll job status as their "is it done" signal, so status
  // must only ever say 'completed' once the result is actually there to see.
  const resultsChatId = await postToResultsChat(db, userId, message);
  await db.run(
    "UPDATE deep_research_jobs SET status = 'completed', report_path = ?, completed_at = datetime('now') WHERE job_id = ?",
    [absoluteReportPath, jobId]
  );
  await notifyUser(db, userId, { type: 'info', message: `Deep research on "${topic}" is ready.`, chatId: resultsChatId });
}

async function handleCheckStatus(db, userId, params = {}) {
  const { jobId } = params;
  const row = jobId
    ? await db.get('SELECT * FROM deep_research_jobs WHERE job_id = ? AND user_id = ?', [jobId, userId])
    // Order by the autoincrementing id, not created_at: CURRENT_TIMESTAMP only has
    // second-level resolution, so multiple jobs started within the same second would
    // otherwise sort unreliably.
    : await db.get('SELECT * FROM deep_research_jobs WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);

  if (!row) {
    return jobId ? `Error: No job found with ID "${jobId}".` : 'No deep research jobs have been started yet.';
  }
  if (row.status === 'completed') {
    return `Job on "${row.topic}" completed at ${row.completed_at}. Results are in the "${RESULTS_CHAT_TITLE}" chat.`;
  }
  if (row.status === 'failed') {
    return `Job on "${row.topic}" failed: ${row.error || 'unknown error'}.`;
  }
  return `Job on "${row.topic}" is still running (started ${row.created_at}).`;
}

async function finishJobWithFailure(db, userId, jobId, topic, message) {
  try {
    const resultsChatId = await postToResultsChat(db, userId, `# Deep research failed: ${topic}\n\n${message}`);
    await db.run(
      "UPDATE deep_research_jobs SET status = 'failed', error = ?, completed_at = datetime('now') WHERE job_id = ?",
      [message, jobId]
    );
    await notifyUser(db, userId, { type: 'error', message: `Deep research on "${topic}" failed.`, chatId: resultsChatId });
  } catch (err) {
    console.error('Deep research pro: failed to record job failure', err);
  }
}

async function postToResultsChat(db, userId, content) {
  let chat = await db.get('SELECT * FROM chats WHERE user_id = ? AND title = ?', [userId, RESULTS_CHAT_TITLE]);
  if (!chat) {
    const result = await db.run('INSERT INTO chats (user_id, title) VALUES (?, ?)', [userId, RESULTS_CHAT_TITLE]);
    chat = { id: result.lastID, title: RESULTS_CHAT_TITLE };
  }
  await db.run('INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)', [chat.id, 'assistant', content]);
  return chat.id;
}

function extractLabeledPath(stdout, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*(.+)$`, 'm').exec(stdout);
  return match ? match[1].trim() : null;
}

module.exports = { handleDeepResearchProTool, RESULTS_CHAT_TITLE };
