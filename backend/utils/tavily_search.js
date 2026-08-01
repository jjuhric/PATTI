// Client for the Tavily Search API (tavily.com) - PATTI's primary web search backend.
// Tavily is purpose-built for AI agent search: it returns relevance-ranked results with a
// per-result score and an NLP-extracted content snippet, and has a real 'news' search mode -
// this replaces raw HTML scraping of DuckDuckGo/Google search pages, which is fragile (breaks
// on markup changes, gets rate-limited/blocked, and returns whatever junk is on the page with
// no relevance judgment at all).
const TAVILY_BASE_URL = 'https://api.tavily.com';
const TAVILY_TIMEOUT_MS = 15000;

function isConfigured() {
  return Boolean(process.env.TAVILY_API_KEY);
}

async function tavilyFetch(path, { method = 'GET', body } = {}) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY is not configured.');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TAVILY_TIMEOUT_MS);
  try {
    const res = await fetch(`${TAVILY_BASE_URL}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Tavily ${path} returned ${res.status}${errText ? `: ${errText}` : ''}`);
    }
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Tavily request to ${path} timed out after ${TAVILY_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// A word matching any of these strongly signals the caller wants current news coverage, where
// Tavily's dedicated 'news' topic (real-time, mainstream-media-focused) beats its 'general' mode.
const NEWS_SIGNAL_RE = /\bnews\b|\bheadlines?\b|\blatest updates?\b|\bbreaking\b/i;

/**
 * Runs a Tavily search and returns normalized results.
 *
 * Defaults to search_depth 'basic' (1 API credit) rather than 'advanced' (2 credits) - at the
 * free tier's 1000 credits/month, 'basic' comfortably supports 20-30+ searches/day even before
 * accounting for multi-topic requests that need more than one search. 'advanced' is only used
 * as a one-time retry when 'basic' comes back empty, since a tougher query may need the deeper
 * semantic search 'advanced' provides.
 *
 * @param {string} query
 * @param {object} [options]
 * @param {'general'|'news'|'finance'} [options.topic] - auto-detected from the query if omitted
 * @param {number} [options.maxResults=6]
 * @param {boolean} [options.includeAnswer=true] - ask Tavily for a synthesized answer too
 * @returns {Promise<{answer: string|null, results: Array<{title, url, content, score}>}|null>}
 *   null when Tavily returns no results at all (caller should fall back to another search path).
 */
async function tavilySearch(query, options = {}) {
  const topic = options.topic || (NEWS_SIGNAL_RE.test(query) ? 'news' : 'general');
  const maxResults = options.maxResults || 6;
  const includeAnswer = options.includeAnswer !== false;

  const runSearch = async (searchDepth) => tavilyFetch('/search', {
    method: 'POST',
    body: {
      query,
      topic,
      search_depth: searchDepth,
      max_results: maxResults,
      include_answer: includeAnswer ? 'basic' : false
    }
  });

  let data = await runSearch('basic');
  if (!data.results || data.results.length === 0) {
    // One credit-costlier retry for a genuinely hard query, rather than giving up on the first
    // empty result the way the old DDG-then-Google-then-Wikipedia chain effectively did.
    data = await runSearch('advanced');
  }

  if (!data.results || data.results.length === 0) return null;

  return {
    answer: data.answer || null,
    results: data.results.map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      score: typeof r.score === 'number' ? r.score : 0
    }))
  };
}

// The /usage endpoint reflects one account-wide total, so every user/tab polling the header
// stat is asking the exact same question - caching it here (rather than per-request) means N
// open tabs cost 1 real Tavily call per TTL window instead of N, which is what actually
// triggered Tavily's own "excessive requests" 429 on this endpoint after the header stats
// feature shipped. On a fetch failure (including that 429), serve the last-known-good value
// instead of null so a transient rate-limit doesn't flash the UI to "-".
const USAGE_CACHE_TTL_MS = 60000;
let usageCache = null;
let usageCacheAt = 0;

/**
 * Fetches API-key usage/limit from Tavily's /usage endpoint, for surfacing "X / 1000 credits
 * used" in the UI. Server-scoped (one shared TAVILY_API_KEY), not per-user.
 * @returns {Promise<{used: number, limit: number}|null>} null if not configured, or the call
 *   fails with no prior cached value to fall back on.
 */
async function getTavilyUsage() {
  if (!isConfigured()) return null;
  if (usageCache && Date.now() - usageCacheAt < USAGE_CACHE_TTL_MS) return usageCache;

  try {
    const data = await tavilyFetch('/usage');
    // account.plan_usage/plan_limit is the account-wide total shown on Tavily's own dashboard
    // ("0 / 1,000 Credits") - key.usage/limit tracks a single API key's own sub-allocation
    // instead, which can be a smaller, unrelated number (confirmed live: this account's
    // key.limit came back null while account.plan_limit correctly showed 1000). Read both
    // fields from the same object rather than mixing them, and only fall back to the key-level
    // pair if the account object is missing entirely.
    const account = data.account;
    const used = account ? (account.plan_usage ?? 0) : (data.key?.usage ?? 0);
    const limit = account ? (account.plan_limit ?? 0) : (data.key?.limit ?? 0);
    usageCache = { used, limit };
    usageCacheAt = Date.now();
    return usageCache;
  } catch (err) {
    console.error('Failed to fetch Tavily usage:', err.message);
    return usageCache;
  }
}

/**
 * True once the shared account has used up its Tavily credit allocation, so callers (see
 * web_search_tool.js) can skip straight to the legacy DuckDuckGo/Google/Wikipedia fallback
 * chain instead of spending a call that would just fail once credits hit zero. Token usage
 * already gets this same treatment (quotaMiddleware.js) - search credits previously had no
 * enforcement at all, just a passive "X/1,000" display. A missing/unknown limit (0, or the
 * usage fetch itself failing with nothing cached yet) is treated as "not exhausted" - better to
 * attempt a real search than to silently degrade every query because usage couldn't be read.
 */
async function isUsageExhausted() {
  const usage = await getTavilyUsage();
  if (!usage || !usage.limit) return false;
  return usage.used >= usage.limit;
}

function _resetUsageCacheForTests() {
  usageCache = null;
  usageCacheAt = 0;
}

// Keeps the cached value but marks it stale, so tests can exercise the "re-fetch, fall back to
// last-known-good on failure" path without waiting out the real TTL.
function _expireUsageCacheForTests() {
  usageCacheAt = 0;
}

module.exports = {
  tavilySearch,
  getTavilyUsage,
  isConfigured,
  isUsageExhausted,
  _resetUsageCacheForTests,
  _expireUsageCacheForTests
};
