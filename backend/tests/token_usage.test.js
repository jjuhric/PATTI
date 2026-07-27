const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

let mockTestDb = null;
let mockDbError = false;

jest.mock('../db', () => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const fs = require('fs');
  const path = require('path');

  return {
    getDb: async () => {
      if (mockDbError) throw new Error('Database connection failed');
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

const tokenUsageRouter = require('../routes/token_usage');
const { JWT_SECRET } = require('../middleware/auth');
const app = express();
app.use(express.json());
app.use('/api/token-usage', tokenUsageRouter);

describe('Token Usage API Router Tests', () => {
  let token;
  let userId = 1;

  beforeAll(async () => {
    const { open } = require('sqlite');
    const sqlite3 = require('sqlite3');
    const fs = require('fs');
    const path = require('path');

    mockTestDb = await open({
      filename: ':memory:',
      driver: sqlite3.Database
    });
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await mockTestDb.exec(schemaSql);

    // Create a test user in DB to pass authentication check
    await mockTestDb.run(
      "INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)",
      [userId, 'tokenuser', 'hashed_pass']
    );

    token = jwt.sign({ id: userId, username: 'tokenuser' }, JWT_SECRET);
  });

  beforeEach(async () => {
    // Clear token_usage table
    await mockTestDb.run('DELETE FROM token_usage');
  });

  test('GET /api/token-usage returns 401 when no token is provided', async () => {
    const res = await request(app).get('/api/token-usage');
    expect(res.status).toBe(401);
  });

  test('GET /api/token-usage returns empty structures when no usage exists', async () => {
    const res = await request(app)
      .get('/api/token-usage')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.totalTokens).toBe(0);
    expect(res.body.tableData).toEqual([]);
    expect(res.body.graphData).toEqual([]);
  });

  test('GET /api/token-usage - last_request returns the most recent request token count', async () => {
    // Seed database
    await mockTestDb.run(
      "INSERT INTO token_usage (user_id, model_name, provider_type, token_count, created_at) VALUES (?, ?, ?, ?, datetime('now', '-2 hours'))",
      [userId, 'qwen3-8b', 'online', 500]
    );
    await mockTestDb.run(
      "INSERT INTO token_usage (user_id, model_name, provider_type, token_count, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
      [userId, 'qwen3-8b', 'local', 120]
    );

    const res = await request(app)
      .get('/api/token-usage?timeframe=last_request')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.totalTokens).toBe(120);
    expect(res.body.tableData.length).toBe(1);
    expect(res.body.tableData[0].model_name).toBe('qwen3-8b');
    expect(res.body.tableData[0].provider_type).toBe('local');
    expect(res.body.graphData.length).toBe(1);
  });

  test('GET /api/token-usage - last_request with empty database returns 0 totalTokens and empty lists', async () => {
    const res = await request(app)
      .get('/api/token-usage?timeframe=last_request')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.totalTokens).toBe(0);
    expect(res.body.tableData).toEqual([]);
    expect(res.body.graphData).toEqual([]);
  });

  test('GET /api/token-usage - filters correct timeframe records', async () => {
    // Seed database
    // Record 1: 5 hours ago
    await mockTestDb.run(
      "INSERT INTO token_usage (user_id, model_name, provider_type, token_count, created_at) VALUES (?, ?, ?, ?, datetime('now', '-5 hours'))",
      [userId, 'qwen3-8b', 'online', 1000]
    );
    // Record 2: 30 minutes ago
    await mockTestDb.run(
      "INSERT INTO token_usage (user_id, model_name, provider_type, token_count, created_at) VALUES (?, ?, ?, ?, datetime('now', '-30 minutes'))",
      [userId, 'qwen3-8b', 'local', 200]
    );
    // Record 3: 2 days ago
    await mockTestDb.run(
      "INSERT INTO token_usage (user_id, model_name, provider_type, token_count, created_at) VALUES (?, ?, ?, ?, datetime('now', '-2 days'))",
      [userId, 'qwen3-8b', 'online', 5000]
    );
    // Record 4: 10 hours ago (for 12h check)
    await mockTestDb.run(
      "INSERT INTO token_usage (user_id, model_name, provider_type, token_count, created_at) VALUES (?, ?, ?, ?, datetime('now', '-10 hours'))",
      [userId, 'qwen3-8b', 'local', 300]
    );
    // Record 5: 15 days ago (for 30d check)
    await mockTestDb.run(
      "INSERT INTO token_usage (user_id, model_name, provider_type, token_count, created_at) VALUES (?, ?, ?, ?, datetime('now', '-15 days'))",
      [userId, 'qwen3-8b', 'online', 4000]
    );
    // Record 6: 100 days ago (for 365d check)
    await mockTestDb.run(
      "INSERT INTO token_usage (user_id, model_name, provider_type, token_count, created_at) VALUES (?, ?, ?, ?, datetime('now', '-100 days'))",
      [userId, 'qwen3-8b', 'local', 600]
    );

    // Query 1h (should only contain the 30-min ago record, total = 200)
    const res1h = await request(app)
      .get('/api/token-usage?timeframe=1h')
      .set('Authorization', `Bearer ${token}`);
    expect(res1h.body.totalTokens).toBe(200);
    expect(res1h.body.tableData.length).toBe(1);

    // Query 12h (should contain 30-min ago, 5 hours ago, 10 hours ago, total = 1500)
    const res12h = await request(app)
      .get('/api/token-usage?timeframe=12h')
      .set('Authorization', `Bearer ${token}`);
    expect(res12h.body.totalTokens).toBe(1500);

    // Query 24h (should contain 30-min ago, 5 hours ago, 10 hours ago, total = 1500)
    const res24h = await request(app)
      .get('/api/token-usage?timeframe=24h')
      .set('Authorization', `Bearer ${token}`);
    expect(res24h.body.totalTokens).toBe(1500);

    // Query 7d (should contain up to 2 days ago, total = 6500)
    const res7d = await request(app)
      .get('/api/token-usage?timeframe=7d')
      .set('Authorization', `Bearer ${token}`);
    expect(res7d.body.totalTokens).toBe(6500);

    // Query 30d (should contain up to 15 days ago, total = 10500)
    const res30d = await request(app)
      .get('/api/token-usage?timeframe=30d')
      .set('Authorization', `Bearer ${token}`);
    expect(res30d.body.totalTokens).toBe(10500);

    // Query 365d (should contain up to 100 days ago, total = 11100)
    const res365d = await request(app)
      .get('/api/token-usage?timeframe=365d')
      .set('Authorization', `Bearer ${token}`);
    expect(res365d.body.totalTokens).toBe(11100);
  });

  test('GET /api/token-usage?since=<ISO> returns only tokens from that point on', async () => {
    // 2 hours ago - before the "since" cutoff, must be excluded.
    await mockTestDb.run(
      "INSERT INTO token_usage (user_id, model_name, provider_type, token_count, created_at) VALUES (?, ?, ?, ?, datetime('now', '-2 hours'))",
      [userId, 'qwen3-8b', 'online', 1000]
    );
    // Just now - after the cutoff, must be included.
    await mockTestDb.run(
      "INSERT INTO token_usage (user_id, model_name, provider_type, token_count, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
      [userId, 'qwen3-8b', 'local', 250]
    );

    const sinceIso = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 minutes ago
    const res = await request(app)
      .get(`/api/token-usage?since=${encodeURIComponent(sinceIso)}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.totalTokens).toBe(250);
    // The since path returns just the session total, not the table/graph breakdown.
    expect(res.body.tableData).toBeUndefined();
  });

  test('GET /api/token-usage?since=<ISO> returns 0 when no usage since that point', async () => {
    const sinceIso = new Date().toISOString();
    const res = await request(app)
      .get(`/api/token-usage?since=${encodeURIComponent(sinceIso)}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.totalTokens).toBe(0);
  });

  test('GET /api/token-usage?since=<invalid> returns 400', async () => {
    const res = await request(app)
      .get('/api/token-usage?since=not-a-date')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  test('GET /api/token-usage?since= requires auth like every other timeframe', async () => {
    const res = await request(app).get('/api/token-usage?since=2026-01-01T00:00:00.000Z');
    expect(res.status).toBe(401);
  });

  test('GET /api/token-usage handles DB error gracefully', async () => {
    mockDbError = true;
    const res = await request(app)
      .get('/api/token-usage')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Database connection failed');
    mockDbError = false;
  });
});
