const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_TIMEOUT_MS = 10000;

// TMDB (JustWatch) provider ids for the major US streaming services. Unlike CSS selectors
// these are stable database identifiers, not markup that shifts on a site redesign.
const MAJOR_US_PROVIDERS = {
  8: 'Netflix',
  9: 'Prime Video',
  15: 'Hulu',
  337: 'Disney+',
  350: 'Apple TV+',
  386: 'Peacock',
  531: 'Paramount+',
  1899: 'HBO Max'
};

// Review enrichment costs one LLM call per source, and on a local model each is measured in
// tens of seconds. Cap it so a single lookup can't turn into a multi-minute stall.
const MAX_REDDIT_POSTS = 5;

function tmdbToken() {
  return process.env.TMDB_API_KEY || '';
}

async function tmdbFetch(path, params = {}) {
  const token = tmdbToken();
  if (!token) {
    throw new Error('TMDB_API_KEY is not configured. Add it to the root .env file.');
  }

  const url = new URL(`${TMDB_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS);
  try {
    // The key is a TMDB v4 read access token, which authenticates via a Bearer header
    // against the v3 endpoints - it is not an `api_key=` query parameter.
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`TMDB returned ${res.status} for ${path}`);
    }
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`TMDB request to ${path} timed out after ${TMDB_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

function todayIso() {
  return new Date().toISOString().split('T')[0];
}

const titleOf = (item) => item.title || item.name || 'Untitled';
const releaseDateOf = (item) => item.release_date || item.first_air_date || '';

function ratingOf(item) {
  if (!item.vote_average) return 'Not yet rated';
  return `${item.vote_average.toFixed(1)}/10 (${item.vote_count || 0} votes)`;
}

/**
 * Reads the streaming/rent/buy options for a title in the given region.
 * Returns a short human-readable summary rather than the raw provider payload.
 */
async function watchOptions(mediaType, id, region = 'US') {
  try {
    const data = await tmdbFetch(`/${mediaType}/${id}/watch/providers`);
    const regionData = data.results?.[region];
    if (!regionData) return 'No streaming options listed for this region';

    const names = (list) => (list || []).map((p) => p.provider_name).join(', ');
    const parts = [];
    if (regionData.flatrate?.length) parts.push(`Streaming: ${names(regionData.flatrate)}`);
    if (regionData.rent?.length) parts.push(`Rent: ${names(regionData.rent)}`);
    if (regionData.buy?.length) parts.push(`Buy: ${names(regionData.buy)}`);
    // Separated with a bullet, not a pipe: these strings land inside markdown table cells,
    // where a literal "|" would be parsed as a column break and shatter the row.
    return parts.length ? parts.join(' • ') : 'Not currently available on streaming';
  } catch (err) {
    return `Streaming availability unavailable (${err.message})`;
  }
}

/**
 * Pulls recent Reddit discussion about a title through Reddit's public JSON search API.
 * This is a real JSON endpoint, not HTML scraping, so it returns structured posts directly.
 */
async function fetchRedditDiscussion(title) {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(title)}&sort=relevance&t=year&limit=${MAX_REDDIT_POSTS}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'PATTI/1.0 (personal assistant)' },
      signal: controller.signal
    });
    if (!res.ok) return null;
    const data = await res.json();
    const posts = (data.data?.children || [])
      .map((c) => c.data)
      .filter((p) => p && p.title)
      .slice(0, MAX_REDDIT_POSTS);
    if (!posts.length) return null;

    return posts
      .map((p) => `[r/${p.subreddit}, score ${p.score}] ${p.title}\n${(p.selftext || '').substring(0, 500)}`)
      .join('\n\n');
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Adds Rotten Tomatoes scores and Reddit sentiment for a single title.
 *
 * Rotten Tomatoes has no public API, so its score is read by pointing the LLM-driven extractor
 * at the RT search page: the model reads the rendered text and picks out the score, which keeps
 * working across RT redesigns in a way that hardcoded CSS selectors do not.
 *
 * Both sources are best-effort - a failure here degrades the answer, it never fails the lookup.
 */
async function enrichWithReviews(settings, title) {
  const { readPageForRequest, extractRelevant } = require('../utils/web_extract');
  const notes = [];

  const rtUrl = `https://www.rottentomatoes.com/search?search=${encodeURIComponent(title)}`;
  const [rtResult, redditRaw] = await Promise.allSettled([
    readPageForRequest(settings, rtUrl, `Rotten Tomatoes critic (Tomatometer) and audience scores for "${title}"`),
    fetchRedditDiscussion(title)
  ]);

  if (rtResult.status === 'fulfilled' && rtResult.value?.content) {
    notes.push(`**Rotten Tomatoes:** ${rtResult.value.content}`);
  }

  if (redditRaw.status === 'fulfilled' && redditRaw.value) {
    try {
      const summary = await extractRelevant(
        settings,
        redditRaw.value,
        `What viewers think of "${title}" - overall sentiment and recurring praise or criticism`
      );
      if (summary) notes.push(`**Reddit discussion:** ${summary}`);
    } catch (err) {
      // Sentiment is optional; keep whatever else we gathered.
    }
  }

  return notes.length ? `\n${notes.join('\n\n')}\n` : '';
}

// Any value placed in a markdown table cell must not contain a literal "|", which would be
// read as a column separator and break the row apart.
const cell = (value) => String(value == null ? '' : value).replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

function renderTitleTable(items, heading, extraColumn) {
  if (!items.length) return `${heading}\n\n_No titles found._\n`;
  let md = `${heading}\n\n| Title | Released | Rating | ${extraColumn || 'Overview'} |\n| --- | --- | --- | --- |\n`;
  for (const item of items) {
    const overview = cell(item.overview || 'No description available.').substring(0, 160);
    md += `| **${cell(titleOf(item))}** | ${releaseDateOf(item) || 'TBA'} | ${ratingOf(item)} | ${item._extra ? cell(item._extra) : overview} |\n`;
  }
  return md;
}

async function handleMovieTvTool(db, userId, action, params = {}) {
  const region = params.region || 'US';
  const mediaTypeParam = (params.media_type || 'both').toLowerCase();

  try {
    if (action === 'whats_new') {
      const days = Number(params.days) || 30;
      const since = daysAgoIso(days);
      const providerIds = Object.keys(MAJOR_US_PROVIDERS).join('|');
      const mediaTypes = mediaTypeParam === 'both' ? ['movie', 'tv'] : [mediaTypeParam];

      let md = `### 🍿 New on Streaming (last ${days} days, ${region})\n\n`;
      for (const mediaType of mediaTypes) {
        const dateField = mediaType === 'movie' ? 'primary_release_date' : 'first_air_date';
        const data = await tmdbFetch(`/discover/${mediaType}`, {
          watch_region: region,
          with_watch_providers: providerIds,
          [`${dateField}.gte`]: since,
          [`${dateField}.lte`]: todayIso(),
          sort_by: 'popularity.desc',
          page: 1
        });
        const items = (data.results || []).slice(0, 10);

        // Attach the actual service per title so the answer says where to watch each one.
        for (const item of items) {
          item._extra = await watchOptions(mediaType, item.id, region);
        }
        md += renderTitleTable(items, `#### ${mediaType === 'movie' ? '🎬 Movies' : '📺 TV Shows'}`, 'Where to Watch');
        md += '\n';
      }
      return md;
    }

    if (action === 'upcoming') {
      const mediaTypes = mediaTypeParam === 'both' ? ['movie', 'tv'] : [mediaTypeParam];
      let md = `### 📅 Upcoming Releases (${region})\n\n`;
      for (const mediaType of mediaTypes) {
        let items = [];
        if (mediaType === 'movie') {
          const data = await tmdbFetch('/movie/upcoming', { region, page: 1 });
          items = data.results || [];
        } else {
          const data = await tmdbFetch('/discover/tv', {
            'first_air_date.gte': todayIso(),
            sort_by: 'popularity.desc',
            page: 1
          });
          items = data.results || [];
        }

        // /movie/upcoming includes theatrical RE-releases, whose listed release_date is the
        // original one - which is why a plain read of it surfaced 2016 films as "upcoming".
        // Keep only titles actually dated in the future, soonest first, so the list reads
        // like a release calendar.
        const today = todayIso();
        items = items
          .filter((item) => releaseDateOf(item) && releaseDateOf(item) >= today)
          .sort((a, b) => releaseDateOf(a).localeCompare(releaseDateOf(b)))
          .slice(0, 10);
        md += renderTitleTable(items, `#### ${mediaType === 'movie' ? '🎬 Movies' : '📺 TV Shows'}`);
        md += '\n';
      }
      return md;
    }

    if (action === 'search' || action === 'where_to_watch') {
      const query = params.title || params.query;
      if (!query) return 'Error: "title" parameter is required.';

      const searchType = mediaTypeParam === 'both' ? 'multi' : mediaTypeParam;
      const data = await tmdbFetch(`/search/${searchType}`, { query, page: 1 });
      const hit = (data.results || []).find((r) => r.media_type !== 'person') || (data.results || [])[0];
      if (!hit) return `No movie or TV show found matching "${query}".`;

      const mediaType = hit.media_type || (mediaTypeParam === 'both' ? 'movie' : mediaTypeParam);
      const details = await tmdbFetch(`/${mediaType}/${hit.id}`);
      const where = await watchOptions(mediaType, hit.id, region);

      let md = `### ${mediaType === 'tv' ? '📺' : '🎬'} ${titleOf(details)}\n\n`;
      md += `| Field | Value |\n| --- | --- |\n`;
      md += `| **Released** | ${releaseDateOf(details) || 'TBA'} |\n`;
      if (details.status) md += `| **Status** | ${cell(details.status)} |\n`;
      if (details.runtime) md += `| **Runtime** | ${details.runtime} min |\n`;
      if (details.number_of_seasons) md += `| **Seasons** | ${details.number_of_seasons} |\n`;
      if (details.genres?.length) md += `| **Genres** | ${cell(details.genres.map((g) => g.name).join(', '))} |\n`;
      md += `| **TMDB Rating** | ${ratingOf(details)} |\n`;
      md += `| **Where to Watch** | ${cell(where)} |\n\n`;
      if (details.overview) md += `${details.overview}\n`;

      // Reviews are opt-in because each source costs an LLM call; the agent sets this only when
      // the user actually asked whether something is worth watching.
      if (params.include_reviews) {
        const { buildSettingsForUser } = require('../utils/llm_text');
        try {
          const settings = await buildSettingsForUser(db, userId);
          md += await enrichWithReviews(settings, titleOf(details));
        } catch (err) {
          md += `\n_(Review enrichment unavailable: ${err.message})_\n`;
        }
      }

      return md;
    }

    return `Error: Unknown action "${action}" for movie_tv tool. Valid actions: whats_new, upcoming, search, where_to_watch.`;
  } catch (err) {
    return `Error: Movie/TV lookup failed: ${err.message}`;
  }
}

module.exports = {
  handleMovieTvTool,
  tmdbFetch,
  watchOptions,
  enrichWithReviews,
  fetchRedditDiscussion,
  MAJOR_US_PROVIDERS
};
