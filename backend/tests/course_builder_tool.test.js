const fs = require('fs');
const path = require('path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');

// pptxgenjs uses a dynamic import() internally that Jest's CJS transform can't resolve -
// same mock used by tests/document_generator_tool.test.js, isolating our own logic from
// that unrelated library/environment incompatibility.
jest.mock('pptxgenjs', () => {
  return jest.fn().mockImplementation(() => ({
    addSlide: () => ({ addText: () => {} }),
    write: async () => Buffer.from('fake-pptx-bytes')
  }));
});

const mockBroadcastAlert = jest.fn();
jest.mock('../routes/alerts', () => ({ broadcastAlert: (...args) => mockBroadcastAlert(...args) }));

const { handleCourseBuilderTool, RESULTS_CHAT_TITLE } = require('../tools/course_builder_tool');

function mockOutlineThenLessons(lessons) {
  let callIndex = 0;
  return jest.fn(async () => {
    callIndex++;
    if (callIndex === 1) {
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(lessons) } }] })
      };
    }
    const lesson = lessons[callIndex - 2] || lessons[0];
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: `## ${lesson.title}\n\nTeaching content for ${lesson.title}.\n\n### Review Questions\n- What is ${lesson.title}?` } }]
      })
    };
  });
}

async function waitForJobStatus(db, jobId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await db.get('SELECT * FROM course_generation_jobs WHERE job_id = ?', [jobId]);
    if (row && row.status !== 'running') return row;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for job ${jobId} to leave 'running' status`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe('handleCourseBuilderTool', () => {
  let db;
  let userId;
  const generatedDir = path.join(process.cwd(), 'generated_documents');

  beforeAll(async () => {
    db = await open({ filename: ':memory:', driver: sqlite3.Database });
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await db.exec(schemaSql);

    const result = await db.run("INSERT INTO users (username, password_hash) VALUES ('coursebuilderuser', 'hashed')");
    userId = result.lastID;
    await db.run(
      `INSERT INTO user_settings (user_id, provider, model_name, local_url, local_api_style) VALUES (?, 'local', 'test-model', 'http://localhost:1234/v1', 'openai')`,
      [userId]
    );
  });

  afterAll(async () => {
    await db.close();
    if (fs.existsSync(generatedDir)) {
      fs.rmSync(generatedDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    mockBroadcastAlert.mockClear();
  });

  test('returns an error string when the db is unavailable', async () => {
    const output = await handleCourseBuilderTool(null, userId, 'start_course', { topic: 'x' });
    expect(output).toMatch(/^Error:/);
  });

  test('returns an error string when topic is missing', async () => {
    const output = await handleCourseBuilderTool(db, userId, 'start_course', {});
    expect(output).toMatch(/^Error: "topic"/);
  });

  test('returns an error string for an unknown action', async () => {
    const output = await handleCourseBuilderTool(db, userId, 'bogus_action', { topic: 'x' });
    expect(output).toMatch(/^Error: Unknown Course Builder action/);
  });

  test('start_course records a running job immediately and defaults to docx format', async () => {
    global.fetch = mockOutlineThenLessons([
      { title: 'Lesson One', objective: 'Understand basics' },
      { title: 'Lesson Two', objective: 'Apply basics' }
    ]);

    const output = await handleCourseBuilderTool(db, userId, 'start_course', { topic: 'Regex basics' });
    expect(output).toMatch(/Started building a full course on "Regex basics"/);
    expect(output).toMatch(/Generated Courses/);

    const jobIdMatch = /job (\S+),/.exec(output);
    expect(jobIdMatch).not.toBeNull();
    const row = await db.get('SELECT * FROM course_generation_jobs WHERE job_id = ?', [jobIdMatch[1]]);
    expect(row).toMatchObject({ topic: 'Regex basics', format: 'docx', status: 'running' });

    // Drain the background job before the next test reassigns global.fetch - it's
    // fire-and-forget and keeps running on its own, so leaving it in-flight would let it
    // pick up whatever mock a later test installs.
    await waitForJobStatus(db, jobIdMatch[1]);
  });

  test('a completed job writes a real docx file and posts the exact path to the Generated Courses chat', async () => {
    global.fetch = mockOutlineThenLessons([
      { title: 'Intro to Testing', objective: 'Know why tests matter' },
      { title: 'Writing Assertions', objective: 'Write a basic assertion' }
    ]);

    const output = await handleCourseBuilderTool(db, userId, 'start_course', { topic: 'Testing 101' });
    const jobId = /job (\S+),/.exec(output)[1];

    const row = await waitForJobStatus(db, jobId);
    expect(row.status).toBe('completed');
    expect(row.lesson_count).toBe(2);
    expect(row.completed_lessons).toBe(2);
    expect(row.output_path).toBeTruthy();
    expect(fs.existsSync(row.output_path)).toBe(true);

    const chat = await db.get('SELECT * FROM chats WHERE user_id = ? AND title = ?', [userId, RESULTS_CHAT_TITLE]);
    expect(chat).toBeTruthy();
    const message = await db.get('SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1', [chat.id]);
    expect(message.content).toContain('Course ready: Testing 101');
    expect(message.content).toContain(row.output_path);
    expect(message.content).toContain('Intro to Testing');

    expect(mockBroadcastAlert).toHaveBeenCalledWith(expect.objectContaining({ type: 'info' }));

    const notification = await db.get('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);
    expect(notification.type).toBe('info');
    expect(notification.chat_id).toBe(chat.id);
  });

  test('format: "md" writes a plain markdown file directly, bypassing the document generator', async () => {
    global.fetch = mockOutlineThenLessons([{ title: 'Only Lesson', objective: 'Learn the one thing' }]);

    const output = await handleCourseBuilderTool(db, userId, 'start_course', { topic: 'MD Topic', format: 'md' });
    const jobId = /job (\S+),/.exec(output)[1];

    const row = await waitForJobStatus(db, jobId);
    expect(row.status).toBe('completed');
    expect(row.output_path.endsWith('.md')).toBe(true);
    const content = fs.readFileSync(row.output_path, 'utf8');
    expect(content).toContain('# MD Topic');
    expect(content).toContain('Only Lesson');
  });

  test('an unparseable outline response marks the job failed with a real error', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'not json at all' } }] })
    }));

    const output = await handleCourseBuilderTool(db, userId, 'start_course', { topic: 'A topic that will fail' });
    const jobId = /job (\S+),/.exec(output)[1];

    const row = await waitForJobStatus(db, jobId);
    expect(row.status).toBe('failed');
    expect(row.error).toBeTruthy();

    const chat = await db.get('SELECT * FROM chats WHERE user_id = ? AND title = ?', [userId, RESULTS_CHAT_TITLE]);
    const message = await db.get('SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1', [chat.id]);
    expect(message.content).toMatch(/Course generation failed/);
    expect(mockBroadcastAlert).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));

    const notification = await db.get('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);
    expect(notification.type).toBe('error');
    expect(notification.chat_id).toBe(chat.id);
  });

  test('check_status reports "no jobs" for a fresh user', async () => {
    const fresh = await db.run("INSERT INTO users (username, password_hash) VALUES ('freshcourseuser', 'hashed')");
    const output = await handleCourseBuilderTool(db, fresh.lastID, 'check_status', {});
    expect(output).toMatch(/No course generation jobs/);
  });

  test('check_status returns an error for an unknown jobId', async () => {
    const output = await handleCourseBuilderTool(db, userId, 'check_status', { jobId: 'does-not-exist' });
    expect(output).toMatch(/^Error: No job found/);
  });

  test('check_status reports lesson progress for a still-running job', async () => {
    let releaseOutline;
    let callCount = 0;
    const malformedResponse = { ok: true, json: async () => ({ choices: [{ message: { content: 'not json' } }] }) };
    // generateOutline retries once on a malformed response, so only the first call should
    // hang - later retry calls must resolve immediately or the job never leaves 'running'.
    global.fetch = jest.fn(() => {
      callCount++;
      if (callCount === 1) {
        return new Promise((resolve) => { releaseOutline = resolve; });
      }
      return Promise.resolve(malformedResponse);
    });

    const output = await handleCourseBuilderTool(db, userId, 'start_course', { topic: 'Slow topic' });
    const jobId = /job (\S+),/.exec(output)[1];

    const status = await handleCourseBuilderTool(db, userId, 'check_status', { jobId });
    expect(status).toMatch(/Slow topic/);
    expect(status).toMatch(/still running/);

    // Unblock the pending fetch so the job doesn't leak into other tests. start_course
    // returns before the background job's own DB read + fetch() call happen, so wait for
    // fetch to actually be invoked (releaseOutline assigned) before resolving it.
    const deadline = Date.now() + 2000;
    while (!releaseOutline) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for the background job to call fetch()');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    releaseOutline(malformedResponse);
    await waitForJobStatus(db, jobId);
  });
});
