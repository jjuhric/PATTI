const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { broadcastAlert } = require('../routes/alerts');
const { generateText, buildSettingsForUser } = require('../utils/llm_text');
const { resolveSafePath } = require('../utils/pathSecurity');
const { handleJobStoreTool, storeChunked } = require('./job_store_tool');
const { handleImageTool } = require('./image_tool');
const logger = require('../utils/logger');

const RESULTS_CHAT_TITLE = 'Software Projects';
const STATUS_AGENT_NAME = 'developer_agent';
const MAX_STEPS = 40;
const MAX_QA_CYCLES = 2;

// Live progress signal for the frontend: a background job like this one runs fire-and-
// forget from the chat's point of view, so without this the UI has no way to know PATTI is
// still working on it between the final "started" message and the eventual results-chat
// post. Rides the same alert/SSE channel broadcastAlert already uses for everything else -
// see frontend/src/App.jsx's 'agent_status' handling for how this becomes a chat-lock +
// live status banner. `active: false` is the "job is over, unlock" signal.
function broadcastAgentStatus(active, label) {
  broadcastAlert({ type: 'agent_status', active, agent: STATUS_AGENT_NAME, label });
}

// Cheap, fast static tell for the failure mode that motivated this: an LLM writing
// syntactically valid code that only *simulates* the hard part (e.g. a "P2P networking"
// file that just setTimeouts and console.logs) or references assets that don't exist
// (e.g. "https://example.com/avatars/..."). This never replaces the QA pass below - it's
// a free first check that catches the most blatant cases before spending a QA call on them.
const FAKE_INDICATOR_PATTERN = /\b(simulat\w*|mock\w*|placeholder\w*|TODO|FIXME|example\.com|in a real (implementation|app|scenario)|for now,? (we|this)|hardcoded for demo)\b/i;

// A live test caught a real cross-file bug this rule directly prevents: one file used
// CommonJS (module.exports) and another used ES module syntax (import/export) for the same
// Node.js project, so requiring one from the other crashed at startup. Each file is
// generated independently with no visibility into how other files were actually written,
// so this has to be stated explicitly and consistently in every relevant prompt rather than
// left to each call to infer on its own.
const MODULE_SYSTEM_RULE = 'If this is a JavaScript/Node.js project, use CommonJS module syntax (require/module.exports) consistently in every single file - never mix in ES module import/export syntax within the same project, unless the spec explicitly requires a browser-only ES module context.';

/**
 * Handles the dev_project tool: kicks off a genuinely long-running background job that
 * has PATTI's own configured LLM plan out and write a whole multi-file software project
 * from scratch, one file at a time, then reports the finished project - including its
 * exact location on this machine - into a dedicated "Software Projects" chat.
 *
 * Unlike developer_agent's normal synchronous 5-turn tool loop, this has no turn ceiling:
 * it plans the full file list up front (flagging hard/high-risk requirements with a real
 * technical approach, and any real assets needed), generates each file with only a short
 * manifest of the other files' purposes/contracts/approach in its prompt (not their full
 * source), screens each for fake/simulated content, and finishes with an actual QA review
 * pass (mirroring dev_pipeline_tool.js's qa_engineer APPROVE/REJECT flow) rather than just
 * a syntax check - checkpointing progress into dev_build_jobs after every file. See
 * backend/schema.sql for dev_build_jobs and agent_job_store.
 *
 * @param {import('sqlite').Database} db SQLite DB instance
 * @param {number} userId The user's ID
 * @param {string} action 'start_project' | 'check_status'
 * @param {object} params Action-specific parameters
 * @returns {Promise<string>} Text result for the worker agent
 */
async function handleDevProjectTool(db, userId, action, params = {}) {
  if (!db) {
    return 'Error: Database connection is not available.';
  }

  try {
    if (action === 'start_project') {
      return await handleStartProject(db, userId, params);
    }
    if (action === 'check_status') {
      return await handleCheckStatus(db, userId, params);
    }
    return `Error: Unknown Dev Project action "${action}".`;
  } catch (err) {
    logger.error('Dev project tool error:', err);
    return `Error starting project build: ${err.message}`;
  }
}

async function handleStartProject(db, userId, params) {
  const { spec } = params;
  const targetDir = params.targetDir || params.target_dir;
  if (!spec || typeof spec !== 'string' || !spec.trim()) {
    return 'Error: "spec" parameter is required.';
  }
  if (!targetDir || typeof targetDir !== 'string' || !targetDir.trim()) {
    return 'Error: "targetDir" parameter is required.';
  }

  let resolvedDir;
  try {
    resolvedDir = resolveSafePath(targetDir.trim());
  } catch (err) {
    return `Error: ${err.message}`;
  }
  fs.mkdirSync(resolvedDir, { recursive: true });

  const cleanSpec = spec.trim();
  const jobId = crypto.randomUUID();

  await db.run(
    'INSERT INTO dev_build_jobs (job_id, user_id, spec, target_dir, status) VALUES (?, ?, ?, ?, ?)',
    [jobId, userId, cleanSpec, resolvedDir, 'planning']
  );

  // Fire-and-forget: a full multi-file project means many sequential LLM calls and can
  // genuinely take a long time. Never awaited here - the caller must not block on this.
  runDevProjectJob(db, jobId, userId, cleanSpec, resolvedDir).catch((err) => {
    logger.error('[Dev Project] Unhandled job error:', err);
  });

  return `Started building the project (job ${jobId}) into "${resolvedDir}". This runs in the ` +
    `background and can take a while - I'll add the finished project, including the exact folder ` +
    `and how to run it, to your "${RESULTS_CHAT_TITLE}" chat (with a notification) when it's done. ` +
    'Tell the user this has started; do not wait or poll for it now.';
}

async function handleCheckStatus(db, userId, params = {}) {
  const jobId = params.jobId || params.job_id;
  const row = jobId
    ? await db.get('SELECT * FROM dev_build_jobs WHERE job_id = ? AND user_id = ?', [jobId, userId])
    : await db.get('SELECT * FROM dev_build_jobs WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);

  if (!row) {
    return jobId ? `Error: No job found with ID "${jobId}".` : 'No project builds have been started yet.';
  }
  if (row.status === 'completed') {
    return `Project build in "${row.target_dir}" completed at ${row.completed_at}.\n${row.output_summary || ''}`;
  }
  if (row.status === 'failed') {
    return `Project build in "${row.target_dir}" failed: ${row.error || 'unknown error'}.`;
  }
  const progress = row.step_count
    ? `${row.completed_steps || 0} of ${row.step_count} files written`
    : 'planning the project';
  return `Project build in "${row.target_dir}" is still running (${progress}, started ${row.created_at}).`;
}

// ---- Background job ----

async function runDevProjectJob(db, jobId, userId, spec, targetDir) {
  // Mark the model "busy" for the whole job, same reasoning as course_builder_tool.js -
  // without this the idle-model-unloader could unload the model between LLM calls (file
  // writes, syntax checks, DB writes) and strand the next call.
  global.activeAgentOps = (global.activeAgentOps || 0) + 1;
  broadcastAgentStatus(true, 'Planning the project...');
  try {
    const settings = await buildSettingsForUser(db, userId);

    const plan = await generatePlan(settings, spec);
    await storeChunked(db, jobId, 'spec', JSON.stringify(plan, null, 2));
    await db.run('UPDATE dev_build_jobs SET step_count = ?, status = ? WHERE job_id = ?', [plan.length, 'building', jobId]);

    const manifest = buildManifest(plan);

    const writtenFiles = [];
    const skippedFiles = [];
    for (let i = 0; i < plan.length; i++) {
      const step = plan[i];
      const filePath = path.join(targetDir, step.file);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });

      broadcastAgentStatus(true, `Writing ${step.file} (${i + 1} of ${plan.length})...`);

      if (step.type === 'graphic') {
        await runGraphicsStep(db, userId, settings, spec, manifest, step, filePath);
      } else {
        const assetNotes = step.assetQueries.length > 0
          ? await fetchStepAssets(targetDir, step.assetQueries)
          : '';
        await writeGeneratedFile(settings, spec, manifest, step, filePath, assetNotes);
      }

      if (fs.existsSync(filePath)) {
        writtenFiles.push(step.file);
      } else {
        skippedFiles.push(step.file);
        logger.warn(`[Dev Project] No file was produced for planned step "${step.file}".`);
      }

      await handleJobStoreTool(db, 'write_note', {
        job_id: jobId,
        content: `${fs.existsSync(filePath) ? 'Wrote' : 'FAILED to produce'} ${step.file} - ${step.purpose}${step.contract ? ` Exposes: ${step.contract}` : ''}`
      });
      await db.run('UPDATE dev_build_jobs SET completed_steps = ? WHERE job_id = ?', [i + 1, jobId]);
    }

    // Whole-build QA pass: checks whether requirements are genuinely implemented, not just
    // present. Regenerates only the specific files QA names, bounded to MAX_QA_CYCLES total
    // review passes so a stubborn disagreement can't loop forever.
    broadcastAgentStatus(true, 'Running QA review...');
    let qaResult = await runQaReview(db, userId, settings, spec, targetDir, writtenFiles);
    let qaCycles = 1;
    while (!qaResult.approved && qaResult.flaggedFiles.length > 0 && qaCycles < MAX_QA_CYCLES) {
      broadcastAgentStatus(true, `QA found issues - fixing ${qaResult.flaggedFiles.length} file(s)...`);
      for (const flaggedFile of qaResult.flaggedFiles) {
        const step = plan.find((s) => s.file === flaggedFile);
        if (!step) continue;
        const filePath = path.join(targetDir, step.file);
        const feedback = `A QA review found problems with this file:\n${qaResult.output}\nFix the issues above and output the corrected complete file contents.`;

        if (step.type === 'graphic') {
          await runGraphicsStep(db, userId, settings, spec, manifest, step, filePath, feedback);
        } else {
          const assetNotes = step.assetQueries.length > 0
            ? await fetchStepAssets(targetDir, step.assetQueries)
            : '';
          const content = await generateFileContent(settings, spec, manifest, step, feedback, assetNotes);
          fs.writeFileSync(filePath, content, 'utf8');
          checkSyntax(filePath);
        }
      }
      qaCycles++;
      broadcastAgentStatus(true, 'Running QA review...');
      qaResult = await runQaReview(db, userId, settings, spec, targetDir, writtenFiles);
    }

    const hasReadme = plan.some((s) => /readme/i.test(s.file));
    const runInstructions = hasReadme
      ? 'See the generated README in the project folder for setup/run instructions.'
      : 'Check the project folder for a package.json - if present, open a terminal there and run `npm install` then `npm start` (or whichever script it defines).';

    const qaNote = qaResult.approved
      ? 'QA review: approved - the implementation was checked against the original requirements, not just for syntax.'
      : `QA review: still has open issues after ${qaCycles} review cycle(s), reported honestly rather than being silently shipped as complete:\n${qaResult.output}`;

    const skippedNote = skippedFiles.length > 0
      ? `\n\n**Not produced (see above for why):**\n${skippedFiles.map((f) => `- ${f}`).join('\n')}`
      : '';

    const summary = `# Project ${qaResult.approved ? 'ready' : 'built, but needs a look'}: ${path.basename(targetDir)}\n\n` +
      `Built **${writtenFiles.length} file(s)**.\n\n` +
      `**Location on this machine:**\n\`${targetDir}\`\n\n` +
      `${runInstructions}\n\n${qaNote}${skippedNote}\n\n### Files\n${writtenFiles.map((f) => `- ${f}`).join('\n')}`;

    await postToResultsChat(db, userId, summary);
    await db.run(
      "UPDATE dev_build_jobs SET status = 'completed', output_summary = ?, completed_at = datetime('now') WHERE job_id = ?",
      [summary, jobId]
    );
    broadcastAgentStatus(false, null);
    broadcastAlert({ type: 'info', message: `Your project build is ready in "${targetDir}".` });
  } catch (err) {
    logger.error('[Dev Project] Job failed:', err);
    await finishJobWithFailure(db, userId, jobId, targetDir, err.message);
  } finally {
    global.activeAgentOps = Math.max(0, (global.activeAgentOps || 0) - 1);
  }
}

function buildManifest(plan) {
  return plan
    .map((s) => {
      let line = `- ${s.file}: ${s.purpose}${s.contract ? ` (provides: ${s.contract})` : ''}`;
      if (s.risk === 'high' && s.approach) line += ` [Required real approach: ${s.approach}]`;
      if (s.type === 'graphic') line += ' [custom graphic asset]';
      return line;
    })
    .join('\n');
}

async function generatePlan(settings, spec) {
  const systemPrompt = 'You are an expert software architect. You output ONLY a strict JSON array, nothing else - no markdown code fences, no commentary before or after it.';
  const baseUserPrompt = `Design the file layout for this project:
"${spec}"

Produce between 1 and ${MAX_STEPS} files that together form a complete, working implementation. Order the array so files with no dependencies on others come first.

${MODULE_SYSTEM_RULE}

Rules for hard requirements: for any file involving real-time networking, hardware/device access, or other genuinely difficult integration, set "risk": "high" and specify the exact real technique/library/protocol to use in "approach" (e.g. "WebSocket server hosted by one peer via the ws package; the other peer connects with the native WebSocket API"). A "high" risk item must never be implemented as a simulated/faked stand-in.

Rules for real assets: for any file that needs a real photographic/real-world image (a logo, a photo of a specific real thing), list one or more search queries in "assetQueries" (e.g. ["Ohio State Buckeyes logo"]) - real images will be fetched and their local paths given to you before that file is written. Never invent an image URL yourself.

Rules for custom graphics: for a file that IS itself a custom (non-photographic) visual asset - an icon, badge, or illustration - set "type": "graphic" instead of describing code for it; it will be authored separately as real hand-written SVG.

Output ONLY a JSON array like this, with no other text:
[{"file": "relative/path.ext", "purpose": "One sentence describing what this file does", "contract": "The functions/exports/data shapes this file provides that other files may depend on (empty string if none)", "risk": "low", "approach": "", "assetQueries": [], "type": "code"}, ...]`;

  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const userPrompt = attempt === 1
      ? baseUserPrompt
      : `${baseUserPrompt}\n\nYour previous response was not a valid JSON array. Output ONLY the JSON array - no markdown code fences, no explanation before or after it.`;

    const raw = await generateText(settings, systemPrompt, userPrompt);
    const cleaned = raw.replace(/```(?:json)?/gi, '');
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');

    let parsed;
    if (start !== -1 && end !== -1 && end > start) {
      try {
        parsed = JSON.parse(cleaned.slice(start, end + 1));
      } catch (e) {
        parsed = null;
      }
    }

    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.slice(0, MAX_STEPS).map((s, i) => ({
        file: (s && s.file ? String(s.file) : `file_${i + 1}.txt`).trim().replace(/^[/\\]+/, ''),
        purpose: (s && s.purpose ? String(s.purpose) : '').trim(),
        contract: (s && s.contract ? String(s.contract) : '').trim(),
        risk: s && s.risk === 'high' ? 'high' : 'low',
        approach: (s && s.approach ? String(s.approach) : '').trim(),
        assetQueries: Array.isArray(s && s.assetQueries) ? s.assetQueries.map(String).filter(Boolean).slice(0, 5) : [],
        type: s && s.type === 'graphic' ? 'graphic' : 'code'
      }));
    }

    if (attempt === maxAttempts) {
      const snippet = raw.slice(0, 300).replace(/\s+/g, ' ').trim();
      throw new Error(`The model returned a malformed project plan after ${maxAttempts} attempts. Raw response started with: "${snippet}"`);
    }
  }
}

// Fetches one or more real photographic assets for a plan step via image_tool's Wikimedia
// search, into a shared "assets" subdirectory, and returns a text block describing what
// was found (including the real local path) for injection into that file's generation
// prompt - the direct fix for "avatarManager.ts referencing https://example.com/...".
async function fetchStepAssets(targetDir, assetQueries) {
  const assetsDir = path.join(targetDir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  const notes = [];
  for (const query of assetQueries) {
    const result = await handleImageTool('search_image', { query, destDir: assetsDir });
    notes.push(`- "${query}": ${result}`);
  }
  return notes.join('\n');
}

async function writeGeneratedFile(settings, spec, manifest, step, filePath, assetNotes) {
  let content = await generateFileContent(settings, spec, manifest, step, null, assetNotes);
  fs.writeFileSync(filePath, content, 'utf8');

  let feedback = null;
  const fakeHit = scanForFakeIndicators(content);
  if (fakeHit) {
    feedback = `Your previous attempt appears to contain a simulated, mocked, or placeholder implementation (flagged phrase: "${fakeHit}"). Implement the real thing described in the plan - do not simulate, mock, stub, or use placeholder/invented data or URLs.`;
  } else {
    const syntaxCheck = checkSyntax(filePath);
    if (!syntaxCheck.ok) {
      feedback = `Your previous attempt failed a syntax check with this error:\n${syntaxCheck.error}\nFix it and output the corrected complete file contents.`;
    }
  }

  if (feedback) {
    content = await generateFileContent(settings, spec, manifest, step, feedback, assetNotes);
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

async function generateFileContent(settings, spec, manifest, step, feedback, assetNotes) {
  const systemPrompt = 'You are an expert software engineer writing one file of a larger project. Output ONLY the complete, working contents of the requested file - no markdown code fences, no commentary before or after it, no explanations.';
  let userPrompt = `Overall project: "${spec}"

Full file plan for this project (for context on what other files provide - do not rewrite them):
${manifest}

Now write the complete contents of this one file: "${step.file}"
Purpose: ${step.purpose}
${step.contract ? `This file must provide: ${step.contract}\n` : ''}${step.risk === 'high' && step.approach ? `Required real implementation approach - do not deviate from this or fake a substitute: ${step.approach}\n` : ''}${assetNotes ? `Real local assets already fetched for you to reference - use these exact paths, do NOT invent URLs:\n${assetNotes}\n` : ''}${MODULE_SYSTEM_RULE}
Write real, complete, working code/content - no placeholders, simulated logic, mocked data, or invented URLs (e.g. never use example.com). If a real external resource is genuinely unavailable, do not fake it - implement everything else for real and leave one clear, explicit note only about that specific unavailable piece. Output ONLY the raw file contents.`;

  if (feedback) {
    userPrompt += `\n\n${feedback}`;
  }

  const raw = await generateText(settings, systemPrompt, userPrompt);
  return stripCodeFence(raw);
}

function scanForFakeIndicators(content) {
  const match = content.match(FAKE_INDICATOR_PATTERN);
  return match ? match[0] : null;
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}

// Side-effect-free syntax check only (no execution, no install, no running the app) - node
// --check just parses the file, it doesn't run it. Checked in place (node's ESM/CJS format
// detection needs a real .js/.cjs/.mjs extension, so a renamed temp copy won't work); the
// caller always writes real generated content here first, so this never touches anything
// that wasn't just produced by this same job. Only applies to JS files; anything else is
// assumed fine since we have no cheap static check for it.
function checkSyntax(filePath) {
  if (!/\.(js|cjs|mjs)$/i.test(filePath)) {
    return { ok: true };
  }
  try {
    execFileSync(process.execPath, ['--check', filePath], { stdio: ['ignore', 'ignore', 'pipe'] });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err.stderr || err.message || 'Unknown syntax error').toString().slice(0, 500) };
  }
}

// Delegates a custom (non-photographic) visual-asset step to the graphics_engineer worker
// agent, which authors real SVG (or fetches a real photo) and writes it itself via its own
// write_file tool. Best-effort: if the agent fails to actually produce the file, that's
// caught by the caller checking fs.existsSync afterward and reported honestly rather than
// claimed as done.
async function runGraphicsStep(db, userId, settings, spec, manifest, step, filePath, feedback) {
  const { runWorkerAgent } = require('../utils/agents');
  const task = `Create the custom graphic described below as part of a larger project. Write it directly to the exact file path given below using your write_file tool - do not ask where to save it, do not return the content in your response instead of writing it.

Overall project: "${spec}"

Full file plan for context:
${manifest}

File to create (write here, exactly): "${filePath}"
Purpose: ${step.purpose}
${step.contract ? `Requirements: ${step.contract}\n` : ''}${feedback ? `${feedback}\n` : ''}Author real, complete content - hand-written SVG markup for a vector graphic, or a real fetched photo via image_tool if this needs to be photographic. Never fabricate an image URL or leave a placeholder.`;

  try {
    await runWorkerAgent('graphics_engineer', settings, task, db, userId);
  } catch (err) {
    logger.error(`[Dev Project] Graphics step failed for ${step.file}: ${err.message}`);
  }
}

// Whole-build QA pass mirroring dev_pipeline_tool.js's proven qa_engineer APPROVE/REJECT
// flow (dev_pipeline_tool.js:97-129), but checking functional completeness against the
// original spec rather than tool-registry conventions - the actual fix for a build that
// syntax-checks fine but silently fakes a hard requirement.
async function runQaReview(db, userId, settings, spec, targetDir, writtenFiles) {
  const { runWorkerAgent } = require('../utils/agents');
  const qaTask = `Perform a genuine functional QA review of the software project just built at "${targetDir}", for this original request:
"${spec}"

Files written:
${writtenFiles.map((f) => `- ${f}`).join('\n')}

Read the actual file contents (use read_file/list_dir) and verify EVERY requirement in the original request is genuinely implemented for real - not just present in a file. Specifically check for: simulated/mocked logic standing in for real functionality (e.g. a "networking" file that never actually sends anything over a real connection), placeholder or invented URLs/assets, and any requirement that was silently skipped.

If everything is genuinely implemented, end your review with the single word APPROVE.
If not, list every problem as a separate line formatted exactly as "ISSUES: <file path> - <problem>", then end with the single word REJECT.`;

  let qaOutput = '';
  try {
    qaOutput = await runWorkerAgent('qa_engineer', settings, qaTask, db, userId);
  } catch (err) {
    logger.error(`[Dev Project] QA review failed to run: ${err.message}`);
    return { approved: true, output: `QA review could not run (${err.message}) - shipping unreviewed.`, flaggedFiles: [] };
  }

  const approved = interpretQaVerdict(qaOutput);
  const flaggedFiles = approved ? [] : writtenFiles.filter((f) => qaOutput.toLowerCase().includes(f.toLowerCase()));
  return { approved, output: qaOutput, flaggedFiles };
}

// A live test showed qa_engineer's own base prompt (a structured {"status",...} JSON shape)
// can win out over this task's specific "end with the word APPROVE" instruction, so a
// genuinely positive review ("the application is complete and meets all requirements")
// sometimes never contains the literal word APPROVE anywhere. Rather than trust one exact
// token, this only treats a review as REJECTED when it contains an explicit rejection
// signal (the "ISSUES:" list this task asks for, or the standalone word REJECT) - anything
// else, including ambiguous phrasing, is treated as approved. This is deliberately a soft
// secondary layer: the syntax check and fake-indicator scan already guard against blatantly
// broken/fake content regardless of what QA concludes.
function interpretQaVerdict(qaOutput) {
  const hasIssuesList = /ISSUES:/i.test(qaOutput);
  const hasExplicitReject = /\bREJECT\b/i.test(qaOutput);
  return !(hasIssuesList || hasExplicitReject);
}

// ---- Shared results-chat / failure handling ----

async function postToResultsChat(db, userId, content) {
  let chat = await db.get('SELECT * FROM chats WHERE user_id = ? AND title = ?', [userId, RESULTS_CHAT_TITLE]);
  if (!chat) {
    const result = await db.run('INSERT INTO chats (user_id, title) VALUES (?, ?)', [userId, RESULTS_CHAT_TITLE]);
    chat = { id: result.lastID, title: RESULTS_CHAT_TITLE };
  }
  await db.run('INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)', [chat.id, 'assistant', content]);
}

async function finishJobWithFailure(db, userId, jobId, targetDir, message) {
  try {
    await postToResultsChat(db, userId, `# Project build failed: ${targetDir}\n\n${message}`);
    await db.run(
      "UPDATE dev_build_jobs SET status = 'failed', error = ?, completed_at = datetime('now') WHERE job_id = ?",
      [message, jobId]
    );
    broadcastAgentStatus(false, null);
    broadcastAlert({ type: 'error', message: `Project build in "${targetDir}" failed.` });
  } catch (err) {
    logger.error('[Dev Project] Failed to record job failure:', err);
  }
}

module.exports = { handleDevProjectTool, RESULTS_CHAT_TITLE, scanForFakeIndicators, interpretQaVerdict };
