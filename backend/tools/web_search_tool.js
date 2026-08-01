const cheerio = require('cheerio');
const { tavilySearch, isConfigured: isTavilyConfigured, isUsageExhausted: isTavilyUsageExhausted } = require('../utils/tavily_search');

// Tavily result relevance is scored 0-1 by Tavily itself; below this, a result is noise rather
// than something worth including - this is the "think through search results" filtering step,
// so a broad/ambiguous query surfaces fewer, better results instead of everything it found.
const TAVILY_RELEVANCE_THRESHOLD = 0.3;

// How many of the relevant results get a full-detail follow-up read (via the LLM extractor)
// rather than just their Tavily snippet. Capped low since each one costs a local LLM call.
const DEEP_READ_COUNT = 2;

/**
 * Builds LLM settings for the extractor, unless the LLM is already busy with other work (in
 * which case we degrade to snippets/blind-truncation rather than queuing behind it) or no
 * user/db context is available (e.g. deep_research_tool's own standalone calls).
 */
async function getExtractorSettings(db, userId) {
  if (!db || !userId) return null;
  try {
    const { llmIsBusy } = require('../utils/tts_narration');
    if (llmIsBusy()) return null;
  } catch (e) {
    // If the busy-check itself is unavailable, proceed - better to try the extractor than to
    // silently skip it over an unrelated require failure.
  }
  try {
    const { buildSettingsForUser } = require('../utils/llm_text');
    return await buildSettingsForUser(db, userId);
  } catch (err) {
    return null;
  }
}

/** Last-resort fetch when the LLM extractor isn't available - blind truncation of the page's
 * visible text, same as this tool's behavior before the extractor existed. One fetch covers
 * both title and content so a fallback scrape never costs a second round-trip to the same URL. */
async function blindScrapeUrl(url, maxChars, timeoutMs = 3000) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    const title = $('title').text().trim() || url;
    $('script, style, head, nav, footer, header, iframe, noscript, svg, img').remove();
    const cleanText = $('body').text().replace(/\s+/g, ' ').trim();
    const content = cleanText.substring(0, maxChars);
    return content ? { title, content } : null;
  } catch (err) {
    return null;
  }
}

/**
 * Reads a URL's title and real content in a single fetch: the LLM extractor when available,
 * blind truncation otherwise. Returns null if the page couldn't be read at all.
 */
async function readUrlContent(url, query, settings, maxChars) {
  if (settings) {
    try {
      const { readPageForRequest } = require('../utils/web_extract');
      const extracted = await readPageForRequest(settings, url, query, { maxChars: maxChars * 2 });
      if (extracted) return { title: extracted.title || url, content: extracted.content };
    } catch (err) {
      console.error(`Extractor failed for ${url}, falling back to blind scrape:`, err.message);
    }
  }
  return blindScrapeUrl(url, maxChars);
}

/**
 * Runs a Tavily search, filters to relevant results, and follows the top few links for real
 * detail beyond the snippet - "search, judge relevance, follow the best link, read the page."
 * Returns null when Tavily has nothing usable, so the caller can fall back to the legacy chain.
 */
async function searchWithTavily(query, db, userId) {
  const searchResult = await tavilySearch(query, { maxResults: 6 });
  if (!searchResult) return null;

  const relevant = searchResult.results.filter((r) => r.score >= TAVILY_RELEVANCE_THRESHOLD);
  if (relevant.length === 0) return null;

  const settings = await getExtractorSettings(db, userId);
  const topLinks = relevant.slice(0, DEEP_READ_COUNT);
  const deepReads = [];
  if (settings) {
    for (const r of topLinks) {
      const read = await readUrlContent(r.url, query, settings, 5000);
      if (read) deepReads.push({ url: r.url, title: r.title, content: read.content });
    }
  }

  const deepUrls = new Set(deepReads.map((d) => d.url));
  let md = `## 🔍 Web Search Report for: *"${query}"*\n\n`;
  if (searchResult.answer) {
    md += `**Quick Answer:** ${searchResult.answer}\n\n`;
  }
  deepReads.forEach((d, idx) => {
    md += `### ${idx + 1}. [${d.title}](${d.url})\n${d.content}\n\n---\n\n`;
  });
  const remaining = relevant.filter((r) => !deepUrls.has(r.url));
  if (remaining.length > 0) {
    md += `#### Additional relevant sources:\n`;
    remaining.forEach((r) => {
      md += `- [${r.title}](${r.url}): ${r.content}\n`;
    });
  }
  return md;
}

// Web search tool operations (supports deep searches & weather)
async function handleWebSearchTool(db, userId, query) {
  if (!query) return 'Error: Query is required';

  // Check if query is or contains a URL
  const urlRegex = /(https?:\/\/[^\s]+)/gi;
  const urlMatch = query.match(urlRegex);

  if (urlMatch) {
    const targetUrl = urlMatch[0];
    try {
      const settings = await getExtractorSettings(db, userId);
      const read = await readUrlContent(targetUrl, query, settings, 3000);
      if (read === null) throw new Error('Direct scrape returned no content');

      return `## 📄 Direct Page Scrape: [${read.title || targetUrl}](${targetUrl})\n\n> ${read.content}`;
    } catch (err) {
      console.error(`Direct scraping of ${targetUrl} failed, falling back to search:`, err.message);
      // Fallback: If direct scrape fails, remove the URL from the query and proceed to standard search
      query = query.replace(targetUrl, '').trim() || query;
    }
  }

  const isWeatherQuery = /weather|temperature|forecast|wind|humidity|rain|snow/i.test(query);

  if (isWeatherQuery) {
    try {
      let profile = null;
      if (db && userId) {
        profile = await db.get('SELECT name, zipcode, temp_unit, weather_api_key FROM users WHERE id = ?', [userId]);
      }

      const zipMatch = query.match(/\b\d{5}\b/);
      const zipcode = zipMatch ? zipMatch[0] : (profile ? profile.zipcode : null);

      const { decrypt } = require('../utils/crypto');
      const apiKey = profile ? decrypt(profile.weather_api_key) : null;
      const units = profile ? profile.temp_unit : 'imperial'; // 'imperial', 'metric', 'standard'

      if (zipcode && apiKey) {
        const weatherUrl = `https://api.openweathermap.org/data/2.5/weather?zip=${zipcode}&units=${units}&appid=${apiKey}`;
        const weatherRes = await fetch(weatherUrl);
        if (weatherRes.ok) {
          const data = await weatherRes.json();
          const unitSymbol = units === 'imperial' ? '°F' : (units === 'metric' ? '°C' : 'K');
          const speedUnit = units === 'imperial' ? 'mph' : 'm/s';

          const temp = data.main.temp;
          const feelsLike = data.main.feels_like;
          const desc = data.weather[0].description;
          const humidity = data.main.humidity;
          const wind = data.wind.speed;
          const cityName = data.name;

          return `### 🌦️ Local Weather Report for **${cityName}** (${zipcode})

| Parameter | Value |
| --- | --- |
| **Current Weather** | ${desc.charAt(0).toUpperCase() + desc.slice(1)} |
| **Temperature** | ${temp}${unitSymbol} |
| **Feels Like** | ${feelsLike}${unitSymbol} |
| **Humidity** | ${humidity}% |
| **Wind Speed** | ${wind} ${speedUnit} |
`;
        }
      }
    } catch (weatherErr) {
      console.error('Failed to fetch weather from OpenWeatherMap:', weatherErr.message);
    }
  }

  // Primary search path: Tavily (relevance-scored results, native news mode, no HTML-scraping
  // fragility). Falls through to the legacy scraping chain below when not configured, when the
  // shared account has used up its credit allocation, or when it genuinely finds nothing
  // relevant.
  if (isTavilyConfigured() && !(await isTavilyUsageExhausted())) {
    try {
      const report = await searchWithTavily(query, db, userId);
      if (report) return report;
    } catch (err) {
      console.error('Tavily search failed, falling back to legacy search chain:', err.message);
    }
  }

  // Intercept news queries and route to the RSS Finder news search tool - only reached when
  // Tavily isn't configured/failed, since Tavily's own 'news' topic mode (tried above) already
  // handles this natively and more reliably when available.
  const isNewsQuery = /\bnews\b|\bheadlines\b|\blatest updates\b/i.test(query);
  if (isNewsQuery && process.env.NODE_ENV !== 'test') {
    const { handleGoogleNewsTool } = require('./google_news_tool');
    return handleGoogleNewsTool(query);
  }

  // 1. Try DuckDuckGo HTML Search (Highly resilient, avoids CAPTCHAs)
  let results = await searchDuckDuckGo(query);

  // 2. Fallback to Google Search if DuckDuckGo returned 0 results
  if (results.length === 0) {
    results = await searchGoogle(query);
  }

  // 3. Fallback to Wikipedia API if both failed
  if (results.length === 0) {
    const wikiResults = await searchWikipedia(query);
    if (wikiResults.length > 0) {
      let md = `## 🔍 Wikipedia Search Fallback Report for: *"${query}"*\n\n`;
      wikiResults.forEach((r, idx) => {
        md += `### ${idx + 1}. [${r.title}](${r.link})\n`;
        md += `> ${r.snippet}\n\n`;
      });
      return md;
    }
    return 'Error: Web search failed completely (DuckDuckGo, Google, and Wikipedia returned no results).';
  }

  // Deep scrape the top search result pages - LLM extractor when available, blind truncation
  // as the last resort (matches this tool's original behavior when no LLM context is on hand).
  const settings = await getExtractorSettings(db, userId);
  const scrapedResults = [];
  for (const res of results.slice(0, 3)) {
    const read = await readUrlContent(res.link, query, settings, 1500);
    scrapedResults.push({
      title: res.title,
      link: res.link,
      snippet: res.snippet,
      scraped_content: (read && read.content) || 'Could not scrape live contents. Falling back to search snippet.'
    });
  }

  // Compile results into structured Markdown format
  let markdownReport = `## 🔍 Deep Web Search Report for: *"${query}"*\n\n`;
  scrapedResults.forEach((item, index) => {
    markdownReport += `### ${index + 1}. [${item.title}](${item.link})\n`;
    markdownReport += `* **Snippet**: ${item.snippet}\n`;
    markdownReport += `* **Scraped Live Content**:\n> ${item.scraped_content}\n\n---\n\n`;
  });

  return markdownReport;
}

/**
 * Searches DuckDuckGo's HTML endpoint and returns normalized results.
 * @param {string} query
 * @returns {Promise<Array<{link: string, title: string, snippet: string}>>}
 */
async function searchDuckDuckGo(query) {
  const results = [];
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (response.ok) {
      const html = await response.text();
      const $ = cheerio.load(html);

      $('.result__body').each((i, el) => {
        if (results.length >= 5) return;
        const titleEl = $(el).find('.result__a');
        const snippetEl = $(el).find('.result__snippet');
        let link = titleEl.attr('href');
        const title = titleEl.text().trim();
        const snippet = snippetEl.text().trim();

        if (link && title) {
          // Resolve DuckDuckGo redirect link
          let cleanLink = link;
          if (link.startsWith('//')) {
            cleanLink = 'https:' + link;
          }
          if (cleanLink.includes('uddg=')) {
            try {
              const urlObj = new URL(cleanLink);
              const uddg = urlObj.searchParams.get('uddg');
              if (uddg) cleanLink = decodeURIComponent(uddg);
            } catch (urlErr) {
              // fallback to original link
            }
          }
          results.push({ link: cleanLink, title, snippet });
        }
      });
    }
  } catch (err) {
    console.error('DuckDuckGo search failed:', err.message);
  }
  return results;
}

/**
 * Searches Google and returns normalized results.
 * @param {string} query
 * @returns {Promise<Array<{link: string, title: string, snippet: string}>>}
 */
async function searchGoogle(query) {
  const results = [];
  try {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      }
    });

    if (response.ok) {
      const html = await response.text();
      const $ = cheerio.load(html);

      $('a').each((i, el) => {
        if (results.length >= 5) return;
        const link = $(el).attr('href');
        const h3 = $(el).find('h3');
        if (link && h3.length > 0) {
          if (link.startsWith('/url?') || link.includes('google.com')) return;

          const title = h3.text().trim();
          const parentResult = $(el).closest('.g, .MjjYud, .tF2Cxc, .kvH3rc');
          let snippet = '';
          if (parentResult.length > 0) {
            snippet = parentResult.find('.VwiC3b, .BNeawe, .yD3nu, .wM6W7d').text().trim();
          }
          if (!snippet) {
            snippet = $(el).parent().parent().text().trim().substring(0, 150);
          }
          results.push({ title, link, snippet });
        }
      });
    }
  } catch (err) {
    console.error('Google search failed:', err.message);
  }
  return results;
}

/**
 * Searches Wikipedia's API and returns normalized results (title/link/snippet).
 * @param {string} query
 * @returns {Promise<Array<{link: string, title: string, snippet: string}>>}
 */
async function searchWikipedia(query) {
  try {
    const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`;
    const res = await fetch(wikiUrl, {
      headers: {
        'User-Agent': 'PATTI-Assistant/1.1 (contact@patti.assistant; mailto:support@patti.assistant)'
      }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.query && data.query.search) {
        return data.query.search.slice(0, 3).map(r => ({
          link: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title)}`,
          title: r.title,
          snippet: (r.snippet || '').replace(/<span class="searchmatch">|<\/span>/g, '')
        }));
      }
    }
  } catch (wikiErr) {
    console.error('Wikipedia fallback failed:', wikiErr.message);
  }
  return [];
}

/**
 * Runs the Tavily -> DuckDuckGo -> Google -> Wikipedia fallback chain and returns normalized
 * top results for callers that need raw search results (e.g. the deep research tool) rather
 * than the formatted markdown report that handleWebSearchTool produces.
 *
 * @param {string} query
 * @param {number} limit Max results to return (does not re-query, just slices).
 * @returns {Promise<{engine: 'tavily'|'ddg'|'google'|'wikipedia'|'none', results: Array<{link: string, title: string, snippet: string}>}>}
 */
async function performWebSearch(query, limit = 5) {
  if (isTavilyConfigured() && !(await isTavilyUsageExhausted())) {
    try {
      const searchResult = await tavilySearch(query, { maxResults: limit, includeAnswer: false });
      if (searchResult && searchResult.results.length > 0) {
        return {
          engine: 'tavily',
          results: searchResult.results.slice(0, limit).map((r) => ({ link: r.url, title: r.title, snippet: r.content }))
        };
      }
    } catch (err) {
      console.error('Tavily search failed in performWebSearch, falling back:', err.message);
    }
  }

  let results = await searchDuckDuckGo(query);
  if (results.length > 0) return { engine: 'ddg', results: results.slice(0, limit) };

  results = await searchGoogle(query);
  if (results.length > 0) return { engine: 'google', results: results.slice(0, limit) };

  results = await searchWikipedia(query);
  if (results.length > 0) return { engine: 'wikipedia', results: results.slice(0, limit) };

  return { engine: 'none', results: [] };
}

module.exports = { handleWebSearchTool, performWebSearch, searchDuckDuckGo, searchGoogle, searchWikipedia };
