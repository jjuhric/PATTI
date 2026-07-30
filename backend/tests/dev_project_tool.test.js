const fs = require('fs');
const path = require('path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');

const mockBroadcastAlert = jest.fn();
jest.mock('../routes/alerts', () => ({ broadcastAlert: (...args) => mockBroadcastAlert(...args) }));

// dev_project_tool.js lazily require()s '../utils/agents' inside the functions that need it
// (matching dev_pipeline_tool.js's own circular-dependency avoidance), but jest.mock applies
// to the module regardless of when it's required. Mocking runWorkerAgent lets us control the
// QA review and graphics-agent steps directly, instead of simulating agents.js's own internal
// multi-turn tool loop (which has a different response contract than generateText).
const mockRunWorkerAgent = jest.fn();
jest.mock('../utils/agents', () => ({ runWorkerAgent: (...args) => mockRunWorkerAgent(...args) }));

const mockHandleImageTool = jest.fn();
jest.mock('../tools/image_tool', () => ({ handleImageTool: (...args) => mockHandleImageTool(...args) }));

const { handleDevProjectTool, RESULTS_CHAT_TITLE, scanForFakeIndicators, interpretQaVerdict } = require('../tools/dev_project_tool');

// Each build spawns a real `node --check` subprocess per JS file for syntax verification,
// which is slower than a plain mocked-fetch unit test, especially on Windows.
jest.setTimeout(20000);

function mockPlanThenFiles(plan, fileContents) {
  let callIndex = 0;
  return jest.fn(async () => {
    callIndex++;
    if (callIndex === 1) {
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(plan) } }] })
      };
    }
    const content = fileContents[callIndex - 2] ?? fileContents[0];
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] })
    };
  });
}

// A fetch mock that also records each call's request body, so a test can inspect the exact
// prompt text sent for a given call (e.g. to prove a real fetched asset path was injected).
function mockFetchSequence(responses) {
  let callIndex = 0;
  const calls = [];
  const fn = jest.fn(async (url, options) => {
    calls.push({ url, body: options && options.body ? JSON.parse(options.body) : null });
    const content = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] })
    };
  });
  fn.calls = calls;
  return fn;
}

function promptTextFromBody(body) {
  // Matches buildBody()'s openai-style shape used throughout these tests (local_api_style: 'openai').
  return JSON.stringify(body);
}

async function waitForJobStatus(db, jobId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await db.get('SELECT * FROM dev_build_jobs WHERE job_id = ?', [jobId]);
    if (row && row.status !== 'planning' && row.status !== 'building') return row;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for job ${jobId} to finish`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function extractJobId(startOutput) {
  return /job (\S+)\) into/.exec(startOutput)[1];
}

describe('scanForFakeIndicators', () => {
  test('flags common simulated/placeholder tells', () => {
    expect(scanForFakeIndicators('// TODO: implement this later')).toBeTruthy();
    expect(scanForFakeIndicators('const url = "https://example.com/avatars/bama.png";')).toBeTruthy();
    expect(scanForFakeIndicators('// --- SIMULATION START ---')).toBeTruthy();
  });

  test('does not flag genuine content with no red-flag phrases', () => {
    expect(scanForFakeIndicators("console.log('hello from test project');")).toBeNull();
  });

  test('flags the actual fake P2PConnection.ts / avatarManager.ts content that motivated this feature, if present on disk', () => {
    const p2pPath = 'C:\\Users\\jjuhr\\TTT_Game\\src\\network\\P2PConnection.ts';
    const avatarPath = 'C:\\Users\\jjuhr\\TTT_Game\\src\\assets\\avatarManager.ts';
    if (fs.existsSync(p2pPath)) {
      expect(scanForFakeIndicators(fs.readFileSync(p2pPath, 'utf8'))).toBeTruthy();
    }
    if (fs.existsSync(avatarPath)) {
      expect(scanForFakeIndicators(fs.readFileSync(avatarPath, 'utf8'))).toBeTruthy();
    }
  });
});

describe('interpretQaVerdict', () => {
  test('rejects when the response contains an ISSUES: list', () => {
    expect(interpretQaVerdict('ISSUES: fileA.js - fake logic\nREJECT')).toBe(false);
  });

  test('rejects when the response contains the standalone word REJECT with no ISSUES: list', () => {
    expect(interpretQaVerdict('This is not acceptable. REJECT')).toBe(false);
  });

  test('approves on the literal word APPROVE', () => {
    expect(interpretQaVerdict('Reviewed everything, looks solid. APPROVE')).toBe(true);
  });

  // The exact real-world case this fixes: a live test showed qa_engineer's own base prompt
  // can produce a positive, structured JSON review that never contains the literal word
  // APPROVE - e.g. {"status":"success","summary":"...","data":{"review_report":"...
  // Conclusion: The application is complete and meets all specified requirements."}}
  test('approves ambiguous positive prose with no explicit APPROVE/REJECT/ISSUES signal', () => {
    const realWorldQaOutput = JSON.stringify({
      status: 'success',
      summary: 'The functional QA review revealed no critical implementation gaps.',
      data: { review_report: 'Conclusion: The application is complete and meets all specified requirements.' }
    });
    expect(interpretQaVerdict(realWorldQaOutput)).toBe(true);
  });
});

describe('handleDevProjectTool', () => {
  let db;
  let userId;
  const testProjectsRoot = path.join(process.cwd(), 'test_dev_projects');

  beforeAll(async () => {
    db = await open({ filename: ':memory:', driver: sqlite3.Database });
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await db.exec(schemaSql);

    const result = await db.run("INSERT INTO users (username, password_hash) VALUES ('devprojectuser', 'hashed')");
    userId = result.lastID;
    await db.run(
      `INSERT INTO user_settings (user_id, provider, model_name, local_url, local_api_style) VALUES (?, 'local', 'test-model', 'http://localhost:1234/v1', 'openai')`,
      [userId]
    );
  });

  afterAll(async () => {
    await db.close();
    if (fs.existsSync(testProjectsRoot)) {
      fs.rmSync(testProjectsRoot, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    mockBroadcastAlert.mockClear();
    mockHandleImageTool.mockReset();
    // Default: QA always approves on the first pass, so tests that don't care about QA
    // specifically don't need to configure it. Tests that do override this per-test.
    mockRunWorkerAgent.mockReset();
    mockRunWorkerAgent.mockResolvedValue('Reviewed everything - looks genuinely implemented. APPROVE');
  });

  test('returns an error string when the db is unavailable', async () => {
    const output = await handleDevProjectTool(null, userId, 'start_project', { spec: 'x', targetDir: 'y' });
    expect(output).toMatch(/^Error:/);
  });

  test('returns an error string when spec is missing', async () => {
    const output = await handleDevProjectTool(db, userId, 'start_project', { targetDir: path.join(testProjectsRoot, 'noSpec') });
    expect(output).toMatch(/^Error: "spec"/);
  });

  test('returns an error string when targetDir is missing', async () => {
    const output = await handleDevProjectTool(db, userId, 'start_project', { spec: 'a tiny app' });
    expect(output).toMatch(/^Error: "targetDir"/);
  });

  test('returns an error string for an unknown action', async () => {
    const output = await handleDevProjectTool(db, userId, 'bogus_action', {});
    expect(output).toMatch(/^Error: Unknown Dev Project action/);
  });

  test('start_project records a planning job immediately and points at the Software Projects chat', async () => {
    const targetDir = path.join(testProjectsRoot, 'immediate');
    global.fetch = mockPlanThenFiles(
      [{ file: 'index.js', purpose: 'Entry point', contract: 'none' }],
      ["console.log('hi');"]
    );

    const output = await handleDevProjectTool(db, userId, 'start_project', { spec: 'a one-file greeter script', targetDir });
    expect(output).toMatch(/Started building the project \(job/);
    expect(output).toMatch(RESULTS_CHAT_TITLE);

    const jobId = extractJobId(output);
    const row = await db.get('SELECT * FROM dev_build_jobs WHERE job_id = ?', [jobId]);
    expect(row).toMatchObject({ spec: 'a one-file greeter script' });

    // Drain the background job before later tests reassign global.fetch.
    await waitForJobStatus(db, jobId);
  });

  test('a completed build writes real files, checkpoints progress, records notes, runs exactly one QA pass, and posts to the results chat', async () => {
    const targetDir = path.join(testProjectsRoot, 'greeter');
    const plan = [
      { file: 'index.js', purpose: 'Entry point that logs a greeting', contract: 'no exports' },
      { file: 'README.md', purpose: 'Usage notes', contract: '' }
    ];
    const fileContents = [
      "console.log('hello from test project');",
      '# Test Project\n\nRun with `node index.js`.'
    ];
    const fetchMock = mockPlanThenFiles(plan, fileContents);
    global.fetch = fetchMock;

    const output = await handleDevProjectTool(db, userId, 'start_project', { spec: 'a tiny greeter app', targetDir });
    const jobId = extractJobId(output);

    const row = await waitForJobStatus(db, jobId);
    expect(row.status).toBe('completed');
    expect(row.step_count).toBe(2);
    expect(row.completed_steps).toBe(2);

    expect(fs.readFileSync(path.join(targetDir, 'index.js'), 'utf8')).toBe(fileContents[0]);
    expect(fs.readFileSync(path.join(targetDir, 'README.md'), 'utf8')).toBe(fileContents[1]);

    // No heuristic hit and QA approved on the first pass -> exactly plan + 2 files fetch
    // calls (no extra regeneration), and exactly one QA call.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(mockRunWorkerAgent).toHaveBeenCalledTimes(1);
    expect(mockRunWorkerAgent).toHaveBeenCalledWith('qa_engineer', expect.anything(), expect.any(String), db, userId);

    expect(row.output_summary).toMatch(/QA review: approved/);

    // The plan itself was persisted via agent_job_store, and one note per written file.
    const specRows = await db.all('SELECT * FROM agent_job_store WHERE job_id = ? AND entry_type = ?', [jobId, 'spec']);
    expect(specRows.length).toBeGreaterThan(0);
    const noteRows = await db.all('SELECT * FROM agent_job_store WHERE job_id = ? AND entry_type = ? ORDER BY seq', [jobId, 'note']);
    expect(noteRows).toHaveLength(2);
    expect(noteRows[0].content).toMatch(/index\.js/);
    expect(noteRows[1].content).toMatch(/README\.md/);

    const chat = await db.get('SELECT * FROM chats WHERE user_id = ? AND title = ?', [userId, RESULTS_CHAT_TITLE]);
    expect(chat).toBeTruthy();
    const message = await db.get('SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1', [chat.id]);
    expect(message.content).toContain(targetDir);
    expect(message.content).toContain('index.js');
    expect(message.content).toContain('README.md');

    expect(mockBroadcastAlert).toHaveBeenCalledWith(expect.objectContaining({ type: 'info' }));

    // Live progress signal: busy near the start, and explicitly cleared (active: false)
    // once the job is truly done - this is what the frontend locks/unlocks chat input on.
    const agentStatusCalls = mockBroadcastAlert.mock.calls
      .map((call) => call[0])
      .filter((arg) => arg.type === 'agent_status');
    expect(agentStatusCalls.length).toBeGreaterThan(0);
    expect(agentStatusCalls[0]).toMatchObject({ active: true, agent: 'developer_agent' });
    expect(agentStatusCalls[agentStatusCalls.length - 1]).toMatchObject({ active: false });
  });

  test('a file with a fake/simulated indicator is regenerated exactly once', async () => {
    const targetDir = path.join(testProjectsRoot, 'fakecheck');
    const plan = [{ file: 'notes.txt', purpose: 'Project notes', contract: '' }];
    const fetchMock = mockPlanThenFiles(plan, [
      '// SIMULATION: this would connect for real in production',
      'Real, genuine notes content with no red flags.'
    ]);
    global.fetch = fetchMock;

    const output = await handleDevProjectTool(db, userId, 'start_project', { spec: 'a notes file', targetDir });
    const jobId = extractJobId(output);
    const row = await waitForJobStatus(db, jobId);

    expect(row.status).toBe('completed');
    expect(fs.readFileSync(path.join(targetDir, 'notes.txt'), 'utf8')).toBe('Real, genuine notes content with no red flags.');
    // plan + first attempt + one regeneration = 3 fetch calls, not more.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('a QA REJECT with ISSUES lines regenerates only the named files, then runs a second QA pass', async () => {
    const targetDir = path.join(testProjectsRoot, 'qareject');
    const plan = [
      { file: 'fileA.txt', purpose: 'File A', contract: '' },
      { file: 'fileB.txt', purpose: 'File B', contract: '' }
    ];
    const fetchMock = mockPlanThenFiles(plan, ['original A content', 'original B content']);
    global.fetch = jest.fn((...args) => {
      // Third call onward (after plan + 2 initial files) is the QA-driven regeneration of fileA only.
      if (fetchMock.mock.calls.length >= 3) {
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: 'regenerated A content' } }] }) });
      }
      return fetchMock(...args);
    });

    let qaCallCount = 0;
    mockRunWorkerAgent.mockImplementation(async (agentName) => {
      if (agentName === 'qa_engineer') {
        qaCallCount++;
        if (qaCallCount === 1) return 'ISSUES: fileA.txt - contains fake data\nREJECT';
        return 'APPROVE';
      }
      return 'APPROVE';
    });

    const output = await handleDevProjectTool(db, userId, 'start_project', { spec: 'two text files', targetDir });
    const jobId = extractJobId(output);
    const row = await waitForJobStatus(db, jobId);

    expect(row.status).toBe('completed');
    expect(qaCallCount).toBe(2);
    expect(fs.readFileSync(path.join(targetDir, 'fileA.txt'), 'utf8')).toBe('regenerated A content');
    expect(fs.readFileSync(path.join(targetDir, 'fileB.txt'), 'utf8')).toBe('original B content');
    expect(row.output_summary).toMatch(/QA review: approved/);
  });

  test('an assetQueries step fetches a real image via image_tool and injects its path into the file prompt', async () => {
    const targetDir = path.join(testProjectsRoot, 'withasset');
    const plan = [{
      file: 'avatarManager.js',
      purpose: 'Maps team ids to avatar image paths',
      contract: 'getAvatarPath(teamId)',
      assetQueries: ['Ohio State Buckeyes logo']
    }];
    mockHandleImageTool.mockResolvedValue('Downloaded an image for "Ohio State Buckeyes logo" to "/fake/assets/ohio_state.png". License: CC BY-SA 4.0.');

    const fetchMock = mockFetchSequence([
      JSON.stringify(plan),
      'module.exports = { getAvatarPath: () => "/fake/assets/ohio_state.png" };'
    ]);
    global.fetch = fetchMock;

    const output = await handleDevProjectTool(db, userId, 'start_project', { spec: 'college avatar mapper', targetDir });
    const jobId = extractJobId(output);
    const row = await waitForJobStatus(db, jobId);

    expect(row.status).toBe('completed');
    expect(mockHandleImageTool).toHaveBeenCalledWith('search_image', {
      query: 'Ohio State Buckeyes logo',
      destDir: path.join(targetDir, 'assets')
    });

    const fileGenCallBody = promptTextFromBody(fetchMock.calls[1].body);
    expect(fileGenCallBody).toContain('/fake/assets/ohio_state.png');
  });

  test('a type: "graphic" step delegates to the graphics_engineer worker agent instead of the plain per-file path', async () => {
    const targetDir = path.join(testProjectsRoot, 'withgraphic');
    const plan = [{ file: 'icon.svg', purpose: 'App icon', contract: '', type: 'graphic' }];
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(plan) } }] })
    }));
    global.fetch = fetchMock;

    mockRunWorkerAgent.mockImplementation(async (agentName, settings, task) => {
      if (agentName === 'graphics_engineer') {
        const match = /File to create \(write here, exactly\): "(.+?)"/.exec(task);
        if (match) fs.writeFileSync(match[1], '<svg><circle r="5"/></svg>', 'utf8');
        return 'Wrote the icon.';
      }
      return 'APPROVE';
    });

    const output = await handleDevProjectTool(db, userId, 'start_project', { spec: 'an app with a custom icon', targetDir });
    const jobId = extractJobId(output);
    const row = await waitForJobStatus(db, jobId);

    expect(row.status).toBe('completed');
    // Only the plan call goes through fetch - the graphic step never calls generateFileContent.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockRunWorkerAgent).toHaveBeenCalledWith('graphics_engineer', expect.anything(), expect.any(String), db, userId);
    expect(fs.readFileSync(path.join(targetDir, 'icon.svg'), 'utf8')).toBe('<svg><circle r="5"/></svg>');
    expect(row.output_summary).toContain('icon.svg');
  });

  test('an unparseable plan response marks the job failed with a real error', async () => {
    const targetDir = path.join(testProjectsRoot, 'badplan');
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'not json at all' } }] })
    }));

    const output = await handleDevProjectTool(db, userId, 'start_project', { spec: 'this will fail to plan', targetDir });
    const jobId = extractJobId(output);

    const row = await waitForJobStatus(db, jobId);
    expect(row.status).toBe('failed');
    expect(row.error).toBeTruthy();

    const chat = await db.get('SELECT * FROM chats WHERE user_id = ? AND title = ?', [userId, RESULTS_CHAT_TITLE]);
    const message = await db.get('SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1', [chat.id]);
    expect(message.content).toMatch(/Project build failed/);
    expect(mockBroadcastAlert).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));

    // Even on failure, the busy signal must be explicitly cleared - otherwise the chat
    // would stay locked forever after a failed build.
    expect(mockBroadcastAlert).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_status', active: false }));
  });

  test('check_status reports "no project builds" for a fresh user', async () => {
    const fresh = await db.run("INSERT INTO users (username, password_hash) VALUES ('freshdevuser', 'hashed')");
    const output = await handleDevProjectTool(db, fresh.lastID, 'check_status', {});
    expect(output).toMatch(/No project builds/);
  });

  test('check_status returns an error for an unknown jobId', async () => {
    const output = await handleDevProjectTool(db, userId, 'check_status', { jobId: 'does-not-exist' });
    expect(output).toMatch(/^Error: No job found/);
  });
});
