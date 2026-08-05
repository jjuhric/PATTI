const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');

const FAKE_SCRAPER_DIR = path.join(os.tmpdir(), 'fake_deep_research_scraper');
process.env.DEEP_RESEARCH_SCRAPER_DIR = FAKE_SCRAPER_DIR;

const mockBroadcastAlert = jest.fn();
jest.mock('../routes/alerts', () => ({ broadcastAlert: (...args) => mockBroadcastAlert(...args) }));

let lastSpawnedChild;
const mockSpawn = jest.fn(() => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  lastSpawnedChild = child;
  return child;
});
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: (...args) => mockSpawn(...args)
}));

const { handleDeepResearchProTool, RESULTS_CHAT_TITLE } = require('../tools/deep_research_pro_tool');

describe('handleDeepResearchProTool', () => {
  let db;
  let userId;
  let tmpReportDir;

  beforeAll(async () => {
    db = await open({ filename: ':memory:', driver: sqlite3.Database });
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await db.exec(schemaSql);

    const result = await db.run("INSERT INTO users (username, password_hash) VALUES ('proresearchuser', 'hashed')");
    userId = result.lastID;

    tmpReportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drp-test-'));
  });

  afterAll(async () => {
    await db.close();
    fs.rmSync(tmpReportDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockSpawn.mockClear();
    mockBroadcastAlert.mockClear();
  });

  test('returns an error string when the db is unavailable', async () => {
    const output = await handleDeepResearchProTool(null, userId, 'start_research', { topic: 'x' });
    expect(output).toMatch(/^Error:/);
  });

  test('returns an error string when topic is missing', async () => {
    const output = await handleDeepResearchProTool(db, userId, 'start_research', {});
    expect(output).toMatch(/^Error: "topic"/);
  });

  test('returns an error string for an unknown action', async () => {
    const output = await handleDeepResearchProTool(db, userId, 'bogus_action', { topic: 'x' });
    expect(output).toMatch(/^Error: Unknown Deep Research Pro action/);
  });

  test('start_research spawns the python CLI with research-mode args and records a running job', async () => {
    const output = await handleDeepResearchProTool(db, userId, 'start_research', { topic: 'Rust ownership' });

    expect(output).toMatch(/Started a deep research job on "Rust ownership"/);
    expect(output).toMatch(/Deep Research Results/);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [pythonExe, args, opts] = mockSpawn.mock.calls[0];
    expect(pythonExe).toContain(FAKE_SCRAPER_DIR);
    expect(args).toEqual(expect.arrayContaining(['research', 'Rust ownership', '--max-pages', '100', '--time-budget', '480']));
    expect(opts.cwd).toBe(FAKE_SCRAPER_DIR);
    // No user_settings row exists for this test user, so the LLM env injection has nothing to
    // override - the subprocess just inherits the parent process's own environment unchanged.
    expect(opts.env).toMatchObject(process.env);

    const jobIdMatch = /job (\S+),/.exec(output);
    expect(jobIdMatch).not.toBeNull();
    const row = await db.get('SELECT * FROM deep_research_jobs WHERE job_id = ?', [jobIdMatch[1]]);
    expect(row).toMatchObject({ topic: 'Rust ownership', mode: 'research', status: 'running' });

    // Drain the job so it doesn't leak into later tests reusing the same userId - BUG-10's
    // concurrency guard now refuses a second job for a user while one is still 'running'.
    lastSpawnedChild.emit('close', 1);
    await waitForJobStatus(db, jobIdMatch[1]);
  });

  test('study_guide mode spawns the study-guide subcommand with per-domain args', async () => {
    const output = await handleDeepResearchProTool(db, userId, 'start_research', { topic: 'AWS AI Practitioner', mode: 'study_guide' });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining([
      'study-guide', 'AWS AI Practitioner',
      '--max-pages-per-domain', '20', '--depth-per-domain', '3', '--time-budget-per-domain', '240'
    ]));

    const jobId = /job (\S+),/.exec(output)[1];
    lastSpawnedChild.emit('close', 1);
    await waitForJobStatus(db, jobId);
  });

  test('BUG-10: start_research refuses a second job while one is already running for the same user', async () => {
    const guardUser = await db.run("INSERT INTO users (username, password_hash) VALUES ('guardconcurrentuser', 'hashed')");

    const first = await handleDeepResearchProTool(db, guardUser.lastID, 'start_research', { topic: 'First concurrent topic' });
    const firstJobId = /job (\S+),/.exec(first)[1];

    const second = await handleDeepResearchProTool(db, guardUser.lastID, 'start_research', { topic: 'Second concurrent topic' });
    expect(second).toMatch(/already running/);
    expect(second).toContain('First concurrent topic');
    expect(second).toContain(firstJobId);

    // The rejected request never spawned a second subprocess.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const rows = await db.all("SELECT * FROM deep_research_jobs WHERE user_id = ? AND status = 'running'", [guardUser.lastID]);
    expect(rows).toHaveLength(1);
  });

  test('BUG-10: a different user can still start their own research job while another user has one running', async () => {
    const userA = await db.run("INSERT INTO users (username, password_hash) VALUES ('guardownera', 'hashed')");
    const userB = await db.run("INSERT INTO users (username, password_hash) VALUES ('guardownerb', 'hashed')");

    await handleDeepResearchProTool(db, userA.lastID, 'start_research', { topic: 'Owner A topic' });

    const second = await handleDeepResearchProTool(db, userB.lastID, 'start_research', { topic: 'Owner B topic' });
    expect(second).toMatch(/Started a deep research job on "Owner B topic"/);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  test('on successful completion, posts the report into the Deep Research Results chat and broadcasts an alert', async () => {
    const reportPath = path.join(tmpReportDir, 'rust-report.md');
    fs.writeFileSync(reportPath, '# Rust Ownership\n\nOwnership rules explained.', 'utf-8');

    const output = await handleDeepResearchProTool(db, userId, 'start_research', { topic: 'Rust ownership deep dive' });
    const jobId = /job (\S+),/.exec(output)[1];

    lastSpawnedChild.stdout.emit('data', Buffer.from(`Report written to: ${reportPath}\n`));
    lastSpawnedChild.emit('close', 0);
    const row = await waitForJobStatus(db, jobId);
    expect(row.status).toBe('completed');
    expect(row.report_path).toBe(reportPath);

    const chat = await db.get('SELECT * FROM chats WHERE user_id = ? AND title = ?', [userId, RESULTS_CHAT_TITLE]);
    expect(chat).toBeTruthy();

    const message = await db.get(
      'SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1',
      [chat.id]
    );
    expect(message.content).toContain('Ownership rules explained.');
    expect(message.role).toBe('assistant');

    expect(mockBroadcastAlert).toHaveBeenCalledWith(expect.objectContaining({ type: 'info' }), userId);

    const notification = await db.get('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);
    expect(notification.type).toBe('info');
    expect(notification.chat_id).toBe(chat.id);
    expect(notification.is_read).toBe(0);
  });

  test('on non-zero exit code, marks the job failed and posts a failure message instead', async () => {
    const output = await handleDeepResearchProTool(db, userId, 'start_research', { topic: 'A topic that will fail' });
    const jobId = /job (\S+),/.exec(output)[1];

    lastSpawnedChild.emit('close', 1);
    const row = await waitForJobStatus(db, jobId);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/exited with code 1/);

    const chat = await db.get('SELECT * FROM chats WHERE user_id = ? AND title = ?', [userId, RESULTS_CHAT_TITLE]);
    const message = await db.get('SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1', [chat.id]);
    expect(message.content).toMatch(/Deep research failed/);
    expect(mockBroadcastAlert).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }), userId);

    const notification = await db.get('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);
    expect(notification.type).toBe('error');
    expect(notification.chat_id).toBe(chat.id);
  });

  test('on close with no parseable report path, marks the job failed', async () => {
    const output = await handleDeepResearchProTool(db, userId, 'start_research', { topic: 'No report line topic' });
    const jobId = /job (\S+),/.exec(output)[1];

    lastSpawnedChild.stdout.emit('data', Buffer.from('some unrelated output\n'));
    lastSpawnedChild.emit('close', 0);
    const row = await waitForJobStatus(db, jobId);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/no report path/);
  });

  test('check_status with no jobs for a fresh user reports none started', async () => {
    const fresh = await db.run("INSERT INTO users (username, password_hash) VALUES ('freshuser', 'hashed')");
    const output = await handleDeepResearchProTool(db, fresh.lastID, 'check_status', {});
    expect(output).toMatch(/No deep research jobs/);
  });

  test('check_status with an unknown jobId returns an error', async () => {
    const output = await handleDeepResearchProTool(db, userId, 'check_status', { jobId: 'does-not-exist' });
    expect(output).toMatch(/^Error: No job found/);
  });

  test('start_research injects PATTI\'s own local model/server into the subprocess env, overriding the scraper\'s own .env', async () => {
    const localUser = await db.run("INSERT INTO users (username, password_hash) VALUES ('localmodeluser', 'hashed')");
    await db.run(
      `INSERT INTO user_settings (user_id, provider, model_name, preferred_local_model, local_url, local_key)
       VALUES (?, 'local', 'some-default', 'google/gemma-4-e4b', 'http://192.168.1.42:1234/v1', 'lm-studio')`,
      [localUser.lastID]
    );

    await handleDeepResearchProTool(db, localUser.lastID, 'start_research', { topic: 'PwC CEDA' });

    const [, , opts] = mockSpawn.mock.calls[0];
    // This is the actual fix for the reported crash: the scraper project's own .env still
    // defaults LLM_MODEL to a stale placeholder ("qwen2.5-coder-7b-instruct" historically) -
    // if that ever names a different model than the one already loaded in LM Studio, LM Studio
    // loads a second model to satisfy it, which exhausted memory alongside gemma-4-e4b and
    // crashed the process (observed: exit code 1, empty stderr - consistent with an OS-level
    // OOM kill, not a normal Python exception). Injecting the real values here means the
    // subprocess always targets the exact model/server PATTI already has loaded.
    expect(opts.env.LLM_PROVIDER).toBe('lmstudio');
    expect(opts.env.LLM_BASE_URL).toBe('http://192.168.1.42:1234/v1');
    expect(opts.env.LLM_MODEL).toBe('google/gemma-4-e4b');
    // The "lm-studio" placeholder key must not be forwarded as a real API key.
    expect(opts.env.LLM_API_KEY).toBeUndefined();
  });

  test('start_research does not override the subprocess env when PATTI is on an online provider', async () => {
    const onlineUser = await db.run("INSERT INTO users (username, password_hash) VALUES ('onlineuser', 'hashed')");
    await db.run(
      "INSERT INTO user_settings (user_id, provider, online_provider) VALUES (?, 'online', 'anthropic')",
      [onlineUser.lastID]
    );

    await handleDeepResearchProTool(db, onlineUser.lastID, 'start_research', { topic: 'Some topic' });

    const [, , opts] = mockSpawn.mock.calls[0];
    // No shared local model to collide with, so the scraper's own independent config is left
    // exactly as it was (no LLM_PROVIDER/LLM_MODEL keys added beyond whatever the parent
    // process's own environment already had).
    expect(opts.env.LLM_PROVIDER).toBe(process.env.LLM_PROVIDER);
    expect(opts.env.LLM_MODEL).toBe(process.env.LLM_MODEL);
  });

  test('check_status returns the most recent job when no jobId is given', async () => {
    const output = await handleDeepResearchProTool(db, userId, 'start_research', { topic: 'Latest job topic' });
    const jobId = /job (\S+),/.exec(output)[1];

    const status = await handleDeepResearchProTool(db, userId, 'check_status', {});
    expect(status).toMatch(/Latest job topic/);
    expect(status).toMatch(/still running/);
    void jobId;
  });
});

// The 'close' handler in deep_research_pro_tool.js is deliberately fire-and-forget
// (nothing awaits child-process completion synchronously, matching real usage), so
// tests must poll for the job to leave 'running' rather than assuming a fixed number
// of promise/microtask ticks is enough - a chain of several real sqlite awaits can
// take more than one setImmediate cycle to fully settle.
async function waitForJobStatus(db, jobId, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await db.get('SELECT * FROM deep_research_jobs WHERE job_id = ?', [jobId]);
    if (row && row.status !== 'running') return row;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for job ${jobId} to leave 'running' status`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
