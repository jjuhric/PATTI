const { generateDailyBriefing, startBriefingScheduler, getUserLocalNow } = require('../utils/briefing');
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

describe('Daily Briefing Generation Tests', () => {
  let mockDb;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockDb = {
      get: jest.fn().mockImplementation(async (query) => {
        if (query.includes('FROM users')) {
          return { id: 1, username: 'testuser', name: 'Test User', zipcode: '90210', temp_unit: 'celsius', country: 'CA', timezone: 'America/Chicago' };
        }
        if (query.includes('FROM chats')) {
          return { id: 42, title: 'Daily Briefings' };
        }
        return null;
      }),
      all: jest.fn().mockImplementation(async (query) => {
        if (query.includes('calendar_events')) {
          return [{ title: 'Meeting', start_time: '2026-07-04 10:00', description: 'Discuss code' }];
        }
        if (query.includes('memories')) {
          return [{ content: 'Likes dark mode' }];
        }
        return [];
      }),
      run: jest.fn().mockResolvedValue({ lastID: 100 })
    };

    buildSettingsForUser.mockResolvedValue({ provider: 'local', modelName: 'test-model' });
  });

  afterEach(() => {
    // Each startBriefingScheduler() call registers a new setInterval that otherwise survives
    // into later tests (module-level `isRunning` state in briefing.js is also shared across
    // tests in this file) - without this, a leftover interval from an earlier test can fire
    // during a later test's timer advances and corrupt its assertions.
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('generateDailyBriefing calls handleWeatherTool with the real current signature (db, userId, action, params)', async () => {
    // Regression test for Bug A: briefing.js used to call handleWeatherTool('current', {zipcode,
    // ...}) - the OLD signature from before weather_tool.js was refactored to self-fetch the
    // profile by userId. That silently produced a garbled error string instead of throwing.
    handleWeatherTool.mockResolvedValueOnce('Sunny and 75 degrees');
    require('../tools/google_news_tool').handleGoogleNewsTool.mockResolvedValueOnce('Tech news: AI advances continue');
    generateText.mockResolvedValueOnce('# Daily Briefing markdown content here.');

    await generateDailyBriefing(mockDb, 1);

    expect(handleWeatherTool).toHaveBeenCalledWith(mockDb, 1, 'current', {});
  });

  test('generateDailyBriefing uses generateText\'s plain markdown return directly - no JSON parsing/unwrapping', async () => {
    // Regression test for Bugs B/C: the old code routed through runWorkerAgent and tried to
    // JSON.parse the result for a `data.briefing` key that nothing ever populated, falling
    // through to a forced one-sentence `summary` instead of the real digest. generateText
    // returns the digest directly as plain text.
    handleWeatherTool.mockResolvedValueOnce('Sunny and 75 degrees');
    require('../tools/google_news_tool').handleGoogleNewsTool.mockResolvedValueOnce('Tech news: AI advances continue');
    generateText.mockResolvedValueOnce('# Daily Briefing markdown content here.');

    const result = await generateDailyBriefing(mockDb, 1);

    expect(result).toBe('# Daily Briefing markdown content here.');
    expect(buildSettingsForUser).toHaveBeenCalledWith(mockDb, 1);
    expect(mockDb.get).toHaveBeenCalled();
    expect(mockDb.all).toHaveBeenCalled();
    expect(mockDb.run).toHaveBeenCalled();
  });

  test('generateDailyBriefing includes a resolved weather error string in the prompt rather than special-casing it', async () => {
    // weather_tool.js's real contract is to always resolve (even on failure, with a
    // human-readable error string), never reject - matching every other tool in this codebase.
    handleWeatherTool.mockResolvedValueOnce('Error: OpenWeatherMap API Key is not configured.');
    require('../tools/google_news_tool').handleGoogleNewsTool.mockRejectedValueOnce(new Error('News RSS parser failed'));
    generateText.mockResolvedValueOnce('Daily Briefing markdown content here.');

    const result = await generateDailyBriefing(mockDb, 1);
    expect(result).toContain('Daily Briefing markdown content');
    // The weather error string still made it into the prompt sent to generateText.
    const userPromptArg = generateText.mock.calls[0][2];
    expect(userPromptArg).toContain('OpenWeatherMap API Key is not configured');
  });

  test('generateDailyBriefing creates Daily Briefings chat if it does not exist', async () => {
    handleWeatherTool.mockResolvedValueOnce('Sunny');
    require('../tools/google_news_tool').handleGoogleNewsTool.mockResolvedValueOnce('News');
    generateText.mockResolvedValueOnce('Briefing content');

    mockDb.get.mockImplementation(async (query) => {
      if (query.includes('FROM users')) {
        return { id: 1, username: 'testuser', name: 'Test User', timezone: 'America/Chicago' };
      }
      if (query.includes('FROM chats')) {
        return null;
      }
      return null;
    });

    const result = await generateDailyBriefing(mockDb, 1);
    expect(result).toBe('Briefing content');
    expect(mockDb.run).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO chats'),
      expect.any(Array)
    );
  });

  test('generateDailyBriefing broadcasts an alert on success', async () => {
    handleWeatherTool.mockResolvedValueOnce('Sunny');
    require('../tools/google_news_tool').handleGoogleNewsTool.mockResolvedValueOnce('News');
    generateText.mockResolvedValueOnce('Briefing content');

    await generateDailyBriefing(mockDb, 1);

    expect(mockBroadcastAlert).toHaveBeenCalledTimes(1);
    expect(mockBroadcastAlert).toHaveBeenCalledWith(expect.objectContaining({
      type: 'info',
      message: expect.stringContaining('briefing'),
      notificationId: expect.anything()
    }), 1);

    // notifyUser (utils/notifications.js) persists the notification before broadcasting it,
    // so it survives even if no tab was open to catch the live broadcastAlert above.
    expect(mockDb.run).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO notifications'),
      expect.arrayContaining([1, 'info'])
    );
  });

  test('generateDailyBriefing handles overall failure throws', async () => {
    mockDb.get.mockRejectedValueOnce(new Error('Database lock error'));
    await expect(generateDailyBriefing(mockDb, 1)).rejects.toThrow('Database lock error');
  });

  describe('getUserLocalNow', () => {
    test('resolves the local hour, date, and weekday for a given IANA timezone at a fixed instant', () => {
      const at = new Date('2026-07-30T15:00:00Z');
      // America/Chicago is UTC-5 in July (CDT) -> 15:00 UTC = 10:00 local, still Thursday.
      expect(getUserLocalNow('America/Chicago', at)).toEqual({ hour: 10, dateStr: '2026-07-30', weekday: 'thu' });
      // Pacific/Kiritimati is a fixed UTC+14, no DST -> 15:00 UTC = 05:00 local, next day (Friday).
      expect(getUserLocalNow('Pacific/Kiritimati', at)).toEqual({ hour: 5, dateStr: '2026-07-31', weekday: 'fri' });
    });

    test('falls back to America/Chicago when no timezone is given', () => {
      const at = new Date('2026-07-30T15:00:00Z');
      expect(getUserLocalNow(null, at)).toEqual({ hour: 10, dateStr: '2026-07-30', weekday: 'thu' });
    });
  });

  describe('startBriefingScheduler', () => {
    test('only briefs the user whose local hour has reached their briefing_hour (Bug D regression)', async () => {
      jest.setSystemTime(new Date('2026-07-30T15:00:00Z'));

      // At this instant: America/Chicago local hour is 10am (>= briefing_hour 7 -> eligible).
      // Pacific/Kiritimati local hour is 5am (< briefing_hour 7 -> not yet eligible), even
      // though the OLD server-local-time-only check couldn't have told these apart correctly.
      const eligibleUser = { id: 1, username: 'eligible', timezone: 'America/Chicago', briefing_hour: 7, last_briefing_at: null };
      const notYetUser = { id: 2, username: 'not-yet', timezone: 'Pacific/Kiritimati', briefing_hour: 7, last_briefing_at: null };

      mockDb.all.mockImplementation(async (query) => {
        if (query.includes('FROM users')) return [eligibleUser, notYetUser];
        return [];
      });
      mockDb.get.mockImplementation(async (query, params) => {
        if (query.includes('FROM users')) {
          return params[0] === 1 ? eligibleUser : notYetUser;
        }
        if (query.includes('FROM chats')) return { id: 1, title: 'Daily Briefings' };
        return null;
      });
      handleWeatherTool.mockResolvedValue('Sunny');
      require('../tools/google_news_tool').handleGoogleNewsTool.mockResolvedValue('News');
      generateText.mockResolvedValue('Briefing content');

      startBriefingScheduler(mockDb);
      await jest.advanceTimersByTimeAsync(300000);

      // Only the eligible (America/Chicago) user should have actually been briefed - proven by
      // buildSettingsForUser (only called from inside generateDailyBriefing) having run exactly
      // once, for user id 1.
      expect(buildSettingsForUser).toHaveBeenCalledTimes(1);
      expect(buildSettingsForUser).toHaveBeenCalledWith(mockDb, 1);
    });

    test('does not run a second overlapping tick while the first is still in progress (isRunning guard)', async () => {
      let resolveFirstAll;
      const firstAllPromise = new Promise((resolve) => { resolveFirstAll = resolve; });
      let callCount = 0;
      mockDb.all.mockImplementation(async (query) => {
        if (query.includes('FROM users')) {
          callCount++;
          if (callCount === 1) {
            await firstAllPromise; // hangs until we manually resolve it below
          }
          return [];
        }
        return [];
      });

      startBriefingScheduler(mockDb);

      // First tick fires and blocks inside the (still-unresolved) db.all call. Awaiting this
      // resolves once the fake-timer-driven work is done, i.e. once the tick has started and
      // hit the real (non-fake-timer) pending promise - it does not wait for that promise itself.
      await jest.advanceTimersByTimeAsync(300000);
      expect(callCount).toBe(1);

      // A second tick's worth of fake time passes while the first is still "in progress"
      // (isRunning still true) - it should see the guard and return immediately without
      // calling db.all again.
      await jest.advanceTimersByTimeAsync(300000);
      expect(callCount).toBe(1); // still 1 - the second tick was skipped by the isRunning guard

      resolveFirstAll();
      await Promise.resolve();
      await Promise.resolve();
    });

    test('handles scheduler database check error without throwing', async () => {
      mockDb.all.mockRejectedValueOnce(new Error('Scheduler checking failed'));

      startBriefingScheduler(mockDb);
      await jest.advanceTimersByTimeAsync(300000);

      expect(mockDb.all).toHaveBeenCalled();
    });

    test('one user\'s briefing failing does not block briefings for other eligible users in the same tick', async () => {
      jest.setSystemTime(new Date('2026-07-30T15:00:00Z')); // America/Chicago local hour 10am

      const failingUser = { id: 1, username: 'failing', timezone: 'America/Chicago', briefing_hour: 7, last_briefing_at: null };
      const healthyUser = { id: 2, username: 'healthy', timezone: 'America/Chicago', briefing_hour: 7, last_briefing_at: null };

      mockDb.all.mockImplementation(async (query) => {
        if (query.includes('FROM users')) return [failingUser, healthyUser];
        return [];
      });
      mockDb.get.mockImplementation(async (query, params) => {
        if (query.includes('FROM users')) {
          return params[0] === 1 ? failingUser : healthyUser;
        }
        if (query.includes('FROM chats')) return { id: 1, title: 'Daily Briefings' };
        return null;
      });
      handleWeatherTool.mockResolvedValue('Sunny');
      require('../tools/google_news_tool').handleGoogleNewsTool.mockResolvedValue('News');

      // Matches the real symptom: the LLM call for the first (failing) user's briefing
      // throws every time (e.g. a broken/misconfigured local LLM endpoint), which used to
      // propagate straight out of the per-user loop and skip every remaining candidate.
      generateText.mockRejectedValueOnce(new Error('LLM error: unexpected response')).mockResolvedValueOnce('Briefing content');

      startBriefingScheduler(mockDb);
      await jest.advanceTimersByTimeAsync(300000);

      // Both users were attempted despite the first one's briefing throwing.
      expect(buildSettingsForUser).toHaveBeenCalledTimes(2);
      expect(buildSettingsForUser).toHaveBeenCalledWith(mockDb, 1);
      expect(buildSettingsForUser).toHaveBeenCalledWith(mockDb, 2);

      // The failing user's last_briefing_at update never happened; the healthy user's did.
      const briefingUpdateCalls = mockDb.run.mock.calls.filter(call => call[0].includes('UPDATE users SET last_briefing_at'));
      expect(briefingUpdateCalls.some(call => call[1][0] === 1)).toBe(false);
      expect(briefingUpdateCalls.some(call => call[1][0] === 2)).toBe(true);
    });
  });
});
