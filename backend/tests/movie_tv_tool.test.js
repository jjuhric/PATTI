const { handleMovieTvTool } = require('../tools/movie_tv_tool');

global.fetch = jest.fn();

const json = (body) => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => body });

const ORIGINAL_KEY = process.env.TMDB_API_KEY;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.TMDB_API_KEY = 'test-token';
});

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.TMDB_API_KEY;
  else process.env.TMDB_API_KEY = ORIGINAL_KEY;
});

const futureDate = () => {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().split('T')[0];
};

describe('movie_tv tool - configuration', () => {
  test('reports a missing TMDB key plainly instead of failing silently', async () => {
    delete process.env.TMDB_API_KEY;
    const result = await handleMovieTvTool(null, null, 'upcoming', {});
    expect(result).toContain('TMDB_API_KEY is not configured');
  });

  test('authenticates with a Bearer header, not an api_key query parameter', async () => {
    global.fetch.mockResolvedValue(json({ results: [] }));
    await handleMovieTvTool(null, null, 'upcoming', { media_type: 'movie' });

    const [calledUrl, options] = global.fetch.mock.calls[0];
    expect(options.headers.Authorization).toBe('Bearer test-token');
    expect(calledUrl).not.toContain('api_key=');
  });

  test('rejects an unknown action', async () => {
    const result = await handleMovieTvTool(null, null, 'not_a_real_action', {});
    expect(result).toContain('Unknown action');
  });

  test('surfaces a TMDB API failure as an error string', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 401, headers: { get: () => 'application/json' } });
    const result = await handleMovieTvTool(null, null, 'upcoming', { media_type: 'movie' });
    expect(result).toContain('Movie/TV lookup failed');
    expect(result).toContain('401');
  });
});

describe('movie_tv tool - whats_new', () => {
  test('lists titles with the service each one streams on', async () => {
    global.fetch
      .mockResolvedValueOnce(json({
        results: [{ id: 1, title: 'Test Film', release_date: '2026-07-20', vote_average: 7.5, vote_count: 100, overview: 'A film.' }]
      }))
      .mockResolvedValueOnce(json({
        results: { US: { flatrate: [{ provider_name: 'Netflix' }], rent: [{ provider_name: 'Apple TV' }] } }
      }));

    const result = await handleMovieTvTool(null, null, 'whats_new', { media_type: 'movie', days: 30 });
    expect(result).toContain('New on Streaming (last 30 days, US)');
    expect(result).toContain('Test Film');
    expect(result).toContain('Netflix');
  });

  test('never emits a raw pipe inside a table cell', async () => {
    global.fetch
      .mockResolvedValueOnce(json({
        results: [{ id: 1, title: 'Piped | Title', release_date: '2026-07-20', vote_average: 7, vote_count: 5, overview: 'Has | pipes' }]
      }))
      .mockResolvedValueOnce(json({
        results: { US: { flatrate: [{ provider_name: 'Netflix' }], rent: [{ provider_name: 'Apple TV' }], buy: [{ provider_name: 'Amazon' }] } }
      }));

    const result = await handleMovieTvTool(null, null, 'whats_new', { media_type: 'movie' });
    const dataRow = result.split('\n').find((line) => line.includes('Piped'));
    // 4 columns means exactly 5 pipes: leading, 3 separators, trailing.
    expect(dataRow.split('|')).toHaveLength(6);
    expect(dataRow).toContain('Streaming: Netflix • Rent: Apple TV • Buy: Amazon');
  });

  test('handles a title with no streaming availability', async () => {
    global.fetch
      .mockResolvedValueOnce(json({ results: [{ id: 2, title: 'Obscure', release_date: '2026-07-01', overview: 'x' }] }))
      .mockResolvedValueOnce(json({ results: {} }));

    const result = await handleMovieTvTool(null, null, 'whats_new', { media_type: 'movie' });
    expect(result).toContain('No streaming options listed for this region');
  });
});

describe('movie_tv tool - upcoming', () => {
  test('excludes re-releases whose release date is in the past', async () => {
    global.fetch.mockResolvedValueOnce(json({
      results: [
        { id: 10, title: 'Old Re-release', release_date: '2016-12-09', overview: 'classic' },
        { id: 11, title: 'Genuinely Upcoming', release_date: futureDate(), overview: 'new' }
      ]
    }));

    const result = await handleMovieTvTool(null, null, 'upcoming', { media_type: 'movie' });
    expect(result).toContain('Genuinely Upcoming');
    expect(result).not.toContain('Old Re-release');
  });

  test('orders upcoming titles soonest first', async () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 5);
    const later = new Date();
    later.setDate(later.getDate() + 90);

    global.fetch.mockResolvedValueOnce(json({
      results: [
        { id: 20, title: 'Later Film', release_date: later.toISOString().split('T')[0], overview: 'b' },
        { id: 21, title: 'Sooner Film', release_date: soon.toISOString().split('T')[0], overview: 'a' }
      ]
    }));

    const result = await handleMovieTvTool(null, null, 'upcoming', { media_type: 'movie' });
    expect(result.indexOf('Sooner Film')).toBeLessThan(result.indexOf('Later Film'));
  });
});

describe('movie_tv tool - search', () => {
  const searchMocks = () => {
    global.fetch
      .mockResolvedValueOnce(json({ results: [{ id: 42, media_type: 'movie', title: 'Found Film' }] }))
      .mockResolvedValueOnce(json({
        id: 42,
        title: 'Found Film',
        release_date: '2026-03-01',
        status: 'Released',
        runtime: 120,
        genres: [{ name: 'Drama' }],
        vote_average: 8.2,
        vote_count: 500,
        overview: 'Synopsis here.'
      }))
      .mockResolvedValueOnce(json({ results: { US: { flatrate: [{ provider_name: 'Max' }] } } }));
  };

  test('returns details plus where to watch', async () => {
    searchMocks();
    const result = await handleMovieTvTool(null, null, 'search', { title: 'Found Film' });
    expect(result).toContain('Found Film');
    expect(result).toContain('2026-03-01');
    expect(result).toContain('8.2/10');
    expect(result).toContain('Max');
    expect(result).toContain('Synopsis here.');
  });

  test('requires a title', async () => {
    const result = await handleMovieTvTool(null, null, 'search', {});
    expect(result).toContain('"title" parameter is required');
  });

  test('reports when nothing matches', async () => {
    global.fetch.mockResolvedValueOnce(json({ results: [] }));
    const result = await handleMovieTvTool(null, null, 'search', { title: 'zzzz' });
    expect(result).toContain('No movie or TV show found');
  });

  test('skips review enrichment unless it is explicitly requested', async () => {
    searchMocks();
    await handleMovieTvTool(null, null, 'search', { title: 'Found Film' });
    // Only the three TMDB calls - no Rotten Tomatoes or Reddit traffic.
    expect(global.fetch).toHaveBeenCalledTimes(3);
    const hosts = global.fetch.mock.calls.map(([url]) => new URL(url).host);
    expect(hosts.every((h) => h === 'api.themoviedb.org')).toBe(true);
  });
});
