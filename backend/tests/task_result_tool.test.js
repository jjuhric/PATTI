const { handleTaskResultTool, TASK_RESULT_READ_CAP } = require('../tools/task_result_tool');

describe('Task Result Tool', () => {
  let db;

  beforeAll(async () => {
    const { open } = require('sqlite');
    const sqlite3 = require('sqlite3');
    const fs = require('fs');
    const path = require('path');

    db = await open({ filename: ':memory:', driver: sqlite3.Database });
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await db.exec(schemaSql);

    // subtask_results has a FK to chats(id) - seed a chat row so inserts succeed.
    await db.run(`INSERT INTO users (username, password_hash) VALUES ('taskresultuser', 'hashed')`);
    await db.run(`INSERT INTO chats (id, user_id, title) VALUES (1, 1, 'Test Chat')`);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  afterEach(async () => {
    await db.run('DELETE FROM subtask_results');
  });

  test('returns an error if db connection is missing', async () => {
    const result = await handleTaskResultTool(null, 'list', {}, { requestId: 'req_1' });
    expect(result).toBe('Error: Database connection is not available.');
  });

  test('returns an error if requestId is missing from context', async () => {
    const result = await handleTaskResultTool(db, 'list', {}, {});
    expect(result).toBe('Error: No request_id in scope for this task_result lookup.');
  });

  test('returns an error for an unknown action', async () => {
    const result = await handleTaskResultTool(db, 'delete_everything', {}, { requestId: 'req_1' });
    expect(result).toBe('Error: Unknown task_result action "delete_everything". Valid actions: list, read.');
  });

  test('list returns metadata only, excluding result_text', async () => {
    await db.run(
      `INSERT INTO subtask_results (chat_id, request_id, agent_name, task_label, result_text, status) VALUES (?, ?, ?, ?, ?, ?)`,
      [1, 'req_list', 'news_agent', 'general news', 'a'.repeat(500), 'done']
    );

    const raw = await handleTaskResultTool(db, 'list', {}, { requestId: 'req_list' });
    const parsed = JSON.parse(raw);

    expect(parsed.count).toBe(1);
    expect(parsed.results[0]).toMatchObject({ agent_name: 'news_agent', task_label: 'general news', status: 'done', char_count: 500 });
    expect(parsed.results[0].result_text).toBeUndefined();
  });

  test('list scopes to the given request_id only, excluding other requests', async () => {
    await db.run(
      `INSERT INTO subtask_results (chat_id, request_id, agent_name, task_label, result_text, status) VALUES (?, ?, ?, ?, ?, ?)`,
      [1, 'req_a', 'weather_expert', 'weather', 'sunny', 'done']
    );
    await db.run(
      `INSERT INTO subtask_results (chat_id, request_id, agent_name, task_label, result_text, status) VALUES (?, ?, ?, ?, ?, ?)`,
      [1, 'req_b', 'sports_agent', 'cowboys', 'won', 'done']
    );

    const raw = await handleTaskResultTool(db, 'list', {}, { requestId: 'req_a' });
    const parsed = JSON.parse(raw);

    expect(parsed.count).toBe(1);
    expect(parsed.results[0].agent_name).toBe('weather_expert');
  });

  test('read returns full content for a matching id + request_id', async () => {
    const insertResult = await db.run(
      `INSERT INTO subtask_results (chat_id, request_id, agent_name, task_label, result_text, status) VALUES (?, ?, ?, ?, ?, ?)`,
      [1, 'req_read', 'news_agent', 'tmz', 'Full article text here.', 'done']
    );

    const raw = await handleTaskResultTool(db, 'read', { id: insertResult.lastID }, { requestId: 'req_read' });
    const parsed = JSON.parse(raw);

    expect(parsed).toMatchObject({
      id: insertResult.lastID,
      agent_name: 'news_agent',
      task_label: 'tmz',
      status: 'done',
      content: 'Full article text here.',
      char_count: 23,
      truncated: false
    });
  });

  test('read is scoped by request_id - a valid id under a different request_id is not found', async () => {
    const insertResult = await db.run(
      `INSERT INTO subtask_results (chat_id, request_id, agent_name, task_label, result_text, status) VALUES (?, ?, ?, ?, ?, ?)`,
      [1, 'req_owner', 'news_agent', 'tmz', 'Secret to this request only.', 'done']
    );

    const result = await handleTaskResultTool(db, 'read', { id: insertResult.lastID }, { requestId: 'req_intruder' });

    expect(result).toBe(`Error: No subtask result with id ${insertResult.lastID} for this request.`);
  });

  test('read returns an error for a missing id parameter', async () => {
    const result = await handleTaskResultTool(db, 'read', {}, { requestId: 'req_x' });
    expect(result).toBe('Error: "id" parameter is required.');
  });

  test('read truncates content over TASK_RESULT_READ_CAP and sets truncated: true', async () => {
    const bigText = 'x'.repeat(TASK_RESULT_READ_CAP + 1000);
    const insertResult = await db.run(
      `INSERT INTO subtask_results (chat_id, request_id, agent_name, task_label, result_text, status) VALUES (?, ?, ?, ?, ?, ?)`,
      [1, 'req_big', 'news_agent', 'big', bigText, 'done']
    );

    const raw = await handleTaskResultTool(db, 'read', { id: insertResult.lastID }, { requestId: 'req_big' });
    const parsed = JSON.parse(raw);

    expect(parsed.truncated).toBe(true);
    expect(parsed.char_count).toBe(bigText.length);
    expect(parsed.content.length).toBeLessThan(bigText.length);
    expect(parsed.content).toContain('[TRUNCATED: Response too large for context]');
  });

  test('read reflects an errored subtask result status', async () => {
    const insertResult = await db.run(
      `INSERT INTO subtask_results (chat_id, request_id, agent_name, task_label, result_text, status) VALUES (?, ?, ?, ?, ?, ?)`,
      [1, 'req_err', 'news_agent', 'general news', 'Agent "news_agent" delegation failed: fetch failed', 'error']
    );

    const raw = await handleTaskResultTool(db, 'read', { id: insertResult.lastID }, { requestId: 'req_err' });
    const parsed = JSON.parse(raw);

    expect(parsed.status).toBe('error');
    expect(parsed.content).toContain('delegation failed');
  });
});
