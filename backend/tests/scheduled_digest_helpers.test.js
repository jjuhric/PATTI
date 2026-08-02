const fs = require('fs');
const path = require('path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { getTodayEventsFormatted, getUserMemoriesFormatted } = require('../utils/scheduled_digest_helpers');

describe('utils/scheduled_digest_helpers.js', () => {
  let db;
  let userId;

  beforeAll(async () => {
    db = await open({ filename: ':memory:', driver: sqlite3.Database });
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await db.exec(schemaSql);
    const result = await db.run("INSERT INTO users (username, password_hash) VALUES ('digestuser', 'hashed')");
    userId = result.lastID;
  });

  afterAll(async () => {
    await db.close();
  });

  describe('getTodayEventsFormatted', () => {
    test('returns the empty-state string when there are no events for the given date', async () => {
      const text = await getTodayEventsFormatted(db, userId, '2026-08-02');
      expect(text).toBe('No events scheduled for today.');
    });

    test('returns a formatted bullet list of events matching the given local date', async () => {
      await db.run(
        'INSERT INTO calendar_events (user_id, title, description, start_time, end_time) VALUES (?, ?, ?, ?, ?)',
        [userId, 'Team Sync', 'Weekly check-in', '2026-08-03 10:00', '2026-08-03 10:30']
      );
      const text = await getTodayEventsFormatted(db, userId, '2026-08-03');
      expect(text).toBe('- [2026-08-03 10:00] Team Sync: Weekly check-in');
    });

    test('falls back to "No desc" when description is missing', async () => {
      await db.run(
        'INSERT INTO calendar_events (user_id, title, start_time, end_time) VALUES (?, ?, ?, ?)',
        [userId, 'Dentist', '2026-08-04 09:00', '2026-08-04 09:30']
      );
      const text = await getTodayEventsFormatted(db, userId, '2026-08-04');
      expect(text).toContain('Dentist: No desc');
    });
  });

  describe('getUserMemoriesFormatted', () => {
    test('returns the empty-state string when the user has no memories', async () => {
      const otherUser = await db.run("INSERT INTO users (username, password_hash) VALUES ('nomemories', 'hashed')");
      const text = await getUserMemoriesFormatted(db, otherUser.lastID);
      expect(text).toBe('No stored user memories found.');
    });

    test('returns a formatted bullet list of non-expired memories', async () => {
      await db.run(
        "INSERT INTO memories (user_id, content, level) VALUES (?, ?, 'long-term')",
        [userId, 'Likes dark mode']
      );
      const text = await getUserMemoriesFormatted(db, userId);
      expect(text).toBe('- Likes dark mode');
    });

    test('excludes expired memories', async () => {
      const freshUser = await db.run("INSERT INTO users (username, password_hash) VALUES ('expireduser', 'hashed')");
      await db.run(
        "INSERT INTO memories (user_id, content, level, expires_at) VALUES (?, ?, 'short-term', datetime('now', '-1 day'))",
        [freshUser.lastID, 'Old expired memory']
      );
      const text = await getUserMemoriesFormatted(db, freshUser.lastID);
      expect(text).toBe('No stored user memories found.');
    });
  });
});
