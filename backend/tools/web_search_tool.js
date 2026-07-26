const cheerio = require('cheerio');
const { extractFirst100Words } = require('../utils/helpers');

// Web search tool operations (supports deep searches & weather)
async function handleWebSearchTool(db, userId, query) {
  if (!query) return 'Error: Query is required';

  // Intercept news queries and route to the RSS Finder news search tool
  const isNewsQuery = /\bnews\b|\bheadlines\b|\blatest updates\b/i.test(query);
  if (isNewsQuery && process.env.NODE_ENV !== 'test') {
    const { handleGoogleNewsTool } = require('./google_news_tool');
    return handleGoogleNewsTool(query);
  }

  // Check if query is or contains a URL
  const urlRegex = /(https?:\/\/[^\s]+)/gi;
  const urlMatch = query.match(urlRegex);
  
  if (urlMatch) {
    const targetUrl = urlMatch[0];
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000); // 6 seconds timeout for direct scrape
      
      const pageRes = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5'
        },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!pageRes.ok) {
        throw new Error(`Direct scrape failed: status ${pageRes.status}`);
      }
      
      const pageHtml = await pageRes.text();
      const $page = cheerio.load(pageHtml);
      const pageTitle = $page('title').text().trim();
      
      // Remove interactive, media, and layout elements
      $page('script, style, head, nav, footer, header, iframe, noscript, svg, img').remove();
      
      const cleanText = $page('body').text().replace(/\s+/g, ' ').trim();
      const fullContent = cleanText.substring(0, 3000); // Larger chunk for direct URL scraping (up to 3000 chars)

      return `## 📄 Direct Page Scrape: [${pageTitle || targetUrl}](${targetUrl})\n\n> ${fullContent || 'No text content available.'}`;
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

  // Deep scrape the top search result pages
  const scrapedResults = [];
  for (const res of results.slice(0, 3)) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      
      const pageRes = await fetch(res.link, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      
      const pageHtml = await pageRes.text();
      const $page = cheerio.load(pageHtml);
      
      // Remove interactive, media, and layout elements
      $page('script, style, head, nav, footer, header, iframe, noscript, svg, img').remove();
      
      const cleanText = $page('body').text().replace(/\s+/g, ' ').trim();
      const fullContent = cleanText.substring(0, 1500); // 1500 characters of clean content
      
      scrapedResults.push({
        title: res.title,
        link: res.link,
        snippet: res.snippet,
        scraped_content: fullContent || 'No text content available.'
      });
    } catch (err) {
      console.error(`Deep search scrape failed for ${res.link}:`, err.message);
      scrapedResults.push({
        title: res.title,
        link: res.link,
        snippet: res.snippet,
        scraped_content: 'Could not scrape live contents. Falling back to search snippet.'
      });
    }
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
 * Runs the DuckDuckGo -> Google -> Wikipedia fallback chain and returns
 * normalized top results for callers that need raw search results
 * (e.g. the deep research tool) rather than the formatted markdown report
 * that handleWebSearchTool produces.
 *
 * @param {string} query
 * @param {number} limit Max results to return (does not re-query, just slices).
 * @returns {Promise<{engine: 'ddg'|'google'|'wikipedia'|'none', results: Array<{link: string, title: string, snippet: string}>}>}
 */
async function performWebSearch(query, limit = 5) {
  let results = await searchDuckDuckGo(query);
  if (results.length > 0) return { engine: 'ddg', results: results.slice(0, limit) };

  results = await searchGoogle(query);
  if (results.length > 0) return { engine: 'google', results: results.slice(0, limit) };

  results = await searchWikipedia(query);
  if (results.length > 0) return { engine: 'wikipedia', results: results.slice(0, limit) };

  return { engine: 'none', results: [] };
}

module.exports = { handleWebSearchTool, performWebSearch, searchDuckDuckGo, searchGoogle, searchWikipedia };
