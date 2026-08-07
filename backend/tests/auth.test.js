const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

// Mock db.js to use an in-memory database
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

const authRouter = require('../routes/auth');
const { JWT_SECRET, AUTH_COOKIE_NAME } = require('../middleware/auth');
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/auth', authRouter);

describe('Auth Router Tests', () => {
  beforeEach(async () => {
    mockDbError = false;
    // Reset DB for each test by truncating users and settings
    if (mockTestDb) {
      await mockTestDb.run('DELETE FROM users');
      await mockTestDb.run('DELETE FROM user_settings');
    }
  });

  afterAll(async () => {
    if (mockTestDb) {
      await mockTestDb.close();
      mockTestDb = null;
    }
  });

  test('POST /api/auth/register - success', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'testuser', password: 'password123' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('userId');

    // Confirm DB row is created
    const db = await mockTestDb;
    const user = await db.get('SELECT * FROM users WHERE username = ?', ['testuser']);
    expect(user).toBeDefined();
    expect(user.username).toBe('testuser');

    // Confirm default settings are created
    const settings = await db.get('SELECT * FROM user_settings WHERE user_id = ?', [user.id]);
    expect(settings).toBeDefined();
    expect(settings.provider).toBe('local');
  });

  test('POST /api/auth/register - the first account on a fresh instance becomes admin with no invite code', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'owner', password: 'password123' });

    expect(res.statusCode).toBe(200);
    expect(res.body.isAdmin).toBe(true);

    const db = await mockTestDb;
    const user = await db.get('SELECT is_admin FROM users WHERE username = ?', ['owner']);
    expect(user.is_admin).toBe(1);
  });

  test('POST /api/auth/register - a second account is blocked without a matching invite code', async () => {
    delete process.env.REGISTRATION_INVITE_CODE;

    await request(app).post('/api/auth/register').send({ username: 'owner', password: 'password123' });

    const noCodeRes = await request(app)
      .post('/api/auth/register')
      .send({ username: 'second', password: 'password123' });
    expect(noCodeRes.statusCode).toBe(403);

    process.env.REGISTRATION_INVITE_CODE = 'secret-invite';
    const wrongCodeRes = await request(app)
      .post('/api/auth/register')
      .send({ username: 'second', password: 'password123', inviteCode: 'nope' });
    expect(wrongCodeRes.statusCode).toBe(403);

    const rightCodeRes = await request(app)
      .post('/api/auth/register')
      .send({ username: 'second', password: 'password123', inviteCode: 'secret-invite' });
    expect(rightCodeRes.statusCode).toBe(200);
    expect(rightCodeRes.body.isAdmin).toBe(false);

    delete process.env.REGISTRATION_INVITE_CODE;
  });

  test('POST /api/auth/register - validation errors', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: '', password: '123' });

    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('POST /api/auth/register - username taken', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'taken', password: 'password123' });

    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'taken', password: 'password123' });

    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('error', 'Username is already taken.');
  });

  test('POST /api/auth/login - success', async () => {
    // Register first
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'loginuser', password: 'password123' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'loginuser', password: 'password123' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body).toHaveProperty('user');
    expect(res.body.user.username).toBe('loginuser');
  });

  test('POST /api/auth/login - invalid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nonexistent', password: 'password123' });

    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('error', 'Invalid username or password.');
  });

  test('POST /api/auth/login - missing username or password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'loginuser' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('required');
  });

  test('POST /api/auth/login - incorrect password', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'passuser', password: 'correctpassword' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'passuser', password: 'wrongpassword' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Invalid username or password.');
  });

  test('GET /api/auth/me - authenticated', async () => {
    // Register and login
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'meuser', password: 'password123' });

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'meuser', password: 'password123' });

    const token = loginRes.body.token;

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('user');
    expect(res.body.user.username).toBe('meuser');
  });

  test('GET /api/auth/me - unauthenticated (missing token)', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.statusCode).toBe(401);
  });

  test('GET /api/auth/me - authenticated with invalid/expired token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer invalid_token_here');
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Session expired or invalid.');
  });

  test('POST /api/auth/logout-everywhere revokes the token used to call it (SEC-5)', async () => {
    await request(app).post('/api/auth/register').send({ username: 'revokeuser', password: 'password123' });
    const loginRes = await request(app).post('/api/auth/login').send({ username: 'revokeuser', password: 'password123' });
    const token = loginRes.body.token;

    const meBefore = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(meBefore.statusCode).toBe(200);

    const logoutRes = await request(app).post('/api/auth/logout-everywhere').set('Authorization', `Bearer ${token}`);
    expect(logoutRes.statusCode).toBe(200);
    expect(logoutRes.body.success).toBe(true);

    const meAfter = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(meAfter.statusCode).toBe(401);
    expect(meAfter.body.error).toBe('Session revoked. Please log in again.');
  });

  test('POST /api/auth/logout-everywhere requires authentication', async () => {
    const res = await request(app).post('/api/auth/logout-everywhere');
    expect(res.statusCode).toBe(401);
  });

  test('a token issued before tokens_valid_after is rejected; one issued after is accepted (SEC-5)', async () => {
    const regRes = await request(app).post('/api/auth/register').send({ username: 'cutoffuser', password: 'password123' });
    const userId = regRes.body.userId;

    const db = await mockTestDb;
    // Move the cutoff 10 minutes into the future relative to "now" so both tokens below
    // (with real current-second iat) are unambiguously on one side of it or the other.
    const futureCutoff = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await db.run('UPDATE users SET tokens_valid_after = ? WHERE id = ?', [futureCutoff, userId]);

    const staleToken = jwt.sign({ id: userId, username: 'cutoffuser' }, JWT_SECRET);
    const staleRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${staleToken}`);
    expect(staleRes.statusCode).toBe(401);
    expect(staleRes.body.error).toBe('Session revoked. Please log in again.');

    const freshIat = Math.floor((Date.now() + 20 * 60 * 1000) / 1000); // 20 min from now - past the cutoff
    const freshToken = jwt.sign({ id: userId, username: 'cutoffuser', iat: freshIat }, JWT_SECRET);
    const freshRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${freshToken}`);
    expect(freshRes.statusCode).toBe(200);
  });

  test('POST /api/auth/login sets an httpOnly auth cookie (SEC-5)', async () => {
    await request(app).post('/api/auth/register').send({ username: 'cookieuser', password: 'password123' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'cookieuser', password: 'password123' });

    expect(res.statusCode).toBe(200);
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const authCookie = setCookie.find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
    expect(authCookie).toBeDefined();
    expect(authCookie).toContain('HttpOnly');
    expect(authCookie).toContain(`${AUTH_COOKIE_NAME}=${res.body.token}`);
  });

  test('POST /api/auth/logout clears the auth cookie without requiring authentication (SEC-5)', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    const setCookie = res.headers['set-cookie'];
    const authCookie = setCookie.find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
    expect(authCookie).toBeDefined();
    expect(authCookie).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  test('POST /api/auth/logout-everywhere also clears the auth cookie (SEC-5)', async () => {
    await request(app).post('/api/auth/register').send({ username: 'cookierevoke', password: 'password123' });
    const loginRes = await request(app).post('/api/auth/login').send({ username: 'cookierevoke', password: 'password123' });

    const res = await request(app)
      .post('/api/auth/logout-everywhere')
      .set('Authorization', `Bearer ${loginRes.body.token}`);

    expect(res.statusCode).toBe(200);
    const setCookie = res.headers['set-cookie'];
    const authCookie = setCookie.find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
    expect(authCookie).toBeDefined();
    expect(authCookie).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  test('error paths - database failure catches', async () => {
    mockDbError = true;

    // Register route db error
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({ username: 'dbfail', password: 'password123' });
    expect(regRes.statusCode).toBe(500);

    // Login route db error
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'dbfail', password: 'password123' });
    expect(loginRes.statusCode).toBe(500);
  });
});
