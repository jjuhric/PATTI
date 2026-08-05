// The SSRF guard (SEC-4) does a real DNS lookup, which these tests must not depend on -
// fixture domains here are fake and shouldn't resolve, and a real lookup would make tests
// slow/flaky/offline-unsafe. Trust ssrfGuard's own dedicated tests for its logic; here it's
// just a pass-through so fetch-mock call counts stay exactly as each test expects.
jest.mock('../utils/ssrfGuard', () => ({
  assertPublicHttpUrl: jest.fn(async (url) => new URL(url))
}));

const { handleWebSearchTool } = require('../tools/web_search_tool');
const cheerio = require('cheerio');

// Mock SQLite db
let mockTestDb = null;
jest.mock('../db', () => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');

  return {
    getDb: async () => {
      if (mockTestDb) return mockTestDb;
      mockTestDb = await open({
        filename: ':memory:',
        driver: sqlite3.Database
      });
      return mockTestDb;
    }
  };
});

global.fetch = jest.fn();

describe('Web Search Tool Tests', () => {
  let db;
  let userId = 1;

  beforeAll(async () => {
    const { open } = require('sqlite');
    const sqlite3 = require('sqlite3');

    db = await open({
      filename: ':memory:',
      driver: sqlite3.Database
    });
    mockTestDb = db;
    // Create users table and seed user
    await db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        password_hash TEXT,
        name TEXT,
        zipcode TEXT,
        country TEXT DEFAULT 'US',
        temp_unit TEXT DEFAULT 'imperial',
        weather_api_key TEXT
      )
    `);

    await db.run(`
      INSERT INTO users (username, password_hash, name, zipcode, country, temp_unit, weather_api_key)
      VALUES ('searchuser', 'hashed', 'Tester', '32421', 'US', 'imperial', 'test_key')
    `);
  });

  afterAll(async () => {
    if (db) {
      await db.close();
      mockTestDb = null;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('Direct URL Scraping - extracts clean body content', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => `
        <html>
          <head>
            <title>Cowboys Schedule</title>
          </head>
          <body>
            <h1>Dallas Cowboys Schedule 2026</h1>
            <p>Week 1 vs Giants</p>
          </body>
        </html>
      `
    });

    const result = await handleWebSearchTool(db, userId, 'https://www.dallascowboys.com/schedule/');
    expect(result).toContain('Direct Page Scrape: [Cowboys Schedule]');
    expect(result).toContain('Dallas Cowboys Schedule 2026');
  });

  test('Direct URL Scraping - fallback to search on fetch error', async () => {
    // 1st Fetch: Direct URL crawl fails
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 500
    });

    // 2nd Fetch: Falls back to DuckDuckGo search query
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => `
        <div class="result__body">
          <h2 class="result__title">
            <a class="result__a" href="https://example.com/resolved-link">Search Match</a>
          </h2>
          <div class="result__snippet">Resolved Snippet Text</div>
        </div>
      `
    });

    // 3rd Fetch: Scrape of search result
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => 'Scraped search match page.'
    });

    const result = await handleWebSearchTool(db, userId, 'https://fail.com');
    expect(result).toContain('Search Match');
    expect(result).toContain('Scraped search match page.');
  });

  test('Weather Interception - processes weather queries and formats table', async () => {
    // Mock weather fetch response
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        main: { temp: 75.2, feels_like: 76.5, humidity: 60 },
        weather: [{ description: 'partly cloudy' }],
        wind: { speed: 5.5 },
        name: 'Marianna'
      })
    });

    const result = await handleWebSearchTool(db, userId, 'what is the weather today?');
    expect(result).toContain('🌦️ Local Weather Report for **Marianna**');
    expect(result).toContain('75.2°F');
    expect(result).toContain('Partly cloudy');
  });

  test('DuckDuckGo Scraper - parses links and redirects successfully', async () => {
    // Mock 1: DDG Search returns HTML
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => `
        <div class="result__body">
          <h2 class="result__title">
            <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnyc.com%2Fnews">NYC News Hub</a>
          </h2>
          <div class="result__snippet">Snippet text for NYC.</div>
        </div>
      `
    });

    // Mock 2: Scrape details
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => 'Scraped NYC body content.'
    });

    const result = await handleWebSearchTool(db, userId, 'NYC news');
    expect(result).toContain('[NYC News Hub](https://nyc.com/news)');
    expect(result).toContain('Scraped NYC body content.');
  });

  test('Google Search Fallback - triggers when DuckDuckGo fails', async () => {
    // Mock 1: DDG fails (503)
    global.fetch.mockResolvedValueOnce({ ok: false, status: 503 });

    // Mock 2: Google Search returns HTML results
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => `
        <div class="g">
          <a href="https://example.com/item">
            <h3>Google Search Result Title</h3>
          </a>
          <div class="VwiC3b">Snippet for Google Search Result.</div>
        </div>
      `
    });

    // Mock 3: Crawler page scrape succeeds
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => 'Scraped Google result body.'
    });

    const result = await handleWebSearchTool(db, userId, 'Google query');
    expect(result).toContain('## 🔍 Deep Web Search Report for: *"Google query"*');
    expect(result).toContain('[Google Search Result Title](https://example.com/item)');
    expect(result).toContain('Scraped Google result body.');
  });

  test('Wikipedia Fallback - triggers when DDG and Google both fail', async () => {
    // Mock 1: DDG fails
    global.fetch.mockResolvedValueOnce({ ok: false, status: 503 });
    // Mock 2: Google fails
    global.fetch.mockResolvedValueOnce({ ok: false, status: 503 });
    // Mock 3: Wikipedia query succeeds
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        query: {
          search: [
            {
              title: 'Wikipedia Title',
              snippet: 'This is a wikipedia snippet.',
              pageid: 9999
            }
          ]
        }
      })
    });

    const result = await handleWebSearchTool(db, userId, 'wiki query');
    expect(result).toContain('Wikipedia Title');
    expect(result).toContain('This is a wikipedia snippet.');
  });

  test('handles deep crawling errors gracefully by falling back to search snippet', async () => {
    // Mock 1: DDG search results
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => `
        <div class="result__body">
          <h2 class="result__title">
            <a class="result__a" href="https://failedscrape.com">Scrape Fail Title</a>
          </h2>
          <div class="result__snippet">Snippet fallback text.</div>
        </div>
      `
    });

    // Mock 2: Scrape link page fails (throwing network error)
    global.fetch.mockRejectedValueOnce(new Error('Network Timeout'));

    const result = await handleWebSearchTool(db, userId, 'fail scrape query');
    expect(result).toContain('Falling back to search snippet.');
    expect(result).toContain('Snippet fallback text.');
  });

  test('error path - DuckDuckGo fetch fails, fallbacks trigger Google, then Wikipedia', async () => {
    // DDG fails
    global.fetch.mockRejectedValueOnce(new Error('DDG Timeout'));
    // Google succeeds but returns 0 results
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '<html><body>No results</body></html>'
    });
    // Wiki succeeds
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        query: { search: [{ title: 'Wiki Fallback', snippet: 'A snippet' }] }
      })
    });

    const result = await handleWebSearchTool(db, userId, 'ddg error query');
    expect(result).toContain('Wiki Fallback');
  });

  test('error path - Google fetch fails, fallback triggers Wikipedia', async () => {
    // DDG returns 0 results
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '<html></html>'
    });
    // Google fails
    global.fetch.mockRejectedValueOnce(new Error('Google block'));
    // Wiki succeeds
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        query: { search: [{ title: 'Wiki Google Fallback', snippet: 'Another snippet' }] }
      })
    });

    const result = await handleWebSearchTool(db, userId, 'google error query');
    expect(result).toContain('Wiki Google Fallback');
  });

  test('error path - Wikipedia fallback fails when all search engines return empty', async () => {
    // DDG returns 0 results
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '<html></html>'
    });
    // Google returns 0 results
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '<html></html>'
    });
    // Wiki fails
    global.fetch.mockRejectedValueOnce(new Error('Wiki Down'));

    const result = await handleWebSearchTool(db, userId, 'all failed query');
    expect(result).toContain('Web search failed completely');
  });

  test('Google search snippet fallback when parent classes are missing', async () => {
    // DDG returns 0 results
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '<html></html>'
    });
    // Google returns result with link but no snippet classes
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => `
        <div>
          <span>
            <a href="https://fallback.com"><h3>Title without classes</h3></a>
          </span>
        </div>
      `
    });

    const result = await handleWebSearchTool(db, userId, 'custom snippet query');
    expect(result).toContain('Title without classes');
  });

  test('weather redirection error handling', async () => {
    const brokenDb = {
      get: jest.fn().mockRejectedValueOnce(new Error('Weather Profile DB Fail'))
    };
    const result = await handleWebSearchTool(brokenDb, userId, 'weather in Miami');
    // Redirection should trigger weather tool and catch the db failure gracefully, falling through to search
    expect(result).toContain('Web search failed completely');
  });
});
