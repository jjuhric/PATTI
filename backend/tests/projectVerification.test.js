const fs = require('fs');
const path = require('path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');

const mockVerify = jest.fn();
jest.mock('../utils/codeVerifier', () => ({
  verifyCommandWithQAAndSupervisor: (...args) => mockVerify(...args)
}));

const mockBroadcastAlert = jest.fn();
jest.mock('../routes/alerts', () => ({ broadcastAlert: (...args) => mockBroadcastAlert(...args) }));

const mockExec = jest.fn();
jest.mock('child_process', () => ({ exec: (...args) => mockExec(...args) }));

const { runVerifiedCommand } = require('../utils/projectVerification');

function approvedSafety() {
  return {
    qaResult: { approved: true, can_cause_disruptions: false, reason: 'Routine command.' },
    supervisorResult: { approved_without_user: true, can_cause_disruptions: false, reason: 'Fine.' }
  };
}

function disruptiveSafety() {
  return {
    qaResult: { approved: true, can_cause_disruptions: false, reason: 'Looks fine to QA.' },
    supervisorResult: { approved_without_user: false, can_cause_disruptions: true, reason: 'Could delete data outside the workspace.' }
  };
}

describe('runVerifiedCommand', () => {
  let db;
  let userId;

  beforeAll(async () => {
    db = await open({ filename: ':memory:', driver: sqlite3.Database });
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await db.exec(schemaSql);
    const result = await db.run("INSERT INTO users (username, password_hash) VALUES ('pvuser', 'hashed')");
    userId = result.lastID;
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(() => {
    mockVerify.mockReset();
    mockBroadcastAlert.mockClear();
    mockExec.mockReset();
  });

  async function makeJob(jobId) {
    await db.run(
      'INSERT INTO dev_build_jobs (job_id, user_id, spec, target_dir, status) VALUES (?, ?, ?, ?, ?)',
      [jobId, userId, 'test spec', 'C:\\fake\\dir', 'building']
    );
  }

  test('a routine, auto-approved command executes directly with no escalation', async () => {
    await makeJob('job-auto-approve');
    mockVerify.mockResolvedValue(approvedSafety());
    mockExec.mockImplementation((command, options, callback) => {
      callback(null, 'hello\n', '');
    });

    const result = await runVerifiedCommand(db, 'job-auto-approve', {}, 'dev_project', 'echo hello', 'C:\\fake\\dir');

    expect(result).toEqual({ ok: true, stdout: 'hello\n', stderr: '', exitCode: 0, timedOut: false });
    expect(mockBroadcastAlert).not.toHaveBeenCalled();
    const row = await db.get('SELECT status FROM dev_build_jobs WHERE job_id = ?', ['job-auto-approve']);
    expect(row.status).toBe('building');
  });

  test('a failing command (non-zero exit) is reported as not ok, with a real exit code', async () => {
    await makeJob('job-failing');
    mockVerify.mockResolvedValue(approvedSafety());
    mockExec.mockImplementation((command, options, callback) => {
      const err = new Error('Command failed');
      err.code = 1;
      callback(err, 'partial output', 'some error');
    });

    const result = await runVerifiedCommand(db, 'job-failing', {}, 'dev_project', 'false', 'C:\\fake\\dir');

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toBe('some error');
  });

  test('a timed-out command is reported distinctly from a normal failure', async () => {
    await makeJob('job-timeout');
    mockVerify.mockResolvedValue(approvedSafety());
    mockExec.mockImplementation((command, options, callback) => {
      const err = new Error('Command timed out');
      err.killed = true;
      callback(err, '', '');
    });

    const result = await runVerifiedCommand(db, 'job-timeout', {}, 'dev_project', 'sleep 999', 'C:\\fake\\dir');

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  test('a disruptive command pauses the job, notifies, and resumes+executes once approved', async () => {
    await makeJob('job-approve-flow');
    mockVerify.mockResolvedValue(disruptiveSafety());
    mockExec.mockImplementation((command, options, callback) => {
      callback(null, 'ran after approval', '');
    });
    const postToResultsChat = jest.fn().mockResolvedValue(undefined);

    const resultPromise = runVerifiedCommand(db, 'job-approve-flow', {}, 'dev_project', 'rm -rf something', 'C:\\fake\\dir', {
      postToResultsChat,
      approvalPollIntervalMs: 10,
      approvalMaxWaitMs: 5000
    });

    // Wait for the job to actually reach 'awaiting_approval' before approving it.
    let row;
    for (let i = 0; i < 50; i++) {
      row = await db.get('SELECT * FROM dev_build_jobs WHERE job_id = ?', ['job-approve-flow']);
      if (row.status === 'awaiting_approval') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(row.status).toBe('awaiting_approval');
    expect(row.pending_command).toBe('rm -rf something');
    expect(JSON.parse(row.pending_command_safety).supervisorResult.can_cause_disruptions).toBe(true);
    expect(postToResultsChat).toHaveBeenCalled();
    expect(mockBroadcastAlert).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));

    // Simulate dev_project_tool.js's approve_command action.
    await db.run("UPDATE dev_build_jobs SET status = 'approved_command' WHERE job_id = ?", ['job-approve-flow']);

    const result = await resultPromise;
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('ran after approval');

    const finalRow = await db.get('SELECT * FROM dev_build_jobs WHERE job_id = ?', ['job-approve-flow']);
    expect(finalRow.status).toBe('building');
    expect(finalRow.pending_command).toBeNull();
  });

  test('a disruptive command that is rejected never executes', async () => {
    await makeJob('job-reject-flow');
    mockVerify.mockResolvedValue(disruptiveSafety());

    const resultPromise = runVerifiedCommand(db, 'job-reject-flow', {}, 'dev_project', 'rm -rf something', 'C:\\fake\\dir', {
      approvalPollIntervalMs: 10,
      approvalMaxWaitMs: 5000
    });

    for (let i = 0; i < 50; i++) {
      const row = await db.get('SELECT status FROM dev_build_jobs WHERE job_id = ?', ['job-reject-flow']);
      if (row.status === 'awaiting_approval') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await db.run("UPDATE dev_build_jobs SET status = 'rejected_command' WHERE job_id = ?", ['job-reject-flow']);

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(result.rejected).toBe(true);
    expect(mockExec).not.toHaveBeenCalled();
  });

  test('a disruptive command that is never resolved times out and is treated as rejected', async () => {
    await makeJob('job-timeout-approval');
    mockVerify.mockResolvedValue(disruptiveSafety());

    const result = await runVerifiedCommand(db, 'job-timeout-approval', {}, 'dev_project', 'rm -rf something', 'C:\\fake\\dir', {
      approvalPollIntervalMs: 10,
      approvalMaxWaitMs: 50
    });

    expect(result.ok).toBe(false);
    expect(result.rejected).toBe(true);
    expect(mockExec).not.toHaveBeenCalled();

    const row = await db.get('SELECT status FROM dev_build_jobs WHERE job_id = ?', ['job-timeout-approval']);
    expect(row.status).toBe('building');
  });

  test('QA rejecting a command also triggers the escalation path even if the Supervisor would not', async () => {
    await makeJob('job-qa-reject');
    mockVerify.mockResolvedValue({
      qaResult: { approved: false, can_cause_disruptions: true, reason: 'QA found this unsafe.' },
      supervisorResult: { approved_without_user: false, can_cause_disruptions: true, reason: 'Bypassed - QA did not approve.' }
    });

    const result = await runVerifiedCommand(db, 'job-qa-reject', {}, 'dev_project', 'some command', 'C:\\fake\\dir', {
      approvalPollIntervalMs: 10,
      approvalMaxWaitMs: 50
    });

    expect(result.rejected).toBe(true);
    expect(mockExec).not.toHaveBeenCalled();
  });
});
