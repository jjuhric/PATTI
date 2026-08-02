const fs = require('fs');
const path = require('path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');

const mockStoreMemory = jest.fn().mockResolvedValue();
const mockDeleteMemory = jest.fn().mockResolvedValue();
jest.mock('../utils/embeddings', () => {
  const actual = jest.requireActual('../utils/embeddings');
  return {
    ...actual,
    getEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    storeMemory: (...args) => mockStoreMemory(...args),
    deleteMemory: (...args) => mockDeleteMemory(...args)
  };
});

const { generateText, buildSettingsForUser } = require('../utils/llm_text');
jest.mock('../utils/llm_text', () => ({
  generateText: jest.fn(),
  buildSettingsForUser: jest.fn()
}));

const {
  consolidateAllUsersMemories,
  consolidateUserMemories,
  clusterBySimilarity,
  parseMergeDecision,
  STALE_MEMORY_DAYS
} = require('../utils/memory_consolidation');

describe('utils/memory_consolidation.js', () => {
  let db;
  let userId;
  let otherUserId;

  beforeAll(async () => {
    db = await open({ filename: ':memory:', driver: sqlite3.Database });
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await db.exec(schemaSql);

    const result = await db.run("INSERT INTO users (username, password_hash) VALUES ('consolidationuser', 'hashed')");
    userId = result.lastID;
    const other = await db.run("INSERT INTO users (username, password_hash) VALUES ('otherconsolidationuser', 'hashed')");
    otherUserId = other.lastID;

    await db.run(
      `INSERT INTO user_settings (user_id, provider, model_name) VALUES (?, 'local', 'test-model')`,
      [userId]
    );
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await db.run('DELETE FROM memories');
    buildSettingsForUser.mockImplementation(async (dbArg, uid) => {
      const row = await dbArg.get('SELECT * FROM user_settings WHERE user_id = ?', [uid]);
      if (!row) throw new Error('User settings not found.');
      return { provider: 'local', modelName: 'test-model', db: dbArg, userId: uid };
    });
  });

  async function insertMemory({ content, level = 'long-term', agentName = null, recallCount = 0, lastRecalledAt = null, createdAt = null, uid = userId }) {
    const result = await db.run(
      `INSERT INTO memories (user_id, content, level, agent_name, recall_count, last_recalled_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
      [uid, content, level, agentName, recallCount, lastRecalledAt, createdAt]
    );
    return result.lastID;
  }

  describe('clusterBySimilarity', () => {
    test('groups identical-content memories into one cluster', () => {
      const clusters = clusterBySimilarity([
        { content: 'Likes apples', embedding: null },
        { content: 'Likes apples', embedding: null },
        { content: 'Completely different fact', embedding: null }
      ]);
      expect(clusters.length).toBe(1);
      expect(clusters[0].length).toBe(2);
    });
  });

  describe('parseMergeDecision', () => {
    test('parses valid JSON', () => {
      expect(parseMergeDecision('{"action":"merge","mergedContent":"x"}')).toEqual({ action: 'merge', mergedContent: 'x' });
    });
    test('strips markdown code fences', () => {
      expect(parseMergeDecision('```json\n{"action":"keep_separate"}\n```')).toEqual({ action: 'keep_separate' });
    });
    test('returns null for malformed JSON', () => {
      expect(parseMergeDecision('not json at all')).toBeNull();
    });
    test('returns null for an unrecognized action', () => {
      expect(parseMergeDecision('{"action":"delete_everything"}')).toBeNull();
    });
    test('returns null for empty input', () => {
      expect(parseMergeDecision('')).toBeNull();
      expect(parseMergeDecision(null)).toBeNull();
    });
  });

  describe('consolidateUserMemories - merge pass', () => {
    test('merge decision: survivor gets merged content, loser deleted from SQLite and LanceDB', async () => {
      const idA = await insertMemory({ content: 'Likes apples', recallCount: 2, lastRecalledAt: '2026-01-01 00:00:00' });
      const idB = await insertMemory({ content: 'Likes apples', recallCount: 5, lastRecalledAt: '2026-06-01 00:00:00' });

      generateText.mockResolvedValueOnce('{"action":"merge","mergedContent":"Really likes apples"}');

      await consolidateUserMemories(db, userId);

      const rows = await db.all('SELECT * FROM memories WHERE user_id = ? ORDER BY id', [userId]);
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe(idA);
      expect(rows[0].content).toBe('Really likes apples');
      // Higher recall_count/most-recent last_recalled_at carried forward from the loser.
      expect(rows[0].recall_count).toBe(5);
      expect(rows[0].last_recalled_at).toBe('2026-06-01 00:00:00');

      expect(mockDeleteMemory).toHaveBeenCalledWith('Likes apples');
      expect(mockStoreMemory).toHaveBeenCalledWith('Really likes apples', expect.objectContaining({ userId, level: 'long-term' }));
    });

    test('keep_separate decision: both rows survive unchanged', async () => {
      await insertMemory({ content: 'Working at Acme Corp' });
      await insertMemory({ content: 'Working at Acme Corp' });

      generateText.mockResolvedValueOnce('{"action":"keep_separate","reason":"actually distinct"}');

      await consolidateUserMemories(db, userId);

      const rows = await db.all('SELECT * FROM memories WHERE user_id = ?', [userId]);
      expect(rows.length).toBe(2);
      expect(mockDeleteMemory).not.toHaveBeenCalled();
    });

    test('malformed LLM output: cluster skipped, no rows deleted, no throw', async () => {
      await insertMemory({ content: 'Lives in Austin' });
      await insertMemory({ content: 'Lives in Austin' });

      generateText.mockResolvedValueOnce('garbage, not json');

      await expect(consolidateUserMemories(db, userId)).resolves.not.toThrow();

      const rows = await db.all('SELECT * FROM memories WHERE user_id = ?', [userId]);
      expect(rows.length).toBe(2);
    });

    test('different agent_name: not compared/merged even with identical content', async () => {
      await insertMemory({ content: 'Prefers dark mode', agentName: 'coding_assistant' });
      await insertMemory({ content: 'Prefers dark mode', agentName: 'research_agent' });

      await consolidateUserMemories(db, userId);

      // generateText should never have been called - no same-bucket cluster to evaluate.
      expect(generateText).not.toHaveBeenCalled();
      const rows = await db.all('SELECT * FROM memories WHERE user_id = ?', [userId]);
      expect(rows.length).toBe(2);
    });

    test('supersede decision: keeps the memory at keepIndex, discards the other', async () => {
      const idOld = await insertMemory({ content: 'Working at Old Job' });
      const idNew = await insertMemory({ content: 'Working at Old Job' }); // same content for a guaranteed cluster

      generateText.mockResolvedValueOnce('{"action":"supersede","keepIndex":1,"reason":"newer fact supersedes older"}');

      await consolidateUserMemories(db, userId);

      const rows = await db.all('SELECT * FROM memories WHERE user_id = ?', [userId]);
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe(idNew);
    });
  });

  describe('consolidateUserMemories - retirement pass', () => {
    test('recall_count=0 and created 91 days ago -> downgraded to short-term with a fresh expiry', async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - (STALE_MEMORY_DAYS + 1));
      const id = await insertMemory({ content: 'Ancient unused fact', recallCount: 0, createdAt: oldDate.toISOString() });

      await consolidateUserMemories(db, userId);

      const row = await db.get('SELECT * FROM memories WHERE id = ?', [id]);
      expect(row.level).toBe('short-term');
      expect(row.expires_at).not.toBeNull();
      expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now());
    });

    test('recall_count > 0, same age -> NOT downgraded', async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - (STALE_MEMORY_DAYS + 1));
      const id = await insertMemory({ content: 'Old but recalled fact', recallCount: 3, createdAt: oldDate.toISOString() });

      await consolidateUserMemories(db, userId);

      const row = await db.get('SELECT * FROM memories WHERE id = ?', [id]);
      expect(row.level).toBe('long-term');
      expect(row.expires_at).toBeNull();
    });

    test('recall_count=0 but younger than the staleness window -> NOT downgraded', async () => {
      const id = await insertMemory({ content: 'Freshly created fact', recallCount: 0 });

      await consolidateUserMemories(db, userId);

      const row = await db.get('SELECT * FROM memories WHERE id = ?', [id]);
      expect(row.level).toBe('long-term');
    });

    test('a user with no user_settings row still gets retirement, merge silently skipped', async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - (STALE_MEMORY_DAYS + 1));
      const id = await insertMemory({ content: 'Stale for user without settings', recallCount: 0, createdAt: oldDate.toISOString(), uid: otherUserId });

      await expect(consolidateUserMemories(db, otherUserId)).resolves.not.toThrow();

      const row = await db.get('SELECT * FROM memories WHERE id = ?', [id]);
      expect(row.level).toBe('short-term');
      expect(generateText).not.toHaveBeenCalled();
    });
  });

  describe('consolidateAllUsersMemories', () => {
    test('one user failing does not block consolidation for other users', async () => {
      await insertMemory({ content: 'User memory', uid: userId });
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - (STALE_MEMORY_DAYS + 1));
      const otherId = await insertMemory({ content: 'Other user stale memory', recallCount: 0, createdAt: oldDate.toISOString(), uid: otherUserId });

      const realGet = db.get.bind(db);
      const realAll = db.all.bind(db);
      const realRun = db.run.bind(db);
      const dbSpy = {
        get: jest.fn((query, params) => {
          if (query.includes('FROM user_settings') && params && params[0] === userId) {
            throw new Error('Simulated DB failure');
          }
          return realGet(query, params);
        }),
        all: realAll,
        run: realRun
      };

      await expect(consolidateAllUsersMemories(dbSpy)).resolves.not.toThrow();

      // The failing user's memory is untouched (consolidation threw before doing anything to
      // it), but the other user's stale memory was still correctly retired.
      const otherRow = await db.get('SELECT * FROM memories WHERE id = ?', [otherId]);
      expect(otherRow.level).toBe('short-term');
    });
  });
});
