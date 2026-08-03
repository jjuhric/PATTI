const { handleGoogleNewsTool } = require('../tools/google_news_tool');
const { GoogleDecoder } = require('google-news-url-decoder');

// Mock decoder dependency
jest.mock('google-news-url-decoder', () => {
  return {
    GoogleDecoder: jest.fn().mockImplementation(() => ({
      decode: jest.fn().mockImplementation(async (link) => {
        if (link.includes('fail-decode')) {
          throw new Error('Decode error');
        }
        return { status: true, decoded_url: 'https://decoded-news.com/article' };
      })
    }))
  };
});

global.fetch = jest.fn();

describe('Google News Tool Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('scrapes RSS headlines and processes article content', async () => {
    // Mock 1: RSS feed response
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => `
        <rss><channel>
          <item>
            <title>Breaking tech update</title>
            <link>https://news.google.com/rss/articles/123</link>
          </item>
        </channel></rss>
      `
    });

    // Mock 2: Article page fetch response
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => `
        <html>
          <body>
            <p>Major news update: tech development continues at rapid pace.</p>
          </body>
        </html>
      `
    });

    const result = await handleGoogleNewsTool('tech');
    const parsed = JSON.parse(result);

    expect(parsed).toHaveProperty('source', 'Google News (Search: "tech")');
    expect(parsed.articles.length).toBe(1);
    expect(parsed.articles[0].headline).toBe('Breaking tech update');
    expect(parsed.articles[0].link).toBe('https://decoded-news.com/article');
    expect(parsed.articles[0].content).toContain('Major news update');
  });

  test('returns error on RSS fetch failure', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false });

    const result = await handleGoogleNewsTool();
    const parsed = JSON.parse(result);

    expect(parsed).toHaveProperty('error');
  });

  test('does not hang forever when the RSS feed fetch never resolves (regression - was a bare fetch() with no timeout)', async () => {
    jest.useFakeTimers();
    // A promise that never settles on its own, simulating an unresponsive RSS feed -
    // before the fix, google_news_tool.js's fallback fetch(rssUrl) call had no
    // AbortController/timeout at all, unlike news_tool.js's sibling implementation
    // (already fixed for this exact documented hang). Without the fix, this test
    // would never resolve and would time out the whole test run instead of the
    // internal 8s guard firing.
    global.fetch.mockImplementationOnce((url, options) => new Promise((resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));

    const resultPromise = handleGoogleNewsTool('hanging query');
    await jest.advanceTimersByTimeAsync(8000);
    const result = await resultPromise;
    const parsed = JSON.parse(result);

    expect(parsed).toHaveProperty('error');
    jest.useRealTimers();
  });

  test('handles decode URL failure and handles scrape content timeout', async () => {
    // Mock 1: RSS feed response with a link that will trigger decode error
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => `
        <rss><channel>
          <item>
            <title>Decode Fail Article</title>
            <link>https://news.google.com/rss/articles/fail-decode</link>
          </item>
        </channel></rss>
      `
    });

    // Mock 2: Article page fetch throws error (Network Timeout)
    global.fetch.mockRejectedValueOnce(new Error('Network Timeout'));

    const result = await handleGoogleNewsTool('fail test');
    const parsed = JSON.parse(result);

    expect(parsed.articles.length).toBe(1);
    expect(parsed.articles[0].headline).toBe('Decode Fail Article');
    expect(parsed.articles[0].content).toBe('Failed to scrape full text from destination server.');
  });

  test('limits scraping to top 10 articles when feed returns more than 10 items', async () => {
    // Generate 12 article items in XML
    let items = '';
    for (let i = 1; i <= 12; i++) {
      items += `
        <item>
          <title>Article ${i}</title>
          <link>https://news.google.com/rss/articles/${i}</link>
        </item>
      `;
    }

    // Mock 1: RSS feed response
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => `<rss><channel>${items}</channel></rss>`
    });

    // Mock article fetch response for 10 articles (index 0 to 9)
    for (let i = 0; i < 10; i++) {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        text: async () => '<html><body>News content</body></html>'
      });
    }

    const result = await handleGoogleNewsTool();
    const parsed = JSON.parse(result);

    expect(parsed.articles.length).toBe(12);
    // Top 10 are scraped
    expect(parsed.articles[0].content).toContain('News content');
    // Article 11 and 12 are NOT scraped to save bandwidth
    expect(parsed.articles[10].content).toBe('Headline and link only (content not scraped to save bandwidth/time).');
    expect(parsed.articles[11].content).toBe('Headline and link only (content not scraped to save bandwidth/time).');
  });
});
