const fs = require('fs');
const path = require('path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { handleRecurringTaskTool, normalizeDaysOfWeek, MAX_ACTIVE_TASKS_PER_USER } = require('../tools/recurring_task_tool');

describe('normalizeDaysOfWeek', () => {
  test('expands "daily"/"every day"/"everyday" shorthand to all 7 days', () => {
    expect(normalizeDaysOfWeek('daily')).toBe('mon,tue,wed,thu,fri,sat,sun');
    expect(normalizeDaysOfWeek('every day')).toBe('mon,tue,wed,thu,fri,sat,sun');
    expect(normalizeDaysOfWeek('everyday')).toBe('mon,tue,wed,thu,fri,sat,sun');
  });

  test('expands "weekday"/"weekdays" shorthand', () => {
    expect(normalizeDaysOfWeek('weekday')).toBe('mon,tue,wed,thu,fri');
    expect(normalizeDaysOfWeek('weekdays')).toBe('mon,tue,wed,thu,fri');
  });

  test('expands "weekend"/"weekends" shorthand', () => {
    expect(normalizeDaysOfWeek('weekend')).toBe('sat,sun');
    expect(normalizeDaysOfWeek('weekends')).toBe('sat,sun');
  });

  test('accepts a comma/space separated list of day names or abbreviations, mixed case/spacing', () => {
    expect(normalizeDaysOfWeek('Mon, Wed, Fri')).toBe('mon,wed,fri');
    expect(normalizeDaysOfWeek('monday wednesday friday')).toBe('mon,wed,fri');
    expect(normalizeDaysOfWeek('SUN')).toBe('sun');
  });

  test('de-dupes and sorts into canonical mon-sun order regardless of input order', () => {
    expect(normalizeDaysOfWeek('fri,mon,fri,wed')).toBe('mon,wed,fri');
  });

  test('returns null for an unrecognized token', () => {
    expect(normalizeDaysOfWeek('someday')).toBeNull();
    expect(normalizeDaysOfWeek('mon,someday')).toBeNull();
  });

  test('returns null for empty/missing input', () => {
    expect(normalizeDaysOfWeek('')).toBeNull();
    expect(normalizeDaysOfWeek(null)).toBeNull();
    expect(normalizeDaysOfWeek(undefined)).toBeNull();
  });
});

describe('handleRecurringTaskTool', () => {
  let db;
  let userId;
  let otherUserId;

  beforeAll(async () => {
    db = await open({ filename: ':memory:', driver: sqlite3.Database });
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await db.exec(schemaSql);
    const result = await db.run("INSERT INTO users (username, password_hash) VALUES ('recurringuser', 'hashed')");
    userId = result.lastID;
    const other = await db.run("INSERT INTO users (username, password_hash) VALUES ('otherrecurringuser', 'hashed')");
    otherUserId = other.lastID;
  });

  afterAll(async () => {
    await db.close();
  });

  describe('create', () => {
    test('creates a task with valid prompt/days_of_week/hour', async () => {
      const output = await handleRecurringTaskTool(db, userId, 'create', {
        prompt: 'give me weather and Cowboys news',
        days_of_week: 'weekday',
        hour: 7,
        news_query: 'Dallas Cowboys'
      });
      const parsed = JSON.parse(output);
      expect(parsed.success).toBe(true);
      expect(parsed.days_of_week).toBe('mon,tue,wed,thu,fri');
      expect(parsed.hour).toBe(7);

      const row = await db.get('SELECT * FROM recurring_tasks WHERE id = ?', [parsed.taskId]);
      expect(row.user_id).toBe(userId);
      expect(row.prompt).toBe('give me weather and Cowboys news');
      expect(row.news_query).toBe('Dallas Cowboys');
      expect(row.is_active).toBe(1);
    });

    test('rejects a missing prompt', async () => {
      const output = await handleRecurringTaskTool(db, userId, 'create', { days_of_week: 'daily', hour: 7 });
      expect(JSON.parse(output).error).toMatch(/prompt is required/);
    });

    test('rejects an unrecognized day pattern', async () => {
      const output = await handleRecurringTaskTool(db, userId, 'create', { prompt: 'x', days_of_week: 'someday', hour: 7 });
      expect(JSON.parse(output).error).toMatch(/Could not understand the day pattern/);
    });

    test('defaults hour to 7 when omitted', async () => {
      const output = await handleRecurringTaskTool(db, userId, 'create', { prompt: 'x', days_of_week: 'sun' });
      expect(JSON.parse(output).hour).toBe(7);
    });

    test('rejects an out-of-range or non-numeric hour', async () => {
      const tooHigh = await handleRecurringTaskTool(db, userId, 'create', { prompt: 'x', days_of_week: 'sun', hour: 24 });
      expect(JSON.parse(tooHigh).error).toMatch(/hour must be an integer 0-23/);

      const notANumber = await handleRecurringTaskTool(db, userId, 'create', { prompt: 'x', days_of_week: 'sun', hour: 'noonish' });
      expect(JSON.parse(notANumber).error).toMatch(/hour must be an integer 0-23/);
    });

    test('auto-generates a label from the prompt when omitted, truncating long prompts', async () => {
      const short = await handleRecurringTaskTool(db, userId, 'create', { prompt: 'tell me the weather', days_of_week: 'sun', hour: 8 });
      expect(JSON.parse(short).label).toBe('tell me the weather');

      const longPrompt = 'a'.repeat(60);
      const long = await handleRecurringTaskTool(db, userId, 'create', { prompt: longPrompt, days_of_week: 'sun', hour: 8 });
      const label = JSON.parse(long).label;
      expect(label.length).toBe(40);
      expect(label.endsWith('...')).toBe(true);
    });

    test('uses an explicit label when provided', async () => {
      const output = await handleRecurringTaskTool(db, userId, 'create', {
        prompt: 'tell me the weather', days_of_week: 'sun', hour: 8, label: 'Sunday Weather Check'
      });
      expect(JSON.parse(output).label).toBe('Sunday Weather Check');
    });

    test('enforces the per-user active-task cap', async () => {
      const capUser = await db.run("INSERT INTO users (username, password_hash) VALUES ('capuser', 'hashed')");
      for (let i = 0; i < MAX_ACTIVE_TASKS_PER_USER; i++) {
        const res = await handleRecurringTaskTool(db, capUser.lastID, 'create', { prompt: `task ${i}`, days_of_week: 'daily', hour: 7 });
        expect(JSON.parse(res).success).toBe(true);
      }
      const overCap = await handleRecurringTaskTool(db, capUser.lastID, 'create', { prompt: 'one too many', days_of_week: 'daily', hour: 7 });
      expect(JSON.parse(overCap).error).toMatch(/active recurring tasks/);
    });
  });

  describe('list', () => {
    test('returns only the requesting user\'s tasks', async () => {
      await handleRecurringTaskTool(db, otherUserId, 'create', { prompt: 'other user task', days_of_week: 'daily', hour: 9 });
      const output = await handleRecurringTaskTool(db, otherUserId, 'list', {});
      const tasks = JSON.parse(output);
      expect(tasks.length).toBe(1);
      expect(tasks[0].prompt).toBe('other user task');
    });
  });

  describe('pause / resume', () => {
    test('pause flips is_active to 0, resume flips it back to 1', async () => {
      const created = JSON.parse(await handleRecurringTaskTool(db, otherUserId, 'create', { prompt: 'pausable', days_of_week: 'sun', hour: 8 }));
      const pauseOut = await handleRecurringTaskTool(db, otherUserId, 'pause', { taskId: created.taskId });
      expect(JSON.parse(pauseOut).success).toBe(true);
      let row = await db.get('SELECT is_active FROM recurring_tasks WHERE id = ?', [created.taskId]);
      expect(row.is_active).toBe(0);

      const resumeOut = await handleRecurringTaskTool(db, otherUserId, 'resume', { taskId: created.taskId });
      expect(JSON.parse(resumeOut).success).toBe(true);
      row = await db.get('SELECT is_active FROM recurring_tasks WHERE id = ?', [created.taskId]);
      expect(row.is_active).toBe(1);
    });

    test('returns an error for a taskId belonging to another user', async () => {
      const created = JSON.parse(await handleRecurringTaskTool(db, userId, 'create', { prompt: 'mine', days_of_week: 'sun', hour: 8 }));
      const output = await handleRecurringTaskTool(db, otherUserId, 'pause', { taskId: created.taskId });
      expect(JSON.parse(output).error).toMatch(/No recurring task found/);
    });

    test('requires taskId', async () => {
      const output = await handleRecurringTaskTool(db, userId, 'pause', {});
      expect(JSON.parse(output).error).toMatch(/taskId is required/);
    });

    test('resume enforces the active-task cap - pause + create-more + resume cannot exceed the limit (BUG-3 regression)', async () => {
      const capUser = await db.run("INSERT INTO users (username, password_hash) VALUES ('resumecapuser', 'hashed')");
      const capUserId = capUser.lastID;

      const taskIds = [];
      for (let i = 0; i < MAX_ACTIVE_TASKS_PER_USER; i++) {
        const res = JSON.parse(await handleRecurringTaskTool(db, capUserId, 'create', { prompt: `task ${i}`, days_of_week: 'daily', hour: 7 }));
        expect(res.success).toBe(true);
        taskIds.push(res.taskId);
      }

      // Pause one to free a slot, then create a replacement - back at the cap, but
      // now with one inactive task sitting alongside MAX_ACTIVE_TASKS_PER_USER active ones.
      const pauseOut = JSON.parse(await handleRecurringTaskTool(db, capUserId, 'pause', { taskId: taskIds[0] }));
      expect(pauseOut.success).toBe(true);
      const extra = JSON.parse(await handleRecurringTaskTool(db, capUserId, 'create', { prompt: 'extra task', days_of_week: 'daily', hour: 7 }));
      expect(extra.success).toBe(true);

      // Resuming the paused task would push active count past the cap - must be rejected,
      // just like 'create' would be. Previously only 'create' checked the cap.
      const resumeOut = await handleRecurringTaskTool(db, capUserId, 'resume', { taskId: taskIds[0] });
      expect(JSON.parse(resumeOut).error).toMatch(/active recurring tasks/);

      const row = await db.get('SELECT is_active FROM recurring_tasks WHERE id = ?', [taskIds[0]]);
      expect(row.is_active).toBe(0);
    });
  });

  describe('delete', () => {
    test('deletes the row and is idempotent-safe (404-equivalent on second delete)', async () => {
      const created = JSON.parse(await handleRecurringTaskTool(db, userId, 'create', { prompt: 'deleteme', days_of_week: 'sun', hour: 8 }));
      const firstDelete = await handleRecurringTaskTool(db, userId, 'delete', { taskId: created.taskId });
      expect(JSON.parse(firstDelete).success).toBe(true);

      const row = await db.get('SELECT * FROM recurring_tasks WHERE id = ?', [created.taskId]);
      expect(row).toBeUndefined();

      const secondDelete = await handleRecurringTaskTool(db, userId, 'delete', { taskId: created.taskId });
      expect(JSON.parse(secondDelete).error).toMatch(/No recurring task found/);
    });
  });

  test('returns an error for an unknown action', async () => {
    const output = await handleRecurringTaskTool(db, userId, 'bogus_action', {});
    expect(JSON.parse(output).error).toMatch(/Unknown recurring_task action/);
  });
});
