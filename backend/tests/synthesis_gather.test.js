const mockRunAgentTurn = jest.fn();
jest.mock('../utils/agents', () => ({
  runAgentTurn: (...args) => mockRunAgentTurn(...args)
}));

const {
  runSynthesisGatherLoop,
  buildFallbackDataBlock,
  SYNTHESIS_GATHER_AGGREGATE_CAP
} = require('../services/synthesis_gather');

describe('Synthesis Gather Loop', () => {
  let db;

  beforeAll(async () => {
    const { open } = require('sqlite');
    const sqlite3 = require('sqlite3');
    const fs = require('fs');
    const path = require('path');

    db = await open({ filename: ':memory:', driver: sqlite3.Database });
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await db.exec(schemaSql);

    await db.run(`INSERT INTO users (username, password_hash) VALUES ('gatheruser', 'hashed')`);
    await db.run(`INSERT INTO chats (id, user_id, title) VALUES (1, 1, 'Test Chat')`);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  afterEach(async () => {
    await db.run('DELETE FROM subtask_results');
    mockRunAgentTurn.mockReset();
  });

  async function seedRow(requestId, agentName, taskLabel, text, status = 'done') {
    const res = await db.run(
      `INSERT INTO subtask_results (chat_id, request_id, agent_name, task_label, result_text, status) VALUES (?, ?, ?, ?, ?, ?)`,
      [1, requestId, agentName, taskLabel, text, status]
    );
    return res.lastID;
  }

  async function listMetaRows(requestId) {
    return db.all(
      'SELECT id, agent_name, task_label, status, LENGTH(result_text) as char_count FROM subtask_results WHERE request_id = ? ORDER BY id',
      [requestId]
    );
  }

  test('reads each row via the task_result tool and assembles the expected dataBlock', async () => {
    const id1 = await seedRow('req_1', 'news_agent', 'general news', 'News content here.');
    const id2 = await seedRow('req_1', 'weather_expert', 'weather', 'Sunny, 75F.');
    const metaRows = await listMetaRows('req_1');

    mockRunAgentTurn
      .mockResolvedValueOnce({ thought: 'read news', tool: 'task_result', action: 'read', params: { id: id1 } })
      .mockResolvedValueOnce({ thought: 'read weather', tool: 'task_result', action: 'read', params: { id: id2 } })
      .mockResolvedValueOnce({ thought: 'done', tool: 'none', action: '', params: {} });

    const dataBlock = await runSynthesisGatherLoop({
      db, requestId: 'req_1', metaRows, userMessage: 'give me news and weather',
      settings: {}, onThought: () => {}
    });

    expect(dataBlock).toContain('DATA_AVAILABLE: yes');
    expect(dataBlock).toContain('--- [Source: news_agent - general news] ---\nNews content here.');
    expect(dataBlock).toContain('--- [Source: weather_expert - weather] ---\nSunny, 75F.');
    expect(mockRunAgentTurn).toHaveBeenCalledTimes(3);
  });

  test('marks an errored source in the assembled dataBlock', async () => {
    const id1 = await seedRow('req_err', 'news_agent', 'general news', 'Agent "news_agent" delegation failed: fetch failed', 'error');
    const metaRows = await listMetaRows('req_err');

    mockRunAgentTurn
      .mockResolvedValueOnce({ tool: 'task_result', action: 'read', params: { id: id1 } })
      .mockResolvedValueOnce({ tool: 'none', action: '', params: {} });

    const dataBlock = await runSynthesisGatherLoop({
      db, requestId: 'req_err', metaRows, userMessage: 'news please', settings: {}, onThought: () => {}
    });

    expect(dataBlock).toContain('- ERRORED');
    expect(dataBlock).toContain('delegation failed');
  });

  test('enforces the aggregate cap, truncating once the running total is exceeded', async () => {
    const bigChunk = 'y'.repeat(SYNTHESIS_GATHER_AGGREGATE_CAP - 1000);
    const anotherBigChunk = 'z'.repeat(5000);
    const id1 = await seedRow('req_cap', 'agent_a', 'part a', bigChunk);
    const id2 = await seedRow('req_cap', 'agent_b', 'part b', anotherBigChunk);
    const metaRows = await listMetaRows('req_cap');

    mockRunAgentTurn
      .mockResolvedValueOnce({ tool: 'task_result', action: 'read', params: { id: id1 } })
      .mockResolvedValueOnce({ tool: 'task_result', action: 'read', params: { id: id2 } })
      .mockResolvedValueOnce({ tool: 'none', action: '', params: {} });

    const dataBlock = await runSynthesisGatherLoop({
      db, requestId: 'req_cap', metaRows, userMessage: 'big request', settings: {}, onThought: () => {}
    });

    expect(dataBlock.length).toBeLessThan(bigChunk.length + anotherBigChunk.length);
    expect(dataBlock).toContain('[TRUNCATED: Response too large for context]');
  });

  test('stops at metaRows.length + 2 turns if the model never returns tool: none', async () => {
    const id1 = await seedRow('req_loop', 'agent_a', 'a', 'small content a');
    const metaRows = await listMetaRows('req_loop');

    // Always return a read for a fresh, never-before-seen id so duplicate detection
    // doesn't short-circuit the loop before the turn cap does.
    mockRunAgentTurn.mockImplementation(() =>
      Promise.resolve({ tool: 'task_result', action: 'read', params: { id: 999000 + mockRunAgentTurn.mock.calls.length } })
    );

    await runSynthesisGatherLoop({
      db, requestId: 'req_loop', metaRows, userMessage: 'keep going', settings: {}, onThought: () => {}
    });

    expect(mockRunAgentTurn).toHaveBeenCalledTimes(metaRows.length + 2);
  });

  test('stops early on a duplicate read of the same id', async () => {
    const id1 = await seedRow('req_dup', 'agent_a', 'a', 'content a');
    const id2 = await seedRow('req_dup', 'agent_b', 'b', 'content b');
    const metaRows = await listMetaRows('req_dup');

    mockRunAgentTurn
      .mockResolvedValueOnce({ tool: 'task_result', action: 'read', params: { id: id1 } })
      .mockResolvedValueOnce({ tool: 'task_result', action: 'read', params: { id: id1 } }); // duplicate

    await runSynthesisGatherLoop({
      db, requestId: 'req_dup', metaRows, userMessage: 'x', settings: {}, onThought: () => {}
    });

    expect(mockRunAgentTurn).toHaveBeenCalledTimes(2);
  });

  test('exits immediately without calling runAgentTurn when the abort signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const dataBlock = await runSynthesisGatherLoop({
      db, requestId: 'req_abort', metaRows: [{ id: 1, agent_name: 'x', task_label: 'x', status: 'done', char_count: 10 }],
      userMessage: 'x', settings: {}, onThought: () => {}, abortSignal: controller.signal
    });

    expect(mockRunAgentTurn).not.toHaveBeenCalled();
    // Nothing was collected (loop never ran), so it falls back to a direct (empty) read.
    expect(dataBlock).toBe('DATA_AVAILABLE: no');
  });

  test('falls back to buildFallbackDataBlock when the model reads nothing', async () => {
    await seedRow('req_empty', 'agent_a', 'a', 'content a');
    const metaRows = await listMetaRows('req_empty');

    mockRunAgentTurn.mockResolvedValueOnce({ tool: 'none', action: '', params: {} });

    const dataBlock = await runSynthesisGatherLoop({
      db, requestId: 'req_empty', metaRows, userMessage: 'x', settings: {}, onThought: () => {}
    });

    expect(dataBlock).toContain('DATA_AVAILABLE: yes');
    expect(dataBlock).toContain('content a');
  });
});

describe('buildFallbackDataBlock', () => {
  let db;

  beforeAll(async () => {
    const { open } = require('sqlite');
    const sqlite3 = require('sqlite3');
    const fs = require('fs');
    const path = require('path');

    db = await open({ filename: ':memory:', driver: sqlite3.Database });
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await db.exec(schemaSql);

    await db.run(`INSERT INTO users (username, password_hash) VALUES ('fallbackuser', 'hashed')`);
    await db.run(`INSERT INTO chats (id, user_id, title) VALUES (1, 1, 'Test Chat')`);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  test('returns DATA_AVAILABLE: no when there are no rows', async () => {
    const dataBlock = await buildFallbackDataBlock(db, 'req_none', 40000);
    expect(dataBlock).toBe('DATA_AVAILABLE: no');
  });

  test('truncates the concatenated block once it exceeds the given cap', async () => {
    await db.run(
      `INSERT INTO subtask_results (chat_id, request_id, agent_name, task_label, result_text, status) VALUES (?, ?, ?, ?, ?, ?)`,
      [1, 'req_trunc', 'agent_a', 'a', 'w'.repeat(5000), 'done']
    );

    const dataBlock = await buildFallbackDataBlock(db, 'req_trunc', 1000);

    expect(dataBlock.length).toBeLessThan(5000);
    expect(dataBlock).toContain('[TRUNCATED: Response too large for context]');
  });
});
