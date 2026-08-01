const {
  tavilySearch,
  getTavilyUsage,
  isConfigured,
  isUsageExhausted,
  _resetUsageCacheForTests,
  _expireUsageCacheForTests
} = require('../utils/tavily_search');

global.fetch = jest.fn();

const ORIGINAL_KEY = process.env.TAVILY_API_KEY;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.TAVILY_API_KEY = 'tvly-test-key';
  _resetUsageCacheForTests();
});

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = ORIGINAL_KEY;
});

const jsonResponse = (body, ok = true, status = 200) => ({
  ok,
  status,
  text: async () => JSON.stringify(body),
  json: async () => body
});

describe('isConfigured', () => {
  test('true when TAVILY_API_KEY is set', () => {
    expect(isConfigured()).toBe(true);
  });
  test('false when unset', () => {
    delete process.env.TAVILY_API_KEY;
    expect(isConfigured()).toBe(false);
  });
});

describe('tavilySearch', () => {
  test('authenticates with a Bearer header and posts to /search', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({
      answer: 'A summary.',
      results: [{ title: 'T', url: 'https://x.com', content: 'C', score: 0.9 }]
    }));

    await tavilySearch('some query');

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.tavily.com/search');
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Bearer tvly-test-key');
    const body = JSON.parse(options.body);
    expect(body.query).toBe('some query');
  });

  test('auto-detects topic=news from query wording', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ results: [{ title: 'T', url: 'u', content: 'c', score: 0.5 }] }));
    await tavilySearch('latest news on some topic');
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.topic).toBe('news');
  });

  test('defaults to topic=general when no news signal present', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ results: [{ title: 'T', url: 'u', content: 'c', score: 0.5 }] }));
    await tavilySearch('best pizza in austin');
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.topic).toBe('general');
  });

  test('an explicit topic option overrides auto-detection', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ results: [{ title: 'T', url: 'u', content: 'c', score: 0.5 }] }));
    await tavilySearch('some query', { topic: 'finance' });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.topic).toBe('finance');
  });

  test('defaults to search_depth basic to conserve credits', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ results: [{ title: 'T', url: 'u', content: 'c', score: 0.5 }] }));
    await tavilySearch('some query');
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.search_depth).toBe('basic');
  });

  test('retries once with advanced depth when basic returns no results', async () => {
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ title: 'T', url: 'u', content: 'c', score: 0.6 }] }));

    const result = await tavilySearch('hard query');

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).search_depth).toBe('advanced');
    expect(result.results).toHaveLength(1);
  });

  test('returns null when both basic and advanced come back empty', async () => {
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      .mockResolvedValueOnce(jsonResponse({ results: [] }));

    const result = await tavilySearch('nothing findable');
    expect(result).toBeNull();
  });

  test('normalizes results and preserves the score', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({
      answer: 'Synthesized answer',
      results: [{ title: 'Title', url: 'https://example.com', content: 'Snippet', score: 0.77 }]
    }));

    const result = await tavilySearch('q');
    expect(result).toEqual({
      answer: 'Synthesized answer',
      results: [{ title: 'Title', url: 'https://example.com', content: 'Snippet', score: 0.77 }]
    });
  });

  test('missing score defaults to 0 rather than throwing', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ results: [{ title: 'T', url: 'u', content: 'c' }] }));
    const result = await tavilySearch('q');
    expect(result.results[0].score).toBe(0);
  });

  test('throws when TAVILY_API_KEY is not configured', async () => {
    delete process.env.TAVILY_API_KEY;
    await expect(tavilySearch('q')).rejects.toThrow('TAVILY_API_KEY is not configured');
  });

  test('throws with the response body on a non-2xx response', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ error: 'bad request' }, false, 432));
    await expect(tavilySearch('q')).rejects.toThrow(/432/);
  });
});

describe('getTavilyUsage', () => {
  test('prefers account.plan_usage/plan_limit, matching the Tavily dashboard total', async () => {
    // Real shape observed live: key.limit came back null while account.plan_limit had the
    // actual 1000 - reading key.limit here would silently show "0 / 0" in the UI.
    global.fetch.mockResolvedValueOnce(jsonResponse({
      key: { usage: 0, limit: null },
      account: { plan_usage: 150, plan_limit: 1000 }
    }));
    const usage = await getTavilyUsage();
    expect(usage).toEqual({ used: 150, limit: 1000 });
    expect(global.fetch.mock.calls[0][0]).toBe('https://api.tavily.com/usage');
  });

  test('falls back to key.usage/limit when the account object is absent', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ key: { usage: 150, limit: 1000 } }));
    const usage = await getTavilyUsage();
    expect(usage).toEqual({ used: 150, limit: 1000 });
  });

  test('returns null when not configured, without calling fetch', async () => {
    delete process.env.TAVILY_API_KEY;
    const usage = await getTavilyUsage();
    expect(usage).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns null (not a throw) when the API call fails with no prior cached value', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({}, false, 401));
    const usage = await getTavilyUsage();
    expect(usage).toBeNull();
  });

  test('caches the result so repeated calls within the TTL do not re-hit the API', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ account: { plan_usage: 10, plan_limit: 1000 } }));
    const first = await getTavilyUsage();
    const second = await getTavilyUsage();
    expect(first).toEqual({ used: 10, limit: 1000 });
    expect(second).toEqual({ used: 10, limit: 1000 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('serves the last-known-good cached value when a later call fails (e.g. a 429)', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ account: { plan_usage: 20, plan_limit: 1000 } }));
    await getTavilyUsage();

    _expireUsageCacheForTests();
    global.fetch.mockResolvedValueOnce(jsonResponse({ detail: { error: 'rate limited' } }, false, 429));

    const usage = await getTavilyUsage();
    expect(usage).toEqual({ used: 20, limit: 1000 });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('isUsageExhausted', () => {
  test('false while used is below limit', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ account: { plan_usage: 500, plan_limit: 1000 } }));
    expect(await isUsageExhausted()).toBe(false);
  });

  test('true once used has reached the limit', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ account: { plan_usage: 1000, plan_limit: 1000 } }));
    expect(await isUsageExhausted()).toBe(true);
  });

  test('true once used has exceeded the limit', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ account: { plan_usage: 1005, plan_limit: 1000 } }));
    expect(await isUsageExhausted()).toBe(true);
  });

  test('false when not configured (getTavilyUsage returns null) - do not block search over an unknown state', async () => {
    delete process.env.TAVILY_API_KEY;
    expect(await isUsageExhausted()).toBe(false);
  });

  test('false when the limit is unknown (0/absent) - never silently degrade every query over an unreadable limit', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ account: { plan_usage: 0, plan_limit: 0 } }));
    expect(await isUsageExhausted()).toBe(false);
  });

  test('false when the usage fetch fails with no prior cached value', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({}, false, 500));
    expect(await isUsageExhausted()).toBe(false);
  });
});
