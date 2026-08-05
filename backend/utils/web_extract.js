const cheerio = require('cheerio');
const { generateText } = require('./llm_text');
const { assertPublicHttpUrl } = require('./ssrfGuard');

// Cleaned page text handed to the LLM. ~12k characters is roughly 3k tokens, which leaves
// plenty of room inside the 32768-token local context for the system prompt and the answer.
const DEFAULT_MAX_CHARS = 12000;

// Pages that fail to load shouldn't hang a chat turn behind a dead host.
const FETCH_TIMEOUT_MS = 10000;

// Browser-ish headers - a bare fetch User-Agent gets refused or served a stub by many sites.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

// Chrome/layout elements that never contain the substance of a page. Removing them before
// measuring text density stops a big nav or cookie banner from looking like the main content.
const NON_CONTENT_SELECTORS = 'script, style, head, noscript, iframe, svg, img, nav, footer, header, form, aside, [role="navigation"], [role="banner"], [aria-hidden="true"]';

/**
 * Picks the element most likely to hold the page's actual article/body text.
 *
 * Blind truncation ("first 3000 characters") usually captures a nav bar and a cookie notice
 * instead of the content, which is what made the old scraping path unreliable. Semantic
 * containers win when present; otherwise fall back to whichever block element carries the most
 * text, which approximates what a reader-mode extractor does without adding a dependency.
 */
function selectMainContent($) {
  for (const selector of ['article', 'main', '[role="main"]', '#content', '.content']) {
    const node = $(selector).first();
    if (node.length && node.text().trim().length > 200) {
      return node;
    }
  }

  let best = null;
  let bestLength = 0;
  $('body div, body section').each((_, el) => {
    const node = $(el);
    // Only weigh text this element holds directly-ish; a wrapper <div> around everything would
    // otherwise always win and defeat the point of choosing a region.
    const length = node.clone().children('div, section').remove().end().text().trim().length;
    if (length > bestLength) {
      bestLength = length;
      best = node;
    }
  });

  return bestLength > 200 ? best : $('body');
}

/**
 * Fetches a URL and reduces it to readable plain text plus its title.
 * Returns null when the page can't be fetched or isn't HTML, so callers can fall back
 * rather than treating an error page as content.
 */
async function fetchPageText(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  try {
    await assertPublicHttpUrl(url);
  } catch (err) {
    return { url, ok: false, error: err.message };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, signal: controller.signal });
    if (!res.ok) {
      return { url, ok: false, error: `HTTP ${res.status}` };
    }

    const contentType = res.headers?.get?.('content-type') || '';
    if (contentType && !/html|text|xml/i.test(contentType)) {
      return { url, ok: false, error: `Unsupported content-type: ${contentType}` };
    }

    const html = await res.text();
    const $ = cheerio.load(html);
    const title = $('title').first().text().trim();
    $(NON_CONTENT_SELECTORS).remove();

    const text = selectMainContent($).text().replace(/\s+/g, ' ').trim();
    return { url, ok: true, title, text };
  } catch (err) {
    const reason = err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err.message;
    return { url, ok: false, error: reason };
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildExtractionPrompt(request) {
  return `You are a web content extractor. You will be given the text of a web page and a user's request.

Your job is to pull out ONLY the information on that page that is relevant to the request, and present it as clean, factual notes.

Rules:
- Report ONLY what the page actually says. Never add facts, figures, dates, ratings, or names that are not present in the text.
- If the page does not contain information relevant to the request, reply with exactly: NO_RELEVANT_CONTENT
- Keep names, titles, dates, numbers, and ratings exactly as written on the page.
- Drop navigation text, advertisements, cookie notices, subscription prompts, and unrelated articles.
- Be concise and structured - short labelled lines or bullets, not prose paragraphs.
- Do not add commentary, opinions, or a preamble. Output only the extracted notes.

The user's request is: ${request}`;
}

/**
 * Runs the LLM extraction pass over already-fetched page text.
 * Returns null when nothing on the page was relevant, so callers can skip the source entirely
 * instead of forwarding filler to the next agent.
 */
async function extractRelevant(settings, text, request, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  if (!text || !text.trim()) return null;
  const bounded = text.length > maxChars ? text.substring(0, maxChars) : text;
  const result = await generateText(settings, buildExtractionPrompt(request), bounded);
  const cleaned = (result || '').trim();
  if (!cleaned || cleaned.includes('NO_RELEVANT_CONTENT')) return null;
  return cleaned;
}

/**
 * Fetches `url` and returns only the parts of it relevant to `request`, as judged by PATTI's
 * own LLM. This is the resilient alternative to CSS-selector scraping: because the model reads
 * the page and decides what matters, a site redesign changes the markup but not the outcome.
 *
 * Costs one LLM call per page, so callers should fetch pages concurrently but keep the number
 * of pages per request small - on a local model each call is measured in tens of seconds.
 *
 * Falls back to returning truncated raw page text if the extraction call fails, so a flaky LLM
 * degrades quality rather than losing the source outright. Returns null only when the page
 * itself could not be fetched.
 *
 * @param {object} settings LLM settings from llm_text.js's buildSettingsForUser
 * @param {string} url Page to read
 * @param {string} request What the caller wants to learn from the page
 * @returns {Promise<{url: string, title: string, content: string, extracted: boolean} | null>}
 */
async function readPageForRequest(settings, url, request, options = {}) {
  const page = await fetchPageText(url, options);
  if (!page.ok) return null;

  try {
    const content = await extractRelevant(settings, page.text, request, options);
    if (!content) return null;
    return { url, title: page.title, content, extracted: true };
  } catch (err) {
    const fallbackChars = options.maxChars || DEFAULT_MAX_CHARS;
    if (!page.text) return null;
    return {
      url,
      title: page.title,
      content: page.text.substring(0, Math.min(fallbackChars, 2000)),
      extracted: false
    };
  }
}

module.exports = {
  fetchPageText,
  extractRelevant,
  readPageForRequest,
  selectMainContent,
  DEFAULT_MAX_CHARS
};
