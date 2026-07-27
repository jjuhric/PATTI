jest.mock('../utils/llm_text', () => ({
  generateText: jest.fn()
}));

const { generateText } = require('../utils/llm_text');
const {
  fetchPageText,
  extractRelevant,
  readPageForRequest,
  selectMainContent
} = require('../utils/web_extract');
const cheerio = require('cheerio');

global.fetch = jest.fn();

const htmlResponse = (html) => ({
  ok: true,
  headers: { get: () => 'text/html; charset=utf-8' },
  text: async () => html
});

const settings = { provider: 'local', modelName: 'test-model' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('selectMainContent', () => {
  test('prefers a semantic <article> over surrounding chrome', () => {
    const $ = cheerio.load(`
      <body>
        <div class="sidebar">Subscribe now for unlimited access to everything we publish today</div>
        <article>${'The actual story body that we care about reading. '.repeat(10)}</article>
      </body>
    `);
    expect(selectMainContent($).text()).toContain('actual story body');
  });

  test('falls back to the densest block when no semantic container exists', () => {
    const $ = cheerio.load(`
      <body>
        <div>Menu</div>
        <div>${'Dense body content that dominates the page by length. '.repeat(10)}</div>
      </body>
    `);
    expect(selectMainContent($).text()).toContain('Dense body content');
  });
});

describe('fetchPageText', () => {
  test('returns cleaned text and title on success', async () => {
    global.fetch.mockResolvedValueOnce(htmlResponse(`
      <html><head><title>  Page Title  </title></head>
      <body>
        <nav>Home About Contact</nav>
        <script>var tracking = 1;</script>
        <article>${'Real readable article content here. '.repeat(10)}</article>
        <footer>Copyright notice</footer>
      </body></html>
    `));

    const result = await fetchPageText('https://example.com/story');
    expect(result.ok).toBe(true);
    expect(result.title).toBe('Page Title');
    expect(result.text).toContain('Real readable article content');
    // Chrome and scripts must not leak into the text handed to the model.
    expect(result.text).not.toContain('tracking');
    expect(result.text).not.toContain('Home About Contact');
    expect(result.text).not.toContain('Copyright notice');
  });

  test('reports a failure instead of treating an error page as content', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 403, headers: { get: () => 'text/html' } });
    const result = await fetchPageText('https://example.com/blocked');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('403');
  });

  test('rejects non-HTML content types', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'application/pdf' },
      text: async () => '%PDF-1.4'
    });
    const result = await fetchPageText('https://example.com/file.pdf');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('application/pdf');
  });

  test('surfaces a network error rather than throwing', async () => {
    global.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await fetchPageText('https://example.com/down');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });
});

describe('extractRelevant', () => {
  test('returns the model\'s extracted notes', async () => {
    generateText.mockResolvedValueOnce('  Title: Dune Part Three\nRelease: 2026-12-18  ');
    const result = await extractRelevant(settings, 'some page text', 'when is Dune 3 out');
    expect(result).toBe('Title: Dune Part Three\nRelease: 2026-12-18');
  });

  test('returns null when the page has nothing relevant', async () => {
    generateText.mockResolvedValueOnce('NO_RELEVANT_CONTENT');
    const result = await extractRelevant(settings, 'unrelated page text', 'when is Dune 3 out');
    expect(result).toBeNull();
  });

  test('returns null for empty page text without calling the model', async () => {
    const result = await extractRelevant(settings, '   ', 'anything');
    expect(result).toBeNull();
    expect(generateText).not.toHaveBeenCalled();
  });

  test('bounds how much page text is sent to the model', async () => {
    generateText.mockResolvedValueOnce('notes');
    await extractRelevant(settings, 'x'.repeat(50000), 'request', { maxChars: 100 });
    expect(generateText.mock.calls[0][2]).toHaveLength(100);
  });
});

describe('readPageForRequest', () => {
  test('returns extracted content for a relevant page', async () => {
    global.fetch.mockResolvedValueOnce(htmlResponse('<body><article>' + 'Streaming release details. '.repeat(10) + '</article></body>'));
    generateText.mockResolvedValueOnce('Now streaming on Netflix');

    const result = await readPageForRequest(settings, 'https://example.com/a', 'where can I stream it');
    expect(result).toEqual(expect.objectContaining({
      url: 'https://example.com/a',
      content: 'Now streaming on Netflix',
      extracted: true
    }));
  });

  test('returns null when the page cannot be fetched', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 500, headers: { get: () => 'text/html' } });
    const result = await readPageForRequest(settings, 'https://example.com/b', 'anything');
    expect(result).toBeNull();
  });

  test('returns null when the page is fetched but holds nothing relevant', async () => {
    global.fetch.mockResolvedValueOnce(htmlResponse('<body><article>' + 'Unrelated text. '.repeat(20) + '</article></body>'));
    generateText.mockResolvedValueOnce('NO_RELEVANT_CONTENT');

    const result = await readPageForRequest(settings, 'https://example.com/c', 'streaming release');
    expect(result).toBeNull();
  });

  test('degrades to raw page text when the extraction call fails', async () => {
    global.fetch.mockResolvedValueOnce(htmlResponse('<body><article>' + 'Fallback body text. '.repeat(20) + '</article></body>'));
    generateText.mockRejectedValueOnce(new Error('LLM offline'));

    const result = await readPageForRequest(settings, 'https://example.com/d', 'anything');
    expect(result.extracted).toBe(false);
    expect(result.content).toContain('Fallback body text');
  });
});
