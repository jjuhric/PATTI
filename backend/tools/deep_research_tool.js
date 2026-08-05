const cheerio = require('cheerio');
const { performWebSearch } = require('./web_search_tool');
const { storeResearchedKnowledge, searchResearchedKnowledge, deleteResearchedKnowledge } = require('../utils/embeddings');
const { assertPublicHttpUrl } = require('../utils/ssrfGuard');

const USER_AGENT = 'PATTI-ResearchBot/1.0 (+internal deep-research feature)';
const MAX_PAGES = 8;
const TIME_BUDGET_MS = 25000;
const PER_PAGE_TIMEOUT_MS = 6000;
const POLITE_DELAY_MS = 400;
const HOP2_SOURCE_PAGES = 3;
const HOP2_LINKS_PER_PAGE = 2;
const HOP2_RELEVANCE_MIN = 0.3;
const HOP2_MAX_CANDIDATES = 20;

const CACHE_HIT_THRESHOLD = 0.85;
const CACHE_RELATED_THRESHOLD = 0.70;
const FRESHNESS_DAYS = 14;
const ALWAYS_FRESH_PATTERN = /\blatest\b|\bcurrent\b|\btoday\b|\bnow\b|\brecent\b/i;

/**
 * Handles deep-research tool calls from worker agents.
 *
 * @param {import('sqlite').Database} db SQLite DB instance (unused for storage, kept for dispatcher signature consistency)
 * @param {number} userId The user's ID (provenance only - knowledge storage is global, not per-user)
 * @param {string} action 'research' | 'save_knowledge'
 * @param {object} params Action-specific parameters
 * @returns {Promise<string>} Text result for the worker agent
 */
async function handleDeepResearchTool(db, userId, action, params = {}) {
  try {
    if (action === 'research') {
      return await handleResearch(params);
    }
    if (action === 'save_knowledge') {
      return await handleSaveKnowledge(userId, params);
    }
    return `Error: Unknown Deep Research action "${action}".`;
  } catch (err) {
    console.error('Deep research tool error:', err);
    return `Error performing deep research: ${err.message}`;
  }
}

async function handleResearch(params) {
  const { topic } = params;
  if (!topic || typeof topic !== 'string' || !topic.trim()) {
    return 'Error: "topic" parameter is required.';
  }
  const cleanTopic = topic.trim();

  let relatedContext = '';
  if (!ALWAYS_FRESH_PATTERN.test(cleanTopic)) {
    const matches = await searchResearchedKnowledge(cleanTopic, 3);
    const best = matches[0];
    if (best && best.score >= CACHE_HIT_THRESHOLD && !isStale(best.metadata)) {
      await bumpHit(best);
      const sources = (best.metadata.source_urls || []).map(u => `- ${u}`).join('\n');
      return `Existing knowledge found (researched on ${formatDate(best.metadata.created_at)}, no new crawl needed):\n\n${best.text}\n\nSources:\n${sources}`;
    }
    if (best && best.score >= CACHE_RELATED_THRESHOLD) {
      relatedContext = `\n\n(Note: PATTI has possibly related prior knowledge on "${best.metadata.topic}" from ${formatDate(best.metadata.created_at)} - consider whether it's relevant, but the following is freshly crawled material.)`;
    }
  }

  const pages = await crawlTopic(cleanTopic);
  if (pages.length === 0) {
    return `Error: Deep research crawl for "${cleanTopic}" returned no usable results (all sources failed or were unreachable).`;
  }

  let report = `## Deep Research: "${cleanTopic}"\n\nGathered from ${pages.length} source(s):${relatedContext}\n\n`;
  pages.forEach((p, i) => {
    report += `### ${i + 1}. [${p.title || p.url}](${p.url})\n> ${p.content}\n\n`;
  });
  report += `\nSynthesize the above into a clear, cited summary for the user, then call the "save_knowledge" action with your distilled summary (not this raw material) so this topic is instantly available next time.`;

  return report;
}

async function handleSaveKnowledge(userId, params) {
  const { topic, content, source_urls } = params;
  if (!topic || typeof topic !== 'string' || !topic.trim()) {
    return 'Error: "topic" parameter is required.';
  }
  if (!content || typeof content !== 'string' || !content.trim()) {
    return 'Error: "content" parameter is required.';
  }

  const now = new Date().toISOString();
  await storeResearchedKnowledge(content.trim(), {
    topic: topic.trim(),
    source_urls: Array.isArray(source_urls) ? source_urls : [],
    created_at: now,
    created_by_user_id: userId || null,
    hit_count: 0,
    last_hit_at: now
  });

  return `Knowledge on "${topic.trim()}" saved to PATTI's shared knowledge base.`;
}

function isStale(metadata) {
  const created = metadata.created_at ? new Date(metadata.created_at) : null;
  if (!created || isNaN(created.getTime())) return true;
  const ageDays = (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays > FRESHNESS_DAYS;
}

async function bumpHit(match) {
  try {
    const updatedMetadata = {
      ...match.metadata,
      hit_count: (match.metadata.hit_count || 0) + 1,
      last_hit_at: new Date().toISOString()
    };
    // Update in place: delete the old row, then re-add with bumped metadata
    // (same delete-then-add pattern used for LanceDB dedup in memory_tool.js).
    await deleteResearchedKnowledge(match.text);
    await storeResearchedKnowledge(match.text, updatedMetadata);
  } catch (err) {
    console.warn('Failed to bump hit_count for cached research:', err.message);
  }
}

function formatDate(iso) {
  if (!iso) return 'an unknown date';
  try {
    return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch (e) {
    return iso;
  }
}

function relevanceScore(linkText, topic) {
  const topicWords = new Set((topic.toLowerCase().match(/\w+/g) || []));
  const textWords = new Set((linkText || '').toLowerCase().match(/\w+/g) || []);
  if (topicWords.size === 0 || textWords.size === 0) return 0;
  let overlap = 0;
  for (const w of topicWords) if (textWords.has(w)) overlap++;
  return overlap / topicWords.size;
}

async function fetchAndClean(url, deadline, maxChars) {
  const remaining = deadline - Date.now();
  if (remaining <= 500) return null;

  try {
    await assertPublicHttpUrl(url);
  } catch (err) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.min(PER_PAGE_TIMEOUT_MS, remaining));
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml' },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;

    const html = await res.text();
    const $ = cheerio.load(html);
    $('script, style, head, nav, footer, header, iframe, noscript, svg, img').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim().substring(0, maxChars);
    return { $, text };
  } catch (err) {
    clearTimeout(timeoutId);
    return null;
  }
}

/**
 * Crawls a topic across multiple sources: a breadth-first search over the
 * top web-search results (depth 0), plus a small number of same-topic-relevant
 * links mined from the first few depth-0 pages, followed one hop deeper
 * (depth 1). Bounded by a page count cap and a wall-clock time budget so a
 * single tool call can never hang a worker-agent turn.
 *
 * @param {string} topic
 * @returns {Promise<Array<{url: string, title: string, depth: number, content: string}>>}
 */
async function crawlTopic(topic) {
  const deadline = Date.now() + TIME_BUDGET_MS;
  const seen = new Set();
  const pages = [];

  const { results: seeds } = await performWebSearch(topic, 5);
  const queue = seeds.map(s => ({ url: s.link, title: s.title, depth: 0 }));
  let hop2SourcesUsed = 0;

  while (queue.length && pages.length < MAX_PAGES && Date.now() < deadline) {
    const item = queue.shift();
    if (!item.url || seen.has(item.url)) continue;
    seen.add(item.url);

    const maxChars = item.depth === 0 ? 1500 : 900;
    const result = await fetchAndClean(item.url, deadline, maxChars);

    if (result && result.text) {
      pages.push({ url: item.url, title: item.title, depth: item.depth, content: result.text });

      if (item.depth === 0 && hop2SourcesUsed < HOP2_SOURCE_PAGES && pages.length < MAX_PAGES && Date.now() < deadline) {
        hop2SourcesUsed++;
        const candidates = [];
        result.$('a[href^="http"]').each((i, el) => {
          if (candidates.length >= HOP2_MAX_CANDIDATES) return false;
          const href = result.$(el).attr('href');
          const linkText = result.$(el).text().trim();
          if (href && linkText && !seen.has(href)) candidates.push({ href, linkText });
        });

        candidates
          .map(c => ({ ...c, score: relevanceScore(c.linkText, topic) }))
          .filter(c => c.score >= HOP2_RELEVANCE_MIN)
          .sort((a, b) => b.score - a.score)
          .slice(0, HOP2_LINKS_PER_PAGE)
          .forEach(c => queue.push({ url: c.href, title: c.linkText, depth: 1 }));
      }
    }

    if (process.env.NODE_ENV !== 'test' && queue.length && pages.length < MAX_PAGES && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, POLITE_DELAY_MS));
    }
  }

  return pages;
}

module.exports = { handleDeepResearchTool, crawlTopic };
