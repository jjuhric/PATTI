const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

function buildFixturePdfBuffer(text) {
  return new Promise((resolve) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.text(text);
    doc.end();
  });
}

// pdf-parse v2 uses pdfjs-dist internally, which relies on a dynamic import() Jest's CJS
// transform can't resolve without --experimental-vm-modules - confirmed working correctly
// under plain Node (see manual verification). This mock isolates the upload route's own
// logic from that unrelated Jest/library environment incompatibility.
jest.mock('pdf-parse', () => ({
  PDFParse: jest.fn().mockImplementation(() => ({
    getText: async () => ({ text: 'Hello from a real PDF fixture.' }),
    destroy: async () => {}
  }))
}));

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

const attachmentsRouter = require('../routes/attachments');
const { JWT_SECRET } = require('../middleware/auth');
const app = express();
app.use(express.json());
app.use('/api/attachments', attachmentsRouter);

describe('Attachments API Router Tests', () => {
  let token;
  let userId;
  let chatId;

  beforeAll(async () => {
    const db = await mockTestDb || (await require('../db').getDb());
    const userRes = await mockTestDb.run("INSERT INTO users (username, password_hash) VALUES ('attachuser', 'hashed')");
    userId = userRes.lastID;
    token = jwt.sign({ id: userId, username: 'attachuser' }, JWT_SECRET);

    const chatRes = await mockTestDb.run('INSERT INTO chats (user_id, title) VALUES (?, ?)', [userId, 'Test Chat']);
    chatId = chatRes.lastID;
  });

  afterAll(async () => {
    const attachDir = path.join(process.cwd(), 'chat_attachments', String(userId));
    if (fs.existsSync(attachDir)) {
      fs.rmSync(attachDir, { recursive: true, force: true });
    }
    if (mockTestDb) {
      await mockTestDb.close();
      mockTestDb = null;
    }
  });

  test('POST /api/attachments/upload - uploads and stores an image attachment', async () => {
    const pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    );

    const res = await request(app)
      .post('/api/attachments/upload')
      .set('Authorization', `Bearer ${token}`)
      .field('chatId', String(chatId))
      .attach('file', pngBuffer, { filename: 'pixel.png', contentType: 'image/png' });

    expect(res.statusCode).toBe(200);
    expect(res.body.kind).toBe('image');
    expect(res.body.filename).toBe('pixel.png');
    expect(res.body.id).toBeDefined();
  });

  test('POST /api/attachments/upload - extracts text from a real PDF document', async () => {
    const pdfBuffer = await buildFixturePdfBuffer('Hello from a real PDF fixture.');

    const res = await request(app)
      .post('/api/attachments/upload')
      .set('Authorization', `Bearer ${token}`)
      .field('chatId', String(chatId))
      .attach('file', pdfBuffer, { filename: 'report.pdf', contentType: 'application/pdf' });

    expect(res.statusCode).toBe(200);
    expect(res.body.kind).toBe('document');
    expect(res.body.extractedPreview).toContain('Hello from a real PDF fixture.');
  });

  test('POST /api/attachments/upload - extracts text from a plain text document', async () => {
    const res = await request(app)
      .post('/api/attachments/upload')
      .set('Authorization', `Bearer ${token}`)
      .field('chatId', String(chatId))
      .attach('file', Buffer.from('Hello from a test document.'), { filename: 'notes.txt', contentType: 'text/plain' });

    expect(res.statusCode).toBe(200);
    expect(res.body.kind).toBe('document');
    expect(res.body.extractedPreview).toContain('Hello from a test document.');
  });

  test('POST /api/attachments/upload - rejects unsupported file types', async () => {
    const res = await request(app)
      .post('/api/attachments/upload')
      .set('Authorization', `Bearer ${token}`)
      .field('chatId', String(chatId))
      .attach('file', Buffer.from('binary'), { filename: 'archive.zip', contentType: 'application/zip' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('Unsupported file type');
  });

  test('POST /api/attachments/upload - rejects video files even with a generic-looking name', async () => {
    const res = await request(app)
      .post('/api/attachments/upload')
      .set('Authorization', `Bearer ${token}`)
      .field('chatId', String(chatId))
      .attach('file', Buffer.from('not really a video'), { filename: 'clip.mp4', contentType: 'video/mp4' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('Unsupported file type');
  });

  test('POST /api/attachments/upload - accepts a .log file via generic mimetype fallback', async () => {
    const res = await request(app)
      .post('/api/attachments/upload')
      .set('Authorization', `Bearer ${token}`)
      .field('chatId', String(chatId))
      .attach('file', Buffer.from('2026-07-24 12:00:00 INFO server started\n'), { filename: 'server.log', contentType: 'application/octet-stream' });

    expect(res.statusCode).toBe(200);
    expect(res.body.kind).toBe('document');
    expect(res.body.extractedPreview).toContain('server started');
  });

  test('POST /api/attachments/upload - accepts a .csv file with no recognized mimetype', async () => {
    const res = await request(app)
      .post('/api/attachments/upload')
      .set('Authorization', `Bearer ${token}`)
      .field('chatId', String(chatId))
      .attach('file', Buffer.from('name,age\nAda,30\n'), { filename: 'data.csv', contentType: 'application/vnd.ms-excel' });

    expect(res.statusCode).toBe(200);
    expect(res.body.kind).toBe('document');
    expect(res.body.extractedPreview).toContain('name,age');
  });

  test('POST /api/attachments/upload - 404s for a chat the user does not own', async () => {
    const res = await request(app)
      .post('/api/attachments/upload')
      .set('Authorization', `Bearer ${token}`)
      .field('chatId', '999999')
      .attach('file', Buffer.from('data'), { filename: 'notes.txt', contentType: 'text/plain' });

    expect(res.statusCode).toBe(404);
  });

  test('GET /api/attachments/:id/file - serves the stored file', async () => {
    const uploadRes = await request(app)
      .post('/api/attachments/upload')
      .set('Authorization', `Bearer ${token}`)
      .field('chatId', String(chatId))
      .attach('file', Buffer.from('serve me'), { filename: 'serve.txt', contentType: 'text/plain' });

    const fileRes = await request(app)
      .get(`/api/attachments/${uploadRes.body.id}/file`)
      .set('Authorization', `Bearer ${token}`);

    expect(fileRes.statusCode).toBe(200);
    expect(fileRes.text).toBe('serve me');
  });

  test('DELETE /api/attachments/:id - removes a pending attachment', async () => {
    const uploadRes = await request(app)
      .post('/api/attachments/upload')
      .set('Authorization', `Bearer ${token}`)
      .field('chatId', String(chatId))
      .attach('file', Buffer.from('to delete'), { filename: 'delete_me.txt', contentType: 'text/plain' });

    const delRes = await request(app)
      .delete(`/api/attachments/${uploadRes.body.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(delRes.statusCode).toBe(200);
    expect(delRes.body.success).toBe(true);

    const fileRes = await request(app)
      .get(`/api/attachments/${uploadRes.body.id}/file`)
      .set('Authorization', `Bearer ${token}`);
    expect(fileRes.statusCode).toBe(404);
  });

  test('DELETE /api/attachments/:id - 404s for an already-sent (linked) attachment', async () => {
    const uploadRes = await request(app)
      .post('/api/attachments/upload')
      .set('Authorization', `Bearer ${token}`)
      .field('chatId', String(chatId))
      .attach('file', Buffer.from('linked'), { filename: 'linked.txt', contentType: 'text/plain' });

    const msgRes = await mockTestDb.run(
      "INSERT INTO messages (chat_id, role, content) VALUES (?, 'user', 'linked message')",
      [chatId]
    );
    await mockTestDb.run('UPDATE message_attachments SET message_id = ? WHERE id = ?', [msgRes.lastID, uploadRes.body.id]);

    const delRes = await request(app)
      .delete(`/api/attachments/${uploadRes.body.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(delRes.statusCode).toBe(404);
  });
});
