const { handleNewsTool } = require('../tools/news_tool');

jest.mock('google-news-url-decoder', () => ({
  GoogleDecoder: jest.fn().mockImplementation(() => ({
    decode: jest.fn().mockResolvedValue({ status: true, decoded_url: 'https://decoded-news.com/article' })
  }))
}));

global.fetch = jest.fn();

function mockDb(interests = []) {
  return {
    get: jest.fn().mockResolvedValue({ interests: JSON.stringify(interests) })
  };
}

const rssResponse = `
  <rss><channel>
    <item>
      <title>Breaking news headline</title>
      <link>https://news.google.com/rss/articles/123</link>
      <pubDate>Thu, 30 Jul 2026 12:00:00 GMT</pubDate>
    </item>
  </channel></rss>
`;

describe('News Tool - fetch timeouts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns real TMZ + search results on a normal, quick response', async () => {
    global.fetch.mockResolvedValue({ ok: true, text: async () => rssResponse });

    const result = await handleNewsTool(mockDb([]), 1, 'get_general_news', {});
    const parsed = JSON.parse(result);

    expect(parsed.tmz_news.length).toBe(1);
    expect(parsed.tmz_news[0].title).toBe('Breaking news headline');
    expect(parsed.preference_news[0].articles[0].link).toBe('https://decoded-news.com/article');
  });

  test('a hung TMZ RSS fetch is aborted after the timeout instead of hanging indefinitely', async () => {
    jest.useFakeTimers();

    // Simulate a request that never resolves on its own, but does reject once its
    // AbortSignal fires - exactly how a real hung fetch() behaves once aborted.
    global.fetch.mockImplementation((url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));

    const resultPromise = handleNewsTool(mockDb([]), 1, 'get_general_news', {});

    // Advance past both the TMZ fetch timeout and the subsequent Google News RSS
    // fetch timeout (they run sequentially) without waiting real wall-clock time.
    await jest.advanceTimersByTimeAsync(20000);

    const result = await resultPromise;
    const parsed = JSON.parse(result);

    // Both hung fetches were bounded and swallowed internally - the tool still
    // resolves (with empty results) rather than the whole delegation hanging for
    // minutes and eventually surfacing an unrelated "fetch failed" upstream.
    expect(parsed.tmz_news).toEqual([]);
    expect(parsed.preference_news[0].articles).toEqual([]);
  });

  test('a hung Google News URL decode is abandoned after its own timeout, falling back to the original link', async () => {
    jest.useFakeTimers();

    global.fetch.mockResolvedValue({ ok: true, text: async () => rssResponse });

    const { GoogleDecoder } = require('google-news-url-decoder');
    GoogleDecoder.mockImplementation(() => ({
      decode: jest.fn().mockImplementation(() => new Promise(() => {})) // never resolves
    }));

    const resultPromise = handleNewsTool(mockDb([]), 1, 'get_general_news', {});
    await jest.advanceTimersByTimeAsync(20000);
    const result = await resultPromise;
    const parsed = JSON.parse(result);

    // Falls back to the original (undecoded) Google News redirect link rather than
    // hanging forever waiting on the third-party decoder.
    expect(parsed.preference_news[0].articles[0].link).toBe('https://news.google.com/rss/articles/123');
  });
});
