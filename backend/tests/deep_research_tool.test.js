jest.mock('../utils/embeddings', () => {
  const actual = jest.requireActual('../utils/embeddings');
  return {
    ...actual,
    searchResearchedKnowledge: jest.fn(),
    storeResearchedKnowledge: jest.fn().mockResolvedValue(),
    deleteResearchedKnowledge: jest.fn().mockResolvedValue()
  };
});

jest.mock('../tools/web_search_tool', () => ({
  performWebSearch: jest.fn()
}));

// The SSRF guard (SEC-4) does a real DNS lookup, which these tests must not depend on - see
// the identical mock/rationale in tests/web_search_tool.test.js.
jest.mock('../utils/ssrfGuard', () => ({
  assertPublicHttpUrl: jest.fn(async (url) => new URL(url))
}));

const {
  searchResearchedKnowledge,
  storeResearchedKnowledge,
  deleteResearchedKnowledge
} = require('../utils/embeddings');
const { performWebSearch } = require('../tools/web_search_tool');
const { handleDeepResearchTool, crawlTopic } = require('../tools/deep_research_tool');

global.fetch = jest.fn();

describe('Deep Research Tool Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('research: missing topic returns an error', async () => {
    const output = await handleDeepResearchTool(null, 1, 'research', {});
    expect(output).toMatch(/^Error: "topic"/);
  });

  test('research: unknown action returns an error', async () => {
    const output = await handleDeepResearchTool(null, 1, 'do_something_else', { topic: 'x' });
    expect(output).toMatch(/Unknown Deep Research action/);
  });

  test('research: high-confidence cache hit returns existing knowledge without crawling', async () => {
    searchResearchedKnowledge.mockResolvedValueOnce([
      {
        text: 'Prior distilled summary about widgets.',
        metadata: {
          topic: 'widgets',
          source_urls: ['https://example.com/widgets'],
          created_at: new Date().toISOString(),
          hit_count: 2,
          last_hit_at: new Date().toISOString()
        },
        score: 0.9
      }
    ]);

    const output = await handleDeepResearchTool(null, 1, 'research', { topic: 'widgets' });

    expect(output).toContain('Existing knowledge found');
    expect(output).toContain('Prior distilled summary about widgets.');
    expect(output).toContain('https://example.com/widgets');
    expect(performWebSearch).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    // Hit bump: delete-then-re-add
    expect(deleteResearchedKnowledge).toHaveBeenCalledWith('Prior distilled summary about widgets.');
    expect(storeResearchedKnowledge).toHaveBeenCalled();
  });

  test('research: stale cache hit (past freshness window) triggers a fresh crawl instead', async () => {
    const staleDate = new Date();
    staleDate.setDate(staleDate.getDate() - 30); // 30 days old, beyond the 14-day freshness window

    searchResearchedKnowledge.mockResolvedValueOnce([
      {
        text: 'Old stale summary.',
        metadata: { topic: 'widgets', source_urls: [], created_at: staleDate.toISOString() },
        score: 0.95
      }
    ]);
    performWebSearch.mockResolvedValueOnce({ engine: 'ddg', results: [] });

    const output = await handleDeepResearchTool(null, 1, 'research', { topic: 'widgets' });

    expect(performWebSearch).toHaveBeenCalled();
    expect(output).toMatch(/Error: Deep research crawl/);
  });

  test('research: "latest" keyword always skips the cache and forces a fresh crawl', async () => {
    performWebSearch.mockResolvedValueOnce({ engine: 'ddg', results: [] });

    const output = await handleDeepResearchTool(null, 1, 'research', { topic: 'latest AI news' });

    expect(searchResearchedKnowledge).not.toHaveBeenCalled();
    expect(performWebSearch).toHaveBeenCalledWith('latest AI news', 5);
    expect(output).toMatch(/Error: Deep research crawl/);
  });

  test('research: cache miss performs a fresh crawl and returns raw material for synthesis', async () => {
    searchResearchedKnowledge.mockResolvedValueOnce([]);
    performWebSearch.mockResolvedValueOnce({
      engine: 'ddg',
      results: [{ link: 'https://example.com/a', title: 'Source A', snippet: 'snip' }]
    });
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '<html><body><p>Deep content about the topic.</p></body></html>'
    });

    const output = await handleDeepResearchTool(null, 1, 'research', { topic: 'quantum widgets' });

    expect(output).toContain('Deep Research: "quantum widgets"');
    expect(output).toContain('Source A');
    expect(output).toContain('Deep content about the topic.');
    expect(output).toContain('save_knowledge');
  });

  test('save_knowledge: missing params returns errors', async () => {
    let output = await handleDeepResearchTool(null, 1, 'save_knowledge', { content: 'x' });
    expect(output).toMatch(/^Error: "topic"/);

    output = await handleDeepResearchTool(null, 1, 'save_knowledge', { topic: 'x' });
    expect(output).toMatch(/^Error: "content"/);
  });

  test('save_knowledge: persists distilled content via storeResearchedKnowledge', async () => {
    const output = await handleDeepResearchTool(null, 42, 'save_knowledge', {
      topic: 'quantum widgets',
      content: 'A concise synthesized summary.',
      source_urls: ['https://example.com/a', 'https://example.com/b']
    });

    expect(output).toContain('saved to');
    expect(storeResearchedKnowledge).toHaveBeenCalledTimes(1);
    const [text, metadata] = storeResearchedKnowledge.mock.calls[0];
    expect(text).toBe('A concise synthesized summary.');
    expect(metadata.topic).toBe('quantum widgets');
    expect(metadata.source_urls).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(metadata.created_by_user_id).toBe(42);
    expect(metadata.hit_count).toBe(0);
  });

  describe('crawlTopic', () => {
    test('respects the MAX_PAGES cap and follows relevant hop-2 links', async () => {
      performWebSearch.mockResolvedValueOnce({
        engine: 'ddg',
        results: [
          { link: 'https://example.com/seed1', title: 'Widget Guide', snippet: '' },
          { link: 'https://example.com/seed2', title: 'Widget Facts', snippet: '' }
        ]
      });

      // seed1 page: has a relevant in-page link to hop-2 content
      global.fetch.mockResolvedValueOnce({
        ok: true,
        text: async () => `
          <html><body>
            <p>Widget content page one.</p>
            <a href="https://example.com/widget-deep-dive">Widget deep dive details</a>
            <a href="https://unrelated.com/cats">Cats are great pets</a>
          </body></html>
        `
      });
      // seed2 page
      global.fetch.mockResolvedValueOnce({
        ok: true,
        text: async () => '<html><body><p>Widget content page two.</p></body></html>'
      });
      // hop-2 page (widget-deep-dive, relevant to "widget")
      global.fetch.mockResolvedValueOnce({
        ok: true,
        text: async () => '<html><body><p>Deep widget details here.</p></body></html>'
      });

      const pages = await crawlTopic('widget');

      expect(pages.length).toBeLessThanOrEqual(8);
      const urls = pages.map(p => p.url);
      expect(urls).toContain('https://example.com/seed1');
      expect(urls).toContain('https://example.com/seed2');
      // The relevant hop-2 link should have been followed; the unrelated "cats" link should not.
      expect(urls).not.toContain('https://unrelated.com/cats');
    });

    test('gracefully skips pages that fail to fetch', async () => {
      performWebSearch.mockResolvedValueOnce({
        engine: 'ddg',
        results: [{ link: 'https://example.com/broken', title: 'Broken', snippet: '' }]
      });
      global.fetch.mockRejectedValueOnce(new Error('Network error'));

      const pages = await crawlTopic('broken topic');
      expect(pages).toEqual([]);
    });
  });
});
