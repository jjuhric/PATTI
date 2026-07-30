const { exec } = require('child_process');
const { verifyCommandWithQAAndSupervisor } = require('./codeVerifier');
const { broadcastAlert } = require('../routes/alerts');
const logger = require('./logger');

const DEFAULT_TIMEOUT_MS = 120000; // 2 minutes - generous for a normal build/test command
const MAX_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes hard cap, e.g. for a slow dependency install
const APPROVAL_POLL_INTERVAL_MS = 5000;
const APPROVAL_MAX_WAIT_MS = 24 * 60 * 60 * 1000; // 24h - generous, but not unbounded

/**
 * Runs a shell command as part of a background project job (dev_project_tool.js), gated by
 * the existing automatic QA+Supervisor safety audit (verifyCommandWithQAAndSupervisor,
 * already used by developer_agent's live execute_command tool) rather than a new mechanism.
 * Routine, requested, reversible commands - installing a dependency, running the project's
 * own build/test commands - are approved automatically, so most install/build/verify steps
 * never need a human at all. Only a command the audit flags as genuinely disruptive escalates
 * to a human, via a DB column on the job row rather than the in-memory pendingCommands map in
 * commandApproval.js - a background job's wait can span far longer than a live HTTP request,
 * and must survive this process restarting while paused.
 *
 * @param {import('sqlite').Database} db
 * @param {string} jobId dev_build_jobs.job_id
 * @param {object} settings LLM settings (see llm_text.js's buildSettingsForUser)
 * @param {string} agentName Attributed name for the safety audit (e.g. 'dev_project')
 * @param {string} command Shell command to run
 * @param {string} cwd Working directory for the command
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] Execution timeout in ms (default 120000, hard-capped at 10 minutes)
 * @param {(message: string) => Promise<void>} [opts.postToResultsChat] Notifies the user when
 *   escalation happens
 * @param {number} [opts.approvalPollIntervalMs] Override for testing (default 5000)
 * @param {number} [opts.approvalMaxWaitMs] Override for testing (default 24h)
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, exitCode: number|null, timedOut: boolean, rejected?: boolean}>}
 */
async function runVerifiedCommand(db, jobId, settings, agentName, command, cwd, opts = {}) {
  const { qaResult, supervisorResult } = await verifyCommandWithQAAndSupervisor(command, agentName, settings);
  const needsHuman = !qaResult.approved || supervisorResult.can_cause_disruptions;

  if (needsHuman) {
    await db.run(
      "UPDATE dev_build_jobs SET status = 'awaiting_approval', pending_command = ?, pending_command_safety = ? WHERE job_id = ?",
      [command, JSON.stringify({ qaResult, supervisorResult }), jobId]
    );

    const reason = supervisorResult.reason || qaResult.reason || 'Flagged as potentially disruptive.';
    const message = `**Approval needed to continue project job ${jobId}:**\n\n` +
      `\`${command}\`\n\n` +
      `Why it was flagged: ${reason}\n\n` +
      'Reply approving or rejecting this command to let the job continue.';

    if (opts.postToResultsChat) {
      try {
        await opts.postToResultsChat(message);
      } catch (err) {
        logger.error('[Project Verification] Failed to post approval request to results chat:', err);
      }
    }
    broadcastAlert({ type: 'warning', message: `A command needs your approval to continue project job ${jobId}.` });

    const decision = await pollForApproval(db, jobId, opts.approvalPollIntervalMs, opts.approvalMaxWaitMs);
    if (!decision.approved) {
      return { ok: false, stdout: '', stderr: '', exitCode: null, timedOut: false, rejected: true };
    }
  }

  return executeWithTimeout(command, cwd, Math.min(opts.timeoutMs || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
}

// Polls the job row rather than an in-memory promise so the wait survives a service restart.
// approve_command/reject_command (dev_project_tool.js) set a transient 'approved_command' /
// 'rejected_command' status which this loop consumes and normalizes back to 'building'.
async function pollForApproval(db, jobId, pollIntervalMs = APPROVAL_POLL_INTERVAL_MS, maxWaitMs = APPROVAL_MAX_WAIT_MS) {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const row = await db.get('SELECT status FROM dev_build_jobs WHERE job_id = ?', [jobId]);
    if (!row) {
      return { approved: false };
    }
    if (row.status === 'approved_command' || row.status === 'rejected_command') {
      const approved = row.status === 'approved_command';
      await db.run(
        "UPDATE dev_build_jobs SET status = 'building', pending_command = NULL, pending_command_safety = NULL WHERE job_id = ?",
        [jobId]
      );
      return { approved };
    }
    if (row.status !== 'awaiting_approval') {
      // Job was resumed/altered some other way - stop waiting rather than loop forever.
      return { approved: false };
    }
    if (Date.now() > deadline) {
      await db.run(
        "UPDATE dev_build_jobs SET status = 'building', pending_command = NULL, pending_command_safety = NULL WHERE job_id = ?",
        [jobId]
      );
      return { approved: false };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

function executeWithTimeout(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.killed) {
        resolve({ ok: false, stdout: stdout || '', stderr: stderr || '', exitCode: null, timedOut: true });
      } else if (err) {
        resolve({ ok: false, stdout: stdout || '', stderr: stderr || '', exitCode: typeof err.code === 'number' ? err.code : null, timedOut: false });
      } else {
        resolve({ ok: true, stdout: stdout || '', stderr: stderr || '', exitCode: 0, timedOut: false });
      }
    });
  });
}

module.exports = { runVerifiedCommand, executeWithTimeout, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS };
