// Focused test for the search-credit enforcement quick win: once the shared Tavily account has
// exhausted its credit allocation, both web_search_tool.js entry points must skip straight to
// the legacy fallback chain rather than spending (or attempting) a Tavily call. Kept separate
// from web_search_tool.test.js since that file exercises the real (unmocked) tavily_search
// module with TAVILY_API_KEY unset - this file needs isConfigured/isUsageExhausted mocked to
// exercise the "configured, but exhausted" branch specifically.

const mockIsConfigured = jest.fn();
const mockIsUsageExhausted = jest.fn();
const mockTavilySearch = jest.fn();

jest.mock('../utils/tavily_search', () => ({
  isConfigured: () => mockIsConfigured(),
  isUsageExhausted: () => mockIsUsageExhausted(),
  tavilySearch: (...args) => mockTavilySearch(...args)
}));

const { handleWebSearchTool, performWebSearch } = require('../tools/web_search_tool');

let mockTestDb = null;
jest.mock('../db', () => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  return {
    getDb: async () => {
      if (mockTestDb) return mockTestDb;
      mockTestDb = await open({ filename: ':memory:', driver: sqlite3.Database });
      return mockTestDb;
    }
  };
});

// A generic "nothing found" response, so every step of the legacy fallback chain
// (DuckDuckGo -> Google -> Wikipedia) completes without throwing.
global.fetch = jest.fn().mockResolvedValue({
  ok: true,
  text: async () => '<html></html>',
  json: async () => ({})
});

describe('Search credit gating (Tavily usage exhausted)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch.mockResolvedValue({ ok: true, text: async () => '<html></html>', json: async () => ({}) });
    mockIsConfigured.mockReturnValue(true);
  });

  test('handleWebSearchTool never calls tavilySearch once credits are exhausted', async () => {
    mockIsUsageExhausted.mockResolvedValue(true);

    await handleWebSearchTool(null, null, 'test query');

    expect(mockTavilySearch).not.toHaveBeenCalled();
  });

  test('performWebSearch never calls tavilySearch once credits are exhausted', async () => {
    mockIsUsageExhausted.mockResolvedValue(true);

    await performWebSearch('test query');

    expect(mockTavilySearch).not.toHaveBeenCalled();
  });

  test('handleWebSearchTool does call tavilySearch when credits are not exhausted', async () => {
    mockIsUsageExhausted.mockResolvedValue(false);
    mockTavilySearch.mockResolvedValue(null); // falls through to legacy chain either way

    await handleWebSearchTool(null, null, 'test query');

    expect(mockTavilySearch).toHaveBeenCalled();
  });

  test('performWebSearch does call tavilySearch when credits are not exhausted', async () => {
    mockIsUsageExhausted.mockResolvedValue(false);
    mockTavilySearch.mockResolvedValue(null);

    await performWebSearch('test query');

    expect(mockTavilySearch).toHaveBeenCalled();
  });

  test('neither entry point calls tavilySearch when Tavily is not configured, regardless of usage', async () => {
    mockIsConfigured.mockReturnValue(false);
    mockIsUsageExhausted.mockResolvedValue(false);

    await handleWebSearchTool(null, null, 'test query');
    await performWebSearch('test query');

    expect(mockTavilySearch).not.toHaveBeenCalled();
  });
});
