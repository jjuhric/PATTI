const { startRecurringTaskScheduler, runRecurringTask } = require('../utils/recurring_tasks_scheduler');
const { handleWeatherTool } = require('../tools/weather_tool');
const { generateText, buildSettingsForUser } = require('../utils/llm_text');

jest.mock('../tools/weather_tool', () => ({
  handleWeatherTool: jest.fn()
}));

jest.mock('../tools/google_news_tool', () => ({
  handleGoogleNewsTool: jest.fn()
}));

jest.mock('../utils/llm_text', () => ({
  generateText: jest.fn(),
  buildSettingsForUser: jest.fn()
}));

const mockBroadcastAlert = jest.fn();
jest.mock('../routes/alerts', () => ({
  broadcastAlert: (...args) => mockBroadcastAlert(...args)
}));

describe('utils/recurring_tasks_scheduler.js', () => {
  let mockDb;

  const baseTask = {
    id: 1,
    user_id: 1,
    label: 'Weekday Weather',
    prompt: 'give me the weather',
    news_query: null,
    days_of_week: 'mon,tue,wed,thu,fri',
    hour: 7,
    is_active: 1,
    last_run_at: null,
    timezone: 'America/Chicago',
    name: 'Test User',
    username: 'testuser',
    temp_unit: 'celsius'
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockDb = {
      get: jest.fn().mockImplementation(async (query) => {
        if (query.includes('FROM chats')) {
          return { id: 42, title: 'Recurring Tasks' };
        }
        return null;
      }),
      all: jest.fn().mockResolvedValue([]),
      run: jest.fn().mockResolvedValue({ lastID: 100 })
    };

    buildSettingsForUser.mockResolvedValue({ provider: 'local', modelName: 'test-model' });
    handleWeatherTool.mockResolvedValue('Sunny');
    generateText.mockResolvedValue('Here is your weather.');
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('runRecurringTask', () => {
    test('gathers weather/calendar/memories, skips news when news_query is unset, posts to Recurring Tasks chat, updates last_run_at, and notifies', async () => {
      await runRecurringTask(mockDb, baseTask);

      expect(handleWeatherTool).toHaveBeenCalledWith(mockDb, 1, 'current', {});
      expect(require('../tools/google_news_tool').handleGoogleNewsTool).not.toHaveBeenCalled();
      expect(generateText).toHaveBeenCalled();

      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO messages'),
        expect.arrayContaining([42, 'assistant', 'Here is your weather.'])
      );
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE recurring_tasks SET last_run_at'),
        [1]
      );
      expect(mockBroadcastAlert).toHaveBeenCalledWith(expect.objectContaining({ type: 'info' }));
    });

    test('fetches news when news_query is set on the task', async () => {
      require('../tools/google_news_tool').handleGoogleNewsTool.mockResolvedValueOnce('Cowboys beat the Eagles');
      const taskWithNews = { ...baseTask, news_query: 'Dallas Cowboys' };

      await runRecurringTask(mockDb, taskWithNews);

      expect(require('../tools/google_news_tool').handleGoogleNewsTool).toHaveBeenCalledWith('Dallas Cowboys');
    });

    test('creates the Recurring Tasks chat if it does not exist', async () => {
      mockDb.get.mockResolvedValueOnce(null); // no existing chat
      await runRecurringTask(mockDb, baseTask);

      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO chats'),
        expect.arrayContaining([1, 'Recurring Tasks'])
      );
    });
  });

  describe('startRecurringTaskScheduler', () => {
    test('only fires a task whose days_of_week includes today\'s local weekday AND whose local hour has been reached', async () => {
      jest.setSystemTime(new Date('2026-08-04T13:00:00Z')); // a Tuesday; 13:00 UTC = 08:00 America/Chicago (CDT)

      const dueTask = { ...baseTask, id: 1, user_id: 1, days_of_week: 'mon,tue,wed,thu,fri', hour: 7 };
      const wrongDayTask = { ...baseTask, id: 2, user_id: 2, days_of_week: 'mon,wed,fri', hour: 7 }; // not Tuesday
      const tooEarlyTask = { ...baseTask, id: 3, user_id: 3, days_of_week: 'mon,tue,wed,thu,fri', hour: 12 }; // hour not reached yet

      mockDb.all.mockImplementation(async (query) => {
        if (query.includes('FROM recurring_tasks')) return [dueTask, wrongDayTask, tooEarlyTask];
        return [];
      });

      startRecurringTaskScheduler(mockDb);
      await jest.advanceTimersByTimeAsync(300000);

      expect(buildSettingsForUser).toHaveBeenCalledTimes(1);
      expect(buildSettingsForUser).toHaveBeenCalledWith(mockDb, 1);
    });

    test('skips a task already run today in the user\'s own local date', async () => {
      jest.setSystemTime(new Date('2026-08-04T13:00:00Z'));
      const alreadyRanTask = { ...baseTask, last_run_at: '2026-08-04 12:00:00' }; // same UTC day, already ran

      mockDb.all.mockImplementation(async (query) => {
        if (query.includes('FROM recurring_tasks')) return [alreadyRanTask];
        return [];
      });

      startRecurringTaskScheduler(mockDb);
      await jest.advanceTimersByTimeAsync(300000);

      expect(buildSettingsForUser).not.toHaveBeenCalled();
    });

    test('candidate query is scoped to active tasks only', async () => {
      startRecurringTaskScheduler(mockDb);
      await jest.advanceTimersByTimeAsync(300000);

      expect(mockDb.all).toHaveBeenCalledWith(expect.stringContaining('is_active = 1'));
    });

    test('does not run a second overlapping tick while the first is still in progress (isRunning guard)', async () => {
      let resolveFirstAll;
      const firstAllPromise = new Promise((resolve) => { resolveFirstAll = resolve; });
      let callCount = 0;
      mockDb.all.mockImplementation(async (query) => {
        if (query.includes('FROM recurring_tasks')) {
          callCount++;
          if (callCount === 1) {
            await firstAllPromise;
          }
          return [];
        }
        return [];
      });

      startRecurringTaskScheduler(mockDb);

      await jest.advanceTimersByTimeAsync(300000);
      expect(callCount).toBe(1);

      await jest.advanceTimersByTimeAsync(300000);
      expect(callCount).toBe(1); // second tick skipped by isRunning guard

      resolveFirstAll();
      await Promise.resolve();
      await Promise.resolve();
    });

    test('on failure, does not update last_run_at, notifies with type error, and continues to other tasks', async () => {
      jest.setSystemTime(new Date('2026-08-04T13:00:00Z'));
      const failingTask = { ...baseTask, id: 1, user_id: 1 };
      const healthyTask = { ...baseTask, id: 2, user_id: 2 };

      mockDb.all.mockImplementation(async (query) => {
        if (query.includes('FROM recurring_tasks')) return [failingTask, healthyTask];
        return [];
      });
      generateText.mockRejectedValueOnce(new Error('LLM exploded')).mockResolvedValueOnce('Здоровый ответ');

      startRecurringTaskScheduler(mockDb);
      await jest.advanceTimersByTimeAsync(300000);

      // Both tasks were attempted despite the first one failing.
      expect(buildSettingsForUser).toHaveBeenCalledTimes(2);

      // last_run_at update never happened for the failing task's id.
      const lastRunUpdateCalls = mockDb.run.mock.calls.filter(call => call[0].includes('UPDATE recurring_tasks SET last_run_at'));
      expect(lastRunUpdateCalls.some(call => call[1][0] === 1)).toBe(false);
      expect(lastRunUpdateCalls.some(call => call[1][0] === 2)).toBe(true);

      expect(mockBroadcastAlert).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });

    test('a malformed days_of_week on one task does not abort processing of other candidates in the same tick (BUG-2 regression)', async () => {
      jest.setSystemTime(new Date('2026-08-04T13:00:00Z')); // Tuesday, 08:00 America/Chicago
      const malformedTask = { ...baseTask, id: 1, user_id: 1, days_of_week: null }; // .split() throws TypeError
      const healthyTask = { ...baseTask, id: 2, user_id: 2 };

      mockDb.all.mockImplementation(async (query) => {
        if (query.includes('FROM recurring_tasks')) return [malformedTask, healthyTask];
        return [];
      });

      startRecurringTaskScheduler(mockDb);
      await jest.advanceTimersByTimeAsync(300000);

      // The healthy task after the malformed one must still run - previously, the
      // eligibility check (including .split) sat outside the per-task try/catch, so
      // this TypeError propagated to the outer catch and abandoned every remaining
      // candidate in the tick, not just the malformed one.
      expect(buildSettingsForUser).toHaveBeenCalledTimes(1);
      expect(buildSettingsForUser).toHaveBeenCalledWith(mockDb, 2);
      expect(mockBroadcastAlert).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });

    test('handles scheduler database check error without throwing', async () => {
      mockDb.all.mockRejectedValueOnce(new Error('Scheduler checking failed'));

      startRecurringTaskScheduler(mockDb);
      await jest.advanceTimersByTimeAsync(300000);

      expect(mockDb.all).toHaveBeenCalled();
    });
  });
});
