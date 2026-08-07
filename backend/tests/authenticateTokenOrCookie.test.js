const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

// SEC-5 (docs/REVIEW_2026-08-03.md): authenticateTokenOrCookie is the fallback used only on
// the small safelist of GET-based streaming/media routes that can't attach a custom
// Authorization header (EventSource, WebSocket upgrade, <img src>, window.open downloads).
// This verifies the header-only vs. header-or-cookie split holds: a bare cookie must never be
// enough to reach a route still guarded by the plain authenticateToken.
let mockTestDb = null;
jest.mock('../db', () => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const fs = require('fs');
  const path = require('path');

  return {
    getDb: async () => {
      if (mockTestDb) return mockTestDb;
      mockTestDb = await open({ filename: ':memory:', driver: sqlite3.Database });
      const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
      await mockTestDb.exec(schemaSql);
      return mockTestDb;
    }
  };
});

const { authenticateToken, authenticateTokenOrCookie, JWT_SECRET, AUTH_COOKIE_NAME } = require('../middleware/auth');

const app = express();
app.use(cookieParser());
app.get('/header-only', authenticateToken, (req, res) => res.json({ ok: true }));
app.get('/header-or-cookie', authenticateTokenOrCookie, (req, res) => res.json({ ok: true }));

describe('authenticateTokenOrCookie (SEC-5)', () => {
  let userId;
  let token;

  beforeAll(async () => {
    const db = await mockTestDb || (mockTestDb = await require('../db').getDb());
    const result = await db.run(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      ['cookie-mw-user', 'hash']
    );
    userId = result.lastID;
    token = jwt.sign({ id: userId, username: 'cookie-mw-user' }, JWT_SECRET);
  });

  afterAll(async () => {
    if (mockTestDb) {
      await mockTestDb.close();
      mockTestDb = null;
    }
  });

  test('a cookie alone is rejected on a route still guarded by authenticateToken', async () => {
    const res = await request(app)
      .get('/header-only')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${token}`]);
    expect(res.statusCode).toBe(401);
  });

  test('a cookie alone is accepted on a route using authenticateTokenOrCookie', async () => {
    const res = await request(app)
      .get('/header-or-cookie')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${token}`]);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('the Authorization header still works on authenticateTokenOrCookie routes', async () => {
    const res = await request(app)
      .get('/header-or-cookie')
      .set('Authorization', `Bearer ${token}`);
    expect(res.statusCode).toBe(200);
  });

  test('no header and no cookie is rejected on both route types', async () => {
    const headerOnlyRes = await request(app).get('/header-only');
    expect(headerOnlyRes.statusCode).toBe(401);

    const cookieRes = await request(app).get('/header-or-cookie');
    expect(cookieRes.statusCode).toBe(401);
  });

  test('an invalid cookie value is rejected on authenticateTokenOrCookie routes', async () => {
    const res = await request(app)
      .get('/header-or-cookie')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=not-a-real-token`]);
    expect(res.statusCode).toBe(403);
  });
});
