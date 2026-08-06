const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

// Mock db.js
let mockTestDb = null;
let mockDbError = false;
jest.mock('../db', () => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const fs = require('fs');
  const path = require('path');

  return {
    getDb: async () => {
      if (mockDbError) throw new Error('Database error');
      if (mockTestDb) return mockTestDb;
      mockTestDb = await open({
        filename: ':memory:',
        driver: sqlite3.Database
      });
      const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
      await mockTestDb.exec(schemaSql);
      return mockTestDb;
    }
  };
});

// Mock runAgentLoop and generateGreetingAndSave from ai.js
const mockRunAgentLoop = jest.fn();
const mockGenerateGreetingAndSave = jest.fn().mockImplementation(async (db, userId, chatId) => {
  await db.run(
    'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)',
    [chatId, 'assistant', 'Mock Greeting Message']
  );
});
jest.mock('../ai', () => ({
  runAgentLoop: (...args) => mockRunAgentLoop(...args),
  handleGoogleNewsTool: jest.fn(),
  generateGreetingAndSave: (...args) => mockGenerateGreetingAndSave(...args)
}));

// Mock embeddings utility to avoid external network requests
jest.mock('../utils/embeddings', () => ({
  getEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3])
}));

// Mock lmstudio utility to avoid local service network queries
jest.mock('../utils/lmstudio', () => ({
  listLocalModels: jest.fn().mockResolvedValue([]),
  loadLocalModel: jest.fn().mockResolvedValue(true),
  unloadLocalModel: jest.fn().mockResolvedValue(true)
}));

// Mock model selector agent to avoid LLM agent execution overhead
jest.mock('../utils/model_selector', () => ({
  selectBestModel: jest.fn().mockImplementation(async (settings) => settings.modelName)
}));

const chatRouter = require('../routes/chat');
const { JWT_SECRET } = require('../middleware/auth');
const app = express();
app.use(express.json());
app.use('/api', chatRouter);

describe('Chat Router Tests', () => {
  let token;
  let userId;

  beforeAll(async () => {
    const { open } = require('sqlite');
    const sqlite3 = require('sqlite3');
    const fs = require('fs');
    const path = require('path');

    const db = await open({
      filename: ':memory:',
      driver: sqlite3.Database
    });
    mockTestDb = db;
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await mockTestDb.exec(schemaSql);

    const userResult = await db.run("INSERT INTO users (username, password_hash) VALUES ('chatuser', 'hashed')");
    userId = userResult.lastID;
    token = jwt.sign({ id: userId, username: 'chatuser' }, JWT_SECRET);
  });

  afterAll(async () => {
    if (mockTestDb) {
      await mockTestDb.close();
      mockTestDb = null;
    }
  });

  beforeEach(() => {
    mockDbError = false;
    jest.clearAllMocks();
  });

  test('POST /api/chats & GET /api/chats - operations success', async () => {
    // Create chat
    const createRes = await request(app)
      .post('/api/chats')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'My Test Chat' });

    expect(createRes.statusCode).toBe(200);
    expect(createRes.body.success).toBe(true);
    expect(createRes.body.title).toBe('My Test Chat');
    expect(createRes.body.chatId).toBeDefined();

    // Get chats list
    const listRes = await request(app)
      .get('/api/chats')
      .set('Authorization', `Bearer ${token}`);

    expect(listRes.statusCode).toBe(200);
    expect(listRes.body.length).toBeGreaterThanOrEqual(1);
    expect(listRes.body[0].title).toBe('My Test Chat');
  });

  test('PUT /api/chats/:id & DELETE /api/chats/:id - rename and delete operations', async () => {
    const db = await mockTestDb;
    const insertRes = await db.run('INSERT INTO chats (user_id, title) VALUES (?, ?)', [userId, 'Old Name']);
    const chatId = insertRes.lastID;

    // Bad rename input
    const badRename = await request(app)
      .put(`/api/chats/${chatId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '' });
    expect(badRename.statusCode).toBe(400);

    // Good rename
    const renameRes = await request(app)
      .put(`/api/chats/${chatId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'New Name' });
    expect(renameRes.statusCode).toBe(200);

    const checkRename = await db.get('SELECT title FROM chats WHERE id = ?', [chatId]);
    expect(checkRename.title).toBe('New Name');

    // Get messages for chat (empty initially)
    const messagesRes = await request(app)
      .get(`/api/chats/${chatId}/messages`)
      .set('Authorization', `Bearer ${token}`);
    expect(messagesRes.statusCode).toBe(200);
    expect(messagesRes.body.length).toBe(0);

    // Delete chat
    const delRes = await request(app)
      .delete(`/api/chats/${chatId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(delRes.statusCode).toBe(200);

    const checkDel = await db.get('SELECT id FROM chats WHERE id = ?', [chatId]);
    expect(checkDel).toBeUndefined();
  });

  test('GET /api/chats/search - matches chat titles and message content, scoped to the requesting user', async () => {
    const db = await mockTestDb;
    const otherUser = await db.run("INSERT INTO users (username, password_hash) VALUES ('otherchatuser', 'hashed')");
    const otherToken = jwt.sign({ id: otherUser.lastID, username: 'otherchatuser' }, JWT_SECRET);

    const titleMatch = await db.run('INSERT INTO chats (user_id, title) VALUES (?, ?)', [userId, 'Kubernetes notes']);
    const contentMatch = await db.run('INSERT INTO chats (user_id, title) VALUES (?, ?)', [userId, 'Chat 9:00 AM']);
    await db.run(
      "INSERT INTO messages (chat_id, role, content) VALUES (?, 'user', 'Can you explain how kubernetes handles pod scheduling?')",
      [contentMatch.lastID]
    );
    const noMatch = await db.run('INSERT INTO chats (user_id, title) VALUES (?, ?)', [userId, 'Weekend plans']);
    await db.run("INSERT INTO messages (chat_id, role, content) VALUES (?, 'user', 'What is the weather tomorrow?')", [noMatch.lastID]);
    // Belongs to a different user - must never appear in this user's results even though it matches.
    const otherUsersChat = await db.run('INSERT INTO chats (user_id, title) VALUES (?, ?)', [otherUser.lastID, 'kubernetes secrets']);

    const res = await request(app)
      .get('/api/chats/search')
      .query({ q: 'kubernetes' })
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    const chatIds = res.body.map((r) => r.chatId);
    expect(chatIds).toContain(titleMatch.lastID);
    expect(chatIds).toContain(contentMatch.lastID);
    expect(chatIds).not.toContain(noMatch.lastID);
    expect(chatIds).not.toContain(otherUsersChat.lastID);

    const contentResult = res.body.find((r) => r.chatId === contentMatch.lastID);
    expect(contentResult.snippet.toLowerCase()).toContain('kubernetes');

    // The other user's own search still finds their own matching chat.
    const otherRes = await request(app)
      .get('/api/chats/search')
      .query({ q: 'kubernetes' })
      .set('Authorization', `Bearer ${otherToken}`);
    expect(otherRes.body.map((r) => r.chatId)).toEqual([otherUsersChat.lastID]);
  });

  test('GET /api/chats/search - a query under 2 characters returns an empty array without querying the db', async () => {
    const res = await request(app)
      .get('/api/chats/search')
      .query({ q: 'k' })
      .set('Authorization', `Bearer ${token}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([]);

    const resEmpty = await request(app)
      .get('/api/chats/search')
      .set('Authorization', `Bearer ${token}`);
    expect(resEmpty.body).toEqual([]);
  });

  test('GET /api/chats/search - LIKE wildcard characters in the query are escaped, not treated as wildcards', async () => {
    const db = await mockTestDb;
    const wildcardChat = await db.run('INSERT INTO chats (user_id, title) VALUES (?, ?)', [userId, 'Discount: 50% off']);
    await db.run('INSERT INTO chats (user_id, title) VALUES (?, ?)', [userId, 'Totally unrelated title']);

    const res = await request(app)
      .get('/api/chats/search')
      .query({ q: '50%' })
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.map((r) => r.chatId)).toEqual([wildcardChat.lastID]);
  });

  test('GET /api/chats/search - database failure returns 500', async () => {
    mockDbError = true;
    const res = await request(app)
      .get('/api/chats/search')
      .query({ q: 'kubernetes' })
      .set('Authorization', `Bearer ${token}`);
    expect(res.statusCode).toBe(500);
  });

  describe('buildSnippet', () => {
    const { buildSnippet } = chatRouter;

    test('returns short text unchanged with no ellipses', () => {
      expect(buildSnippet('Short message.', 'short')).toBe('Short message.');
    });

    test('truncates long text with no match to the start, with a trailing ellipsis', () => {
      const longText = 'a'.repeat(300);
      const result = buildSnippet(longText, 'zzz-not-present');
      expect(result.endsWith('…')).toBe(true);
      expect(result.length).toBeLessThan(longText.length);
    });

    test('centers the excerpt on the match, with ellipses on both sides when truncated', () => {
      const text = `${'x'.repeat(100)}FINDME${'y'.repeat(100)}`;
      const result = buildSnippet(text, 'findme'); // case-insensitive match
      expect(result.startsWith('…')).toBe(true);
      expect(result.endsWith('…')).toBe(true);
      expect(result).toContain('FINDME');
    });

    test('returns empty string for empty/null text', () => {
      expect(buildSnippet('', 'term')).toBe('');
      expect(buildSnippet(null, 'term')).toBe('');
    });
  });

  test('POST /api/chat/stream - SSE streaming and thinking process XML/channel parsing', async () => {
    const db = await mockTestDb;
    const insertRes = await db.run('INSERT INTO chats (user_id, title) VALUES (?, ?)', [userId, 'Stream Chat']);
    const chatId = insertRes.lastID;

    // Seed history to verify the history formatter (consecutive role merges and empty skips)
    await db.run("INSERT INTO messages (chat_id, role, content) VALUES (?, 'user', 'My Interests')", [chatId]);
    await db.run("INSERT INTO messages (chat_id, role, content) VALUES (?, 'user', 'are programming')", [chatId]);
    await db.run("INSERT INTO messages (chat_id, role, content) VALUES (?, 'assistant', '')", [chatId]);
    await db.run("INSERT INTO messages (chat_id, role, content) VALUES (?, 'assistant', 'How interesting!')", [chatId]);

    // Mock agent loop behavior to call callbacks
    mockRunAgentLoop.mockImplementation(async (options) => {
      // Call thoughts callback
      options.onThought('Thinking chunk...');
      // Call content callback containing XML thoughts and normal response
      options.onContent('<think>Extracted XML thoughts</think>This is the final response.');
      // Call tool call callback
      options.onToolCall({ tool: 'weather', action: 'current' });
    });

    const res = await request(app)
      .post('/api/chat/stream')
      .set('Authorization', `Bearer ${token}`)
      .send({ chatId, message: 'What is the weather?' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    // Confirm that assistant response was successfully saved to DB
    const lastMsg = await db.get('SELECT * FROM messages WHERE chat_id = ? AND role = ? ORDER BY id DESC LIMIT 1', [chatId, 'assistant']);
    expect(lastMsg).toBeDefined();
    expect(lastMsg.content).toBe('This is the final response.');
    expect(lastMsg.thoughts).toBe('Thinking chunk...\nExtracted XML thoughts');

    // Confirm Q&A stored in memories
    const lastMemory = await db.get('SELECT * FROM memories ORDER BY id DESC LIMIT 1');
    expect(lastMemory).toBeDefined();
    expect(lastMemory.user_id).toBe(userId);
    expect(lastMemory.content).toBe('User asked: "What is the weather?"\nAssistant replied: "This is the final response."');
    expect(lastMemory.level).toBe('short-term');
    expect(lastMemory.expires_at).not.toBeNull();
  });

  test('POST /api/chat/stream - channel thinking tag parsing fallback', async () => {
    const db = await mockTestDb;
    const insertRes = await db.run('INSERT INTO chats (user_id, title) VALUES (?, ?)', [userId, 'Stream Chat 2']);
    const chatId = insertRes.lastID;

    mockRunAgentLoop.mockImplementation(async (options) => {
      options.onContent('<|channel>thoughtExtracted channel thoughts<channel|>Response content.');
    });

    await request(app)
      .post('/api/chat/stream')
      .set('Authorization', `Bearer ${token}`)
      .send({ chatId, message: 'Hello' });

    const lastMsg = await db.get('SELECT * FROM messages WHERE chat_id = ? AND role = ? ORDER BY id DESC LIMIT 1', [chatId, 'assistant']);
    expect(lastMsg.content).toBe('Response content.');
    expect(lastMsg.thoughts).toBe('Extracted channel thoughts');
  });

  test('POST /api/chat/stream - unclosed XML thinking tag parsing', async () => {
    const db = await mockTestDb;
    const insertRes = await db.run('INSERT INTO chats (user_id, title) VALUES (?, ?)', [userId, 'Stream Chat Unclosed XML']);
    const chatId = insertRes.lastID;

    mockRunAgentLoop.mockImplementation(async (options) => {
      options.onContent('<think>Extracted unclosed XML thoughts but no end tag');
    });

    await request(app)
      .post('/api/chat/stream')
      .set('Authorization', `Bearer ${token}`)
      .send({ chatId, message: 'Hello' });

    const lastMsg = await db.get('SELECT * FROM messages WHERE chat_id = ? AND role = ? ORDER BY id DESC LIMIT 1', [chatId, 'assistant']);
    expect(lastMsg.content).toBe('');
    expect(lastMsg.thoughts).toBe('Extracted unclosed XML thoughts but no end tag');
  });

  test('POST /api/chat/stream - unclosed channel thinking tag parsing', async () => {
    const db = await mockTestDb;
    const insertRes = await db.run('INSERT INTO chats (user_id, title) VALUES (?, ?)', [userId, 'Stream Chat Unclosed Channel']);
    const chatId = insertRes.lastID;

    mockRunAgentLoop.mockImplementation(async (options) => {
      options.onContent('<|channel>thoughtExtracted unclosed channel thoughts but no end tag');
    });

    await request(app)
      .post('/api/chat/stream')
      .set('Authorization', `Bearer ${token}`)
      .send({ chatId, message: 'Hello' });

    const lastMsg = await db.get('SELECT * FROM messages WHERE chat_id = ? AND role = ? ORDER BY id DESC LIMIT 1', [chatId, 'assistant']);
    expect(lastMsg.content).toBe('');
    expect(lastMsg.thoughts).toBe('Extracted unclosed channel thoughts but no end tag');
  });

  test('error paths - database failure catches', async () => {
    mockDbError = true;

    const listRes = await request(app)
      .get('/api/chats')
      .set('Authorization', `Bearer ${token}`);
    expect(listRes.statusCode).toBe(500);

    const createRes = await request(app)
      .post('/api/chats')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Fail' });
    expect(createRes.statusCode).toBe(500);

    const delRes = await request(app)
      .delete('/api/chats/999')
      .set('Authorization', `Bearer ${token}`);
    expect(delRes.statusCode).toBe(500);

    const renameRes = await request(app)
      .put('/api/chats/999')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Fail' });
    expect(renameRes.statusCode).toBe(500);

    const msgsRes = await request(app)
      .get('/api/chats/999/messages')
      .set('Authorization', `Bearer ${token}`);
    expect(msgsRes.statusCode).toBe(500);
  });

  test('GET /api/chats/:id/messages - 404 if chat not found', async () => {
    const res = await request(app)
      .get('/api/chats/99999/messages')
      .set('Authorization', `Bearer ${token}`);
    expect(res.statusCode).toBe(404);
  });

  test('POST /api/chat/approve-command - validations and cases', async () => {
    // Missing commandId
    const res1 = await request(app)
      .post('/api/chat/approve-command')
      .set('Authorization', `Bearer ${token}`)
      .send({ approved: true });
    expect(res1.statusCode).toBe(400);

    // Command not found
    const res2 = await request(app)
      .post('/api/chat/approve-command')
      .set('Authorization', `Bearer ${token}`)
      .send({ commandId: 'nonexistent-id', approved: true });
    expect(res2.statusCode).toBe(404);

    // Mock command approval registry to successfully resolve
    const { registerPendingCommand } = require('../utils/commandApproval');
    registerPendingCommand('cmd-123', 'echo hello', userId);

    const res3 = await request(app)
      .post('/api/chat/approve-command')
      .set('Authorization', `Bearer ${token}`)
      .send({ commandId: 'cmd-123', approved: true, command: 'echo hello' });
    expect(res3.statusCode).toBe(200);
    expect(res3.body.success).toBe(true);
  });

  test('POST /api/chat/stream - trigger callbacks and stream error catch block', async () => {
    const db = await mockTestDb;
    const insertRes = await db.run('INSERT INTO chats (user_id, title) VALUES (?, ?)', [userId, 'Stream Callbacks Chat']);
    const chatId = insertRes.lastID;

    // Test successful execution with callbacks triggered
    mockRunAgentLoop.mockImplementationOnce(async (options) => {
      options.onThought('Thinking chunk');
      options.onContent('Content chunk');
      options.onToolCall({ name: 'weather', arguments: {} });
      options.onAgentStatus({ agent: 'supervisor', status: 'thinking' });
      options.onCommandApprovalRequired({ commandId: 'cmd-1', command: 'whoami', safety_analysis: {} });
      // Call isAborted and abortSignal to trigger coverage
      options.isAborted();
      const signal = options.abortSignal;
    });

    const res1 = await request(app)
      .post('/api/chat/stream')
      .set('Authorization', `Bearer ${token}`)
      .send({ chatId, message: 'Hello' });
    expect(res1.statusCode).toBe(200);

    // Test error path
    mockRunAgentLoop.mockImplementationOnce(async (options) => {
      throw new Error('Test runAgentLoop stream failure');
    });

    const res2 = await request(app)
      .post('/api/chat/stream')
      .set('Authorization', `Bearer ${token}`)
      .send({ chatId, message: 'Hello' });
    expect(res2.statusCode).toBe(200); // SSE endpoints return 200 and write error to the stream

    // R1: a totally-failed turn used to leave zero assistant rows (the request
    // just vanished, no bubble, no trace) - it must now persist an honest,
    // clearly-marked error message instead of going silent.
    const errMsg = await db.get(
      "SELECT * FROM messages WHERE chat_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1",
      [chatId]
    );
    expect(errMsg).toBeDefined();
    expect(errMsg.content).toContain('Test runAgentLoop stream failure');
    expect(errMsg.is_error).toBe(1);
  });

  test('POST /api/chat/stream - error persists partial content alongside the failure note', async () => {
    const db = await mockTestDb;
    const insertRes = await db.run('INSERT INTO chats (user_id, title) VALUES (?, ?)', [userId, 'Stream Partial Failure Chat']);
    const chatId = insertRes.lastID;

    mockRunAgentLoop.mockImplementationOnce(async (options) => {
      options.onContent('Here is what I found so far...');
      throw new Error('Connection dropped mid-stream');
    });

    const res = await request(app)
      .post('/api/chat/stream')
      .set('Authorization', `Bearer ${token}`)
      .send({ chatId, message: 'Hello' });
    expect(res.statusCode).toBe(200);

    const errMsg = await db.get(
      "SELECT * FROM messages WHERE chat_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1",
      [chatId]
    );
    expect(errMsg).toBeDefined();
    expect(errMsg.content).toContain('Here is what I found so far...');
    expect(errMsg.content).toContain('Connection dropped mid-stream');
    expect(errMsg.is_error).toBe(1);
  });
});
