const cheerio = require('cheerio');
const { GoogleDecoder } = require('google-news-url-decoder');
const logger = require('../utils/logger');

// Plain fetch() has no default read timeout - a slow/unresponsive RSS feed hangs
// indefinitely (observed: an 11+ minute hang before the whole news_agent delegation
// finally surfaced a bare "fetch failed"). These bound each network call the same way
// sports_tool.js already does for its own fetches.
const RSS_FETCH_TIMEOUT_MS = 8000;
const DECODE_TIMEOUT_MS = 6000;

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// GoogleDecoder (a third-party lib) makes its own internal fetch() calls with no
// way to pass an AbortSignal in, so a hung request can't be cancelled - this just
// bounds how long we're willing to wait on its result before giving up and falling
// back to the original (undecoded) link.
function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs))
  ]);
}

async function performSearch(query) {
  const results = [];
  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const response = await fetchWithTimeout(rssUrl, RSS_FETCH_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(`Google News RSS failed: status ${response.status}`);
    }
    const xml = await response.text();

    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    const decoder = new GoogleDecoder();

    while ((match = itemRegex.exec(xml)) !== null && results.length < 5) {
      const block = match[1];
      const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1];
      const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1];
      const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1];

      if (title && link) {
        let cleanTitle = title.replace(/<[^>]*>/g, '').trim();
        let destinationLink = link.trim();

        try {
          const decoded = await withTimeout(decoder.decode(destinationLink), DECODE_TIMEOUT_MS, 'Google News URL decode');
          if (decoded && decoded.status) {
            destinationLink = decoded.decoded_url;
          }
        } catch (decodeErr) {
          // Fallback to original link
        }

        results.push({
          title: cleanTitle,
          link: destinationLink,
          summary: pubDate ? `Published: ${pubDate}` : 'No summary available.'
        });
      }
    }
  } catch (err) {
    console.error(`Google News RSS search failed for query "${query}":`, err.message);
  }

  return results;
}

async function parseTMZ() {
  const articles = [];
  try {
    const response = await fetchWithTimeout('http://www.tmz.com/rss.xml', RSS_FETCH_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(`TMZ RSS fetch failed: status ${response.status}`);
    }
    const xml = await response.text();
    const $ = cheerio.load(xml, { xmlMode: true });

    $('item').each((i, el) => {
      if (articles.length >= 5) return;
      const title = $(el).find('title').text().trim();
      const link = $(el).find('link').text().trim();
      const description = $(el).find('description').text().trim();
      const cleanDescription = description.replace(/<[^>]*>/g, '').trim();
      articles.push({
        title,
        link,
        summary: cleanDescription || 'No summary available.'
      });
    });
  } catch (err) {
    console.error('TMZ RSS parsing failed:', err.message);
  }
  return articles;
}

async function handleNewsTool(db, userId, action, params) {
  if (action !== 'get_general_news') {
    return JSON.stringify({ error: `Unknown action: ${action}` });
  }

  let interests = [];
  if (db && userId) {
    try {
      const user = await db.get('SELECT interests FROM users WHERE id = ?', [userId]);
      logger.info(`[News Tool DB Query] User ID: ${userId}, User Row: ${JSON.stringify(user)}, raw interests: ${user?.interests}`);
      if (user && user.interests) {
        interests = JSON.parse(user.interests);
      }
    } catch (err) {
      console.error('Failed to query user interests:', err.message);
    }
  }

  const tmzNews = await parseTMZ();
  const preferenceNews = [];

  if (!interests || interests.length === 0) {
    // Empty -> TMZ and google search for "Today's Top News"
    const articles = await performSearch("Today's Top News");
    preferenceNews.push({
      topic: "Today's Top News",
      articles
    });
  } else {
    // If less than 5, use what is there. If 5 or more, randomly choose exactly 5.
    let selectedTopics = [];
    if (interests.length <= 5) {
      selectedTopics = [...interests];
    } else {
      const shuffled = [...interests].sort(() => 0.5 - Math.random());
      selectedTopics = shuffled.slice(0, 5);
    }

    for (const topic of selectedTopics) {
      const articles = await performSearch(`${topic} news`);
      preferenceNews.push({
        topic,
        articles
      });
    }
  }

  const result = JSON.stringify({
    tmz_news: tmzNews,
    preference_news: preferenceNews
  });
  logger.info(`[News Tool Output] Length: ${result.length}, interests: ${JSON.stringify(interests)}`);
  return result;
}

module.exports = { handleNewsTool };
