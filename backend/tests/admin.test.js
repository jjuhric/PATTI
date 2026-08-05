const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');

let mockTestDb = null;
jest.mock('../db', () => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const fs = require('fs');
  const path = require('path');

  return {
    getDb: async () => {
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

const adminRouter = require('../routes/admin');
const { JWT_SECRET } = require('../middleware/auth');
const app = express();
app.use(express.json());
app.use('/api/admin', adminRouter);

describe('Admin API Router Tests', () => {
  let adminToken;
  let adminId;
  let regularToken;
  let regularId;

  beforeAll(async () => {
    const db = await mockTestDb || (await require('../db').getDb());

    const adminRes = await mockTestDb.run(
      "INSERT INTO users (username, password_hash, is_admin) VALUES ('admin_user', 'hashed', 1)"
    );
    adminId = adminRes.lastID;
    adminToken = jwt.sign({ id: adminId, username: 'admin_user' }, JWT_SECRET);

    const regularRes = await mockTestDb.run(
      "INSERT INTO users (username, password_hash, is_admin) VALUES ('regular_user', 'hashed', 0)"
    );
    regularId = regularRes.lastID;
    regularToken = jwt.sign({ id: regularId, username: 'regular_user' }, JWT_SECRET);
  });

  afterAll(async () => {
    if (mockTestDb) {
      await mockTestDb.close();
      mockTestDb = null;
    }
  });

  test('non-admin users are blocked with 403 on every admin route', async () => {
    const resUsers = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${regularToken}`);
    expect(resUsers.statusCode).toBe(403);

    const resStats = await request(app).get('/api/admin/db/stats').set('Authorization', `Bearer ${regularToken}`);
    expect(resStats.statusCode).toBe(403);
  });

  test('GET /api/admin/users lists users for an admin', async () => {
    const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    const usernames = res.body.map(u => u.username);
    expect(usernames).toContain('admin_user');
    expect(usernames).toContain('regular_user');
  });

  test('POST /api/admin/users creates a new account, admin-only, bypassing the invite-code gate', async () => {
    const resDenied = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${regularToken}`)
      .send({ username: 'onboarded', password: 'password123' });
    expect(resDenied.statusCode).toBe(403);

    const res = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'onboarded', password: 'password123' });
    expect(res.statusCode).toBe(200);
    expect(res.body.userId).toBeDefined();

    const db = await mockTestDb;
    const created = await db.get('SELECT is_admin FROM users WHERE username = ?', ['onboarded']);
    expect(created.is_admin).toBe(0);

    const dupRes = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'onboarded', password: 'password123' });
    expect(dupRes.statusCode).toBe(400);

    const shortPassRes = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'shortpass', password: 'ab' });
    expect(shortPassRes.statusCode).toBe(400);
  });

  test('PUT /api/admin/users/:id/quota updates quota, rejects invalid values', async () => {
    const res = await request(app)
      .put(`/api/admin/users/${regularId}/quota`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ token_quota: 50000 });
    expect(res.statusCode).toBe(200);

    const badRes = await request(app)
      .put(`/api/admin/users/${regularId}/quota`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ token_quota: -5 });
    expect(badRes.statusCode).toBe(400);
  });

  test('POST /api/admin/users/:id/reset-password resets the password', async () => {
    const res = await request(app)
      .post(`/api/admin/users/${regularId}/reset-password`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ newPassword: 'newpass123' });
    expect(res.statusCode).toBe(200);

    const db = await mockTestDb;
    const user = await db.get('SELECT password_hash FROM users WHERE id = ?', [regularId]);
    expect(user.password_hash).not.toBe('hashed');
  });

  test('POST /api/admin/users/:id/reset-password rejects a too-short password', async () => {
    const res = await request(app)
      .post(`/api/admin/users/${regularId}/reset-password`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ newPassword: 'ab' });
    expect(res.statusCode).toBe(400);
  });

  test('PUT /api/admin/users/:id/admin promotes a regular user to admin', async () => {
    const res = await request(app)
      .put(`/api/admin/users/${regularId}/admin`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ is_admin: true });
    expect(res.statusCode).toBe(200);

    const db = await mockTestDb;
    const user = await db.get('SELECT is_admin FROM users WHERE id = ?', [regularId]);
    expect(user.is_admin).toBe(1);

    // Demote back down for the remaining tests
    await db.run('UPDATE users SET is_admin = 0 WHERE id = ?', [regularId]);
  });

  test('PUT /api/admin/users/:id/admin refuses to let the last admin demote themselves', async () => {
    const res = await request(app)
      .put(`/api/admin/users/${adminId}/admin`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ is_admin: false });
    expect(res.statusCode).toBe(400);
  });

  test('DELETE /api/admin/users/:id refuses to delete your own account', async () => {
    const res = await request(app)
      .delete(`/api/admin/users/${adminId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(400);
  });

  test('DELETE /api/admin/users/:id deletes another user', async () => {
    const db = await mockTestDb;
    const tempRes = await db.run("INSERT INTO users (username, password_hash) VALUES ('to_delete', 'hashed')");
    const tempId = tempRes.lastID;

    const res = await request(app)
      .delete(`/api/admin/users/${tempId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);

    const gone = await db.get('SELECT id FROM users WHERE id = ?', [tempId]);
    expect(gone).toBeUndefined();
  });

  test('GET /api/admin/db/stats returns row counts', async () => {
    const res = await request(app).get('/api/admin/db/stats').set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(typeof res.body.users).toBe('number');
    expect(res.body.users).toBeGreaterThanOrEqual(2);
  });

  test('POST /api/admin/db/cleanup-duplicate-nodes removes duplicates and the gateway node', async () => {
    const db = await mockTestDb;
    await db.run("INSERT INTO network_nodes (user_id, node_name, device_type, ip_address, port) VALUES (?, 'Gateway', 'router', '192.168.1.1', 80)", [adminId]);
    await db.run("INSERT INTO network_nodes (user_id, node_name, device_type, ip_address, port) VALUES (?, 'Dup A', 'RPi', '192.168.1.50', 3000)", [adminId]);
    await db.run("INSERT INTO network_nodes (user_id, node_name, device_type, ip_address, port) VALUES (?, 'Dup B', 'RPi', '192.168.1.50', 3000)", [adminId]);

    const res = await request(app).post('/api/admin/db/cleanup-duplicate-nodes').set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.gatewayNodesDeleted).toBeGreaterThanOrEqual(1);
    expect(res.body.duplicateNodesDeleted).toBeGreaterThanOrEqual(1);

    const remaining = await db.all("SELECT * FROM network_nodes WHERE ip_address = '192.168.1.50'");
    expect(remaining.length).toBe(1);
  });

  test('GET /api/admin/db/backup streams a downloadable sqlite file', async () => {
    const res = await request(app).get('/api/admin/db/backup').set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
  });
});
