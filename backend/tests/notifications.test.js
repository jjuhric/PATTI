const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const mockBroadcastAlert = jest.fn();
jest.mock('../routes/alerts', () => ({ broadcastAlert: (...args) => mockBroadcastAlert(...args) }));

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
      mockTestDb = await open({ filename: ':memory:', driver: sqlite3.Database });
      const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
      await mockTestDb.exec(schemaSql);
      return mockTestDb;
    }
  };
});

const { notifyUser } = require('../utils/notifications');
const notificationsRouter = require('../routes/notifications');
const { JWT_SECRET } = require('../middleware/auth');

const app = express();
app.use(express.json());
app.use('/api/notifications', notificationsRouter);

describe('utils/notifications.js - notifyUser', () => {
  let db;
  let userId;

  beforeAll(async () => {
    const { open } = require('sqlite');
    const sqlite3 = require('sqlite3');
    const fs = require('fs');
    const path = require('path');

    db = await open({ filename: ':memory:', driver: sqlite3.Database });
    mockTestDb = db;
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await db.exec(schemaSql);

    const result = await db.run("INSERT INTO users (username, password_hash) VALUES ('notifyuser', 'hashed')");
    userId = result.lastID;
  });

  afterAll(async () => {
    if (mockTestDb) {
      await mockTestDb.close();
      mockTestDb = null;
    }
  });

  beforeEach(() => {
    mockBroadcastAlert.mockClear();
    mockDbError = false;
  });

  test('inserts a row, returns the notificationId, and broadcasts a live alert', async () => {
    const notificationId = await notifyUser(db, userId, { type: 'info', message: 'Your thing is ready.', chatId: 42 });

    expect(notificationId).toBeTruthy();
    const row = await db.get('SELECT * FROM notifications WHERE id = ?', [notificationId]);
    expect(row.user_id).toBe(userId);
    expect(row.type).toBe('info');
    expect(row.message).toBe('Your thing is ready.');
    expect(row.chat_id).toBe(42);
    expect(row.is_read).toBe(0);

    expect(mockBroadcastAlert).toHaveBeenCalledWith(expect.objectContaining({
      type: 'info',
      message: 'Your thing is ready.',
      chatId: 42,
      notificationId
    }));
  });

  test('stores NULL chat_id when chatId is omitted', async () => {
    const notificationId = await notifyUser(db, userId, { type: 'error', message: 'It failed.' });
    const row = await db.get('SELECT * FROM notifications WHERE id = ?', [notificationId]);
    expect(row.chat_id).toBeNull();
  });

  test('throws when no message is given', async () => {
    await expect(notifyUser(db, userId, { type: 'info' })).rejects.toThrow('message');
  });
});

describe('GET/POST /api/notifications', () => {
  let db;
  let userA, tokenA;
  let userB, tokenB;

  beforeAll(async () => {
    const { open } = require('sqlite');
    const sqlite3 = require('sqlite3');
    const fs = require('fs');
    const path = require('path');

    db = await open({ filename: ':memory:', driver: sqlite3.Database });
    mockTestDb = db;
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await db.exec(schemaSql);

    const resultA = await db.run("INSERT INTO users (username, password_hash) VALUES ('notifroutea', 'hashed')");
    userA = resultA.lastID;
    tokenA = jwt.sign({ id: userA, username: 'notifroutea' }, JWT_SECRET);

    const resultB = await db.run("INSERT INTO users (username, password_hash) VALUES ('notifrouteb', 'hashed')");
    userB = resultB.lastID;
    tokenB = jwt.sign({ id: userB, username: 'notifrouteb' }, JWT_SECRET);
  });

  afterAll(async () => {
    if (mockTestDb) {
      await mockTestDb.close();
      mockTestDb = null;
    }
  });

  beforeEach(() => {
    mockDbError = false;
  });

  test('GET / returns an empty list and zero unread count initially', async () => {
    const res = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tokenA}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.notifications).toEqual([]);
    expect(res.body.unreadCount).toBe(0);
  });

  test('GET / returns notifications newest-first with an accurate unread count, scoped to the current user', async () => {
    await notifyUser(db, userA, { type: 'info', message: 'First for A' });
    await notifyUser(db, userA, { type: 'info', message: 'Second for A' });
    await notifyUser(db, userB, { type: 'info', message: 'Only for B' });

    const resA = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tokenA}`);
    expect(resA.statusCode).toBe(200);
    expect(resA.body.notifications).toHaveLength(2);
    expect(resA.body.notifications[0].message).toBe('Second for A');
    expect(resA.body.notifications[1].message).toBe('First for A');
    expect(resA.body.unreadCount).toBe(2);

    const resB = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tokenB}`);
    expect(resB.body.notifications).toHaveLength(1);
    expect(resB.body.notifications[0].message).toBe('Only for B');
  });

  test('POST /:id/read marks only the owning user\'s notification read', async () => {
    const resBefore = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tokenA}`);
    const targetId = resBefore.body.notifications[0].id;

    const readRes = await request(app).post(`/api/notifications/${targetId}/read`).set('Authorization', `Bearer ${tokenA}`);
    expect(readRes.statusCode).toBe(200);
    expect(readRes.body.success).toBe(true);

    const resAfter = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tokenA}`);
    expect(resAfter.body.unreadCount).toBe(1);
  });

  test('POST /:id/read returns 404 for another user\'s notification id', async () => {
    const resB = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tokenB}`);
    const otherUsersId = resB.body.notifications[0].id;

    const res = await request(app).post(`/api/notifications/${otherUsersId}/read`).set('Authorization', `Bearer ${tokenA}`);
    expect(res.statusCode).toBe(404);
  });

  test('POST /read-all zeroes all of one user\'s unread rows and leaves the other user\'s untouched', async () => {
    const readAllRes = await request(app).post('/api/notifications/read-all').set('Authorization', `Bearer ${tokenA}`);
    expect(readAllRes.statusCode).toBe(200);

    const resA = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tokenA}`);
    expect(resA.body.unreadCount).toBe(0);

    const resB = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tokenB}`);
    expect(resB.body.unreadCount).toBe(1);
  });

  test('database errors return 500', async () => {
    mockDbError = true;

    const getRes = await request(app).get('/api/notifications').set('Authorization', `Bearer ${tokenA}`);
    expect(getRes.statusCode).toBe(500);

    const readRes = await request(app).post('/api/notifications/1/read').set('Authorization', `Bearer ${tokenA}`);
    expect(readRes.statusCode).toBe(500);

    const readAllRes = await request(app).post('/api/notifications/read-all').set('Authorization', `Bearer ${tokenA}`);
    expect(readAllRes.statusCode).toBe(500);
  });
});
