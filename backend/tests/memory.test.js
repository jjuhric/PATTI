const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const { handleMemoryTool } = require('../tools/memory_tool');

// Mock embeddings utility
jest.mock('../utils/embeddings', () => {
  const actual = jest.requireActual('../utils/embeddings');
  return {
    ...actual,
    getEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    storeMemory: jest.fn().mockResolvedValue(),
    searchMemory: jest.fn().mockImplementation(async (query, limit = 5) => {
      if (!mockTestDb) return JSON.stringify([]);
      try {
        const rows = await mockTestDb.all(
          'SELECT content, level, expires_at FROM memories'
        );
        const scored = rows.map(r => ({
          text: r.content,
          metadata: { userId: 1, level: r.level, expiresAt: r.expires_at, agentName: null },
          score: 0.9
        }));
        const matched = scored.filter(r => {
          if (query === 'apples') {
            return false;
          }
          return r.text.toLowerCase().includes(query.toLowerCase()) || query.toLowerCase().includes(r.text.toLowerCase());
        });
        return JSON.stringify(matched.slice(0, limit));
      } catch (err) {
        return JSON.stringify([]);
      }
    })
  };
});

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

const memoryRouter = require('../routes/memory');
const { JWT_SECRET } = require('../middleware/auth');
const app = express();
app.use(express.json());
app.use('/api/memories', memoryRouter);

describe('Memory Capabilities Tests', () => {
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

    // Create user and generate token
    const result = await db.run("INSERT INTO users (username, password_hash) VALUES ('memoryuser', 'hashed')");
    userId = result.lastID;
    token = jwt.sign({ id: userId, username: 'memoryuser' }, JWT_SECRET);
  });

  afterAll(async () => {
    if (mockTestDb) {
      await mockTestDb.close();
      mockTestDb = null;
    }
  });

  beforeEach(async () => {
    mockDbError = false;
    if (mockTestDb) {
      await mockTestDb.run('DELETE FROM memories');
    }
  });

  describe('Route Tests', () => {
    test('GET /api/memories - returns empty array initially', async () => {
      const res = await request(app)
        .get('/api/memories')
        .set('Authorization', `Bearer ${token}`);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual([]);
    });

    test('POST /api/memories - creates long-term memory', async () => {
      const res = await request(app)
        .post('/api/memories')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Likes apples', level: 'long-term' });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.memory.content).toBe('Likes apples');
      expect(res.body.memory.level).toBe('long-term');
      expect(res.body.memory.expires_at).toBeNull();
    });

    test('POST /api/memories - creates short-term memory', async () => {
      // 1. Default (30 days)
      const res = await request(app)
        .post('/api/memories')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Going to shop today', level: 'short-term' });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.memory.level).toBe('short-term');
      expect(res.body.memory.expires_at).not.toBeNull();

      // 2. Custom days
      const resDays = await request(app)
        .post('/api/memories')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Relative plan', level: 'short-term', days: 5 });

      expect(resDays.statusCode).toBe(200);
      expect(resDays.body.memory.expires_at).not.toBeNull();

      // 3. Custom expiresAt
      const resExpiry = await request(app)
        .post('/api/memories')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Custom expiry plan', level: 'short-term', expiresAt: '2026-07-15T00:00:00.000Z' });

      expect(resExpiry.statusCode).toBe(200);
      expect(resExpiry.body.memory.expires_at).toBe('2026-07-15T00:00:00.000Z');
    });

    test('POST /api/memories - error cases', async () => {
      const res = await request(app)
        .post('/api/memories')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: '' });

      expect(res.statusCode).toBe(400);
    });

    test('POST /api/memories - prevents duplicate active memory', async () => {
      await request(app)
        .post('/api/memories')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Likes strawberries', level: 'long-term' });

      const res = await request(app)
        .post('/api/memories')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Likes strawberries', level: 'long-term' });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.isDuplicate).toBe(true);
      
      const dbRows = await mockTestDb.all('SELECT * FROM memories WHERE content = ?', ['Likes strawberries']);
      expect(dbRows.length).toBe(1);
    });

    test('DELETE /api/memories/:id - deletes existing memory', async () => {
      // Create memory first
      const createRes = await request(app)
        .post('/api/memories')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Temp memory', level: 'long-term' });

      const memId = createRes.body.memory.id;

      const deleteRes = await request(app)
        .delete(`/api/memories/${memId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(deleteRes.statusCode).toBe(200);
      expect(deleteRes.body.success).toBe(true);
    });

    test('DELETE /api/memories/:id - returns 404 for non-existent memory', async () => {
      const deleteRes = await request(app)
        .delete('/api/memories/99999')
        .set('Authorization', `Bearer ${token}`);

      expect(deleteRes.statusCode).toBe(404);
    });

    test('DB error paths', async () => {
      mockDbError = true;
      const getRes = await request(app)
        .get('/api/memories')
        .set('Authorization', `Bearer ${token}`);
      expect(getRes.statusCode).toBe(500);

      const postRes = await request(app)
        .post('/api/memories')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Likes apples' });
      expect(postRes.statusCode).toBe(500);

      const deleteRes = await request(app)
        .delete('/api/memories/1')
        .set('Authorization', `Bearer ${token}`);
      expect(deleteRes.statusCode).toBe(500);
    });
  });

  describe('Tool Tests', () => {
    test('handleMemoryTool remember - requires valid content', async () => {
      const output = await handleMemoryTool(mockTestDb, userId, 'remember', {});
      expect(output).toContain('Error');
    });

    test('handleMemoryTool remember - defaults level to long-term', async () => {
      const output = await handleMemoryTool(mockTestDb, userId, 'remember', { content: 'test content' });
      expect(output).toContain('Level: long-term');
    });

    test('handleMemoryTool remember - respects short-term level', async () => {
      const output = await handleMemoryTool(mockTestDb, userId, 'remember', { content: 'test content', level: 'short-term' });
      expect(output).toContain('Level: short-term');
      expect(output).toContain('Expires at');
    });

    test('handleMemoryTool remember - prevents duplicate active memory', async () => {
      const outputFirst = await handleMemoryTool(mockTestDb, userId, 'remember', { content: 'test duplicates' });
      expect(outputFirst).toContain('Successfully remembered');

      const outputSecond = await handleMemoryTool(mockTestDb, userId, 'remember', { content: 'test duplicates' });
      expect(outputSecond).toContain('Already remembered');

      const rows = await mockTestDb.all('SELECT * FROM memories WHERE content = ?', ['test duplicates']);
      expect(rows.length).toBe(1);
    });

    test('handleMemoryTool recall - filters out expired memories', async () => {
      // Manually insert an expired memory
      await mockTestDb.run(
        'INSERT INTO memories (user_id, content, level, expires_at) VALUES (?, ?, ?, ?)',
        [userId, 'Expired memory', 'short-term', '2020-01-01T00:00:00.000Z']
      );

      // Manually insert an active memory
      await mockTestDb.run(
        'INSERT INTO memories (user_id, content, level, expires_at) VALUES (?, ?, ?, ?)',
        [userId, 'Active memory', 'long-term', null]
      );

      const output = await handleMemoryTool(mockTestDb, userId, 'recall', {});
      expect(output).toContain('Active memory');
      expect(output).not.toContain('Expired memory');
    });

    test('handleMemoryTool recall - search query matching', async () => {
      await mockTestDb.run("INSERT INTO memories (user_id, content, level) VALUES (?, 'I like blueberries', 'long-term')", [userId]);
      await mockTestDb.run("INSERT INTO memories (user_id, content, level) VALUES (?, 'I like bananas', 'long-term')", [userId]);

      const matchOutput = await handleMemoryTool(mockTestDb, userId, 'recall', { query: 'blueberries' });
      expect(matchOutput).toContain('blueberries');
      expect(matchOutput).not.toContain('bananas');

      const noMatchOutput = await handleMemoryTool(mockTestDb, userId, 'recall', { query: 'apples' });
      expect(noMatchOutput).toContain('No memories matched your search');
      expect(noMatchOutput).toContain('blueberries');
    });

    test('handleMemoryTool recall - only a true semantic match bumps recall_count/last_recalled_at', async () => {
      const insertResult = await mockTestDb.run(
        "INSERT INTO memories (user_id, content, level) VALUES (?, 'I like cherries', 'long-term')",
        [userId]
      );
      const memId = insertResult.lastID;

      // True match: recall_count/last_recalled_at should be bumped.
      await handleMemoryTool(mockTestDb, userId, 'recall', { query: 'cherries' });
      let row = await mockTestDb.get('SELECT recall_count, last_recalled_at FROM memories WHERE id = ?', [memId]);
      expect(row.recall_count).toBe(1);
      expect(row.last_recalled_at).not.toBeNull();

      // Zero-match fallback (listing recent memories, not a real relevance hit): must not
      // count as a recall for memories it happens to list.
      await handleMemoryTool(mockTestDb, userId, 'recall', { query: 'apples' });
      row = await mockTestDb.get('SELECT recall_count FROM memories WHERE id = ?', [memId]);
      expect(row.recall_count).toBe(1);

      // No query at all (list everything): also must not count as a recall.
      await handleMemoryTool(mockTestDb, userId, 'recall', {});
      row = await mockTestDb.get('SELECT recall_count FROM memories WHERE id = ?', [memId]);
      expect(row.recall_count).toBe(1);
    });

    test('handleMemoryTool forget - deletes and handles missing IDs', async () => {
      const rememberOutput = await handleMemoryTool(mockTestDb, userId, 'remember', { content: 'Forget me' });
      const idMatch = rememberOutput.match(/Memory ID: (\d+)/);
      const memoryId = parseInt(idMatch[1]);

      const forgetOutput = await handleMemoryTool(mockTestDb, userId, 'forget', { memoryId });
      expect(forgetOutput).toContain('Successfully forgotten');

      const forgetNonexistent = await handleMemoryTool(mockTestDb, userId, 'forget', { memoryId: 9999 });
      expect(forgetNonexistent).toContain('No memory found');

      const forgetMissingId = await handleMemoryTool(mockTestDb, userId, 'forget', {});
      expect(forgetMissingId).toContain('Error: "memoryId" parameter is required');
    });

    test('handleMemoryTool - invalid action', async () => {
      const output = await handleMemoryTool(mockTestDb, userId, 'invalid_action', {});
      expect(output).toContain('Error: Unknown memory action');
    });

    test('handleMemoryTool - database connection missing', async () => {
      const output = await handleMemoryTool(null, userId, 'recall', {});
      expect(output).toContain('Error: Database connection is not available');
    });

    test('handleMemoryTool - exception safety', async () => {
      const badDb = {
        all: () => { throw new Error('Query error'); },
        run: () => { throw new Error('Write error'); }
      };

      const rememberErr = await handleMemoryTool(badDb, userId, 'remember', { content: 'test content' });
      expect(badDb); // Dummy assertion
      expect(rememberErr).toContain('Error performing memory action');

      const recallErr = await handleMemoryTool(badDb, userId, 'recall', {});
      expect(recallErr).toContain('Error performing memory action');

      const forgetErr = await handleMemoryTool(badDb, userId, 'forget', { memoryId: 1 });
      expect(forgetErr).toContain('Error performing memory action');
    });

    test('handleMemoryTool remember - custom expiresAt and days', async () => {
      const customExpiry = '2026-07-15T00:00:00.000Z';
      const outputExpiry = await handleMemoryTool(mockTestDb, userId, 'remember', {
        content: 'Vacation plan',
        level: 'short-term',
        expiresAt: customExpiry
      });
      expect(outputExpiry).toContain(customExpiry);

      const outputDays = await handleMemoryTool(mockTestDb, userId, 'remember', {
        content: 'Relative plan',
        level: 'short-term',
        days: 5
      });
      expect(outputDays).toContain('Expires at');

      const outputDefault30 = await handleMemoryTool(mockTestDb, userId, 'remember', {
        content: 'Default 30 days plan',
        level: 'short-term'
      });
      expect(outputDefault30).toContain('Expires at');
      // Assert it is roughly 30 days in future
      const match = outputDefault30.match(/Expires at: ([^)]*)/);
      const expiryDate = new Date(match[1]);
      const diffDays = Math.round((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
      expect(diffDays).toBeGreaterThan(28);
      expect(diffDays).toBeLessThan(32);
    });

    test('runDailyMemoryCheck - cleans up expired and schedules alerts', async () => {
      const { runDailyMemoryCheck } = require('../tools/memory_tool');

      // 1. Setup an expired memory (should be deleted)
      await mockTestDb.run(
        'INSERT INTO memories (user_id, content, level, expires_at) VALUES (?, ?, ?, ?)',
        [userId, 'Expired temporary note', 'short-term', '2020-01-01T00:00:00.000Z']
      );

      // 2. Setup a memory mentioning today's date (should schedule calendar event)
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const todayISO = `${yyyy}-${mm}-${dd}`;

      await mockTestDb.run(
        'INSERT INTO memories (user_id, content, level) VALUES (?, ?, ?)',
        [userId, `Vacation on ${todayISO}`, 'long-term']
      );

      await runDailyMemoryCheck(mockTestDb);

      // Verify expired memory is deleted
      const memories = await mockTestDb.all('SELECT * FROM memories WHERE content LIKE "%Expired%"');
      expect(memories.length).toBe(0);

      // Verify calendar event was auto-created for today's vacation memory
      const events = await mockTestDb.all('SELECT * FROM calendar_events WHERE user_id = ?', [userId]);
      expect(events.length).toBe(1);
      expect(events[0].title).toBe(`Reminder: Vacation on ${todayISO}`);
      expect(events[0].start_time).toContain(todayISO);
    });

    describe('Semantic Similarity & Deduplication Tests', () => {
      test('getKeywordSimilarity calculates exact, partial, and subset similarities correctly', () => {
        const { getKeywordSimilarity } = require('../utils/embeddings');
        expect(getKeywordSimilarity('I love eating fresh apples', 'I love eating fresh apples')).toBe(1.0);
        expect(getKeywordSimilarity('fresh apples', 'I love eating fresh apples')).toBe(0.5); // substring fallback
        expect(getKeywordSimilarity('blueberries', 'bananas')).toBe(0.0);
      });

      test('getSemanticSimilarity falls back to keyword similarity if vectors are missing', () => {
        const { getSemanticSimilarity } = require('../utils/embeddings');
        const score1 = getSemanticSimilarity('Hiking is fun', null, 'Hiking is fun', null);
        expect(score1).toBe(1.0);
        const score2 = getSemanticSimilarity('Hiking', null, 'Hiking is fun', null);
        expect(score2).toBe(0.5);
      });

      test('remember action prevents duplicate active memory semantically (using keyword overlap fallback)', async () => {
        await handleMemoryTool(mockTestDb, userId, 'remember', { content: 'My favorite color is green' });
        
        // Duplicate check
        const duplicateRes = await handleMemoryTool(mockTestDb, userId, 'remember', { content: 'My favorite color is green' });
        expect(duplicateRes).toContain('Already remembered');
        expect(duplicateRes).toContain('Updated existing memory');

        const rows = await mockTestDb.all('SELECT * FROM memories WHERE user_id = ?', [userId]);
        expect(rows.length).toBe(1);
      });

      test('remember and recall with active memory containing stringified embedding', async () => {
        // Insert a memory with an embedding
        await mockTestDb.run(
          'INSERT INTO memories (user_id, content, level, embedding) VALUES (?, ?, ?, ?)',
          [userId, 'I love playing chess', 'long-term', JSON.stringify([0.1, 0.2, 0.3])]
        );

        // This will query active memories, enter the parsing try-catch block, and trigger duplicate prevention
        const dupRes = await handleMemoryTool(mockTestDb, userId, 'remember', { content: 'I love playing chess' });
        expect(dupRes).toContain('Already remembered');

        // This will query active memories and parse the embedding during recall
        const recallRes = await handleMemoryTool(mockTestDb, userId, 'recall', { query: 'chess' });
        expect(recallRes).toContain('I love playing chess');
      });

      test('POST /api/memories prevents duplicate semantically when existing has embedding', async () => {
        await mockTestDb.run(
          'INSERT INTO memories (user_id, content, level, embedding) VALUES (?, ?, ?, ?)',
          [userId, 'I live in Austin', 'long-term', JSON.stringify([0.5, 0.6, 0.7])]
        );

        const res = await request(app)
          .post('/api/memories')
          .set('Authorization', `Bearer ${token}`)
          .send({ content: 'I live in Austin', level: 'long-term' });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.isDuplicate).toBe(true);
      });
    });
  });
});
