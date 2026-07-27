const { handleWeatherTool } = require('../tools/weather_tool');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const fs = require('fs');
const path = require('path');

// Mock db.js
let mockTestDb = null;
jest.mock('../db', () => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const fs = require('fs');
  const path = require('path');

  return {
    getDb: async () => {
      if (mockTestDb) return mockTestDb;
      mockTestDb = await open({
        filename: ':memory:',
        driver: sqlite3.Database
      });
      const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
      await mockTestDb.exec(schemaSql);
      return mockTestDb;
    }
  };
});

// Mock global fetch
global.fetch = jest.fn();

describe('Weather Tool Tests', () => {
  let db;
  let userId;

  beforeAll(async () => {
    const { open } = require('sqlite');
    const sqlite3 = require('sqlite3');
    const fs = require('fs');
    const path = require('path');

    db = await open({
      filename: ':memory:',
      driver: sqlite3.Database
    });
    mockTestDb = db;
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await db.exec(schemaSql);

    // Seed test user with profile details
    const result = await db.run(`
      INSERT INTO users (username, password_hash, zipcode, country, temp_unit, weather_api_key)
      VALUES ('weatheruser', 'hashed', '32421', 'US', 'imperial', 'test_key')
    `);
    userId = result.lastID;
  });

  afterAll(async () => {
    if (db) {
      await db.close();
      mockTestDb = null;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('current action - geocodes and retrieves current weather successfully', async () => {
    // Mock 1: Geocoding zip lookup
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        lat: 30.9254,
        lon: -85.1278,
        name: 'Calhoun County'
      })
    });

    // Mock 2: Current weather details
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        weather: [{ description: 'clear sky' }],
        main: {
          temp: 78.5,
          feels_like: 80.0,
          temp_min: 75.0,
          temp_max: 82.0,
          humidity: 65,
          pressure: 1016,
          sea_level: 1016,
          grnd_level: 1011
        },
        wind: { speed: 5.2 },
        rain: { '1h': 0.1 }
      })
    });

    const result = await handleWeatherTool(db, userId, 'current', {});
    expect(result).toContain('Current Weather Report for **Calhoun County**');
    expect(result).toContain('78.5°F');
    expect(result).toContain('Clear sky');
    expect(result).toContain('0.1 mm');
  });

  test('hourly action - falls back to standard forecast if pro endpoint fails', async () => {
    // Mock 1: Geocoding zip lookup
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        lat: 30.9254,
        lon: -85.1278,
        name: 'Calhoun County'
      })
    });

    // Mock 2: Pro hourly forecast fails
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 401
    });

    // Mock 3: Standard 5-day / 3-hour forecast fallback succeeds
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        list: [
          {
            dt: 1661875200,
            main: { temp: 77.0, feels_like: 78.2, humidity: 82 },
            weather: [{ description: 'broken clouds' }],
            wind: { speed: 4.2 },
            dt_txt: '2026-06-30 09:00:00'
          }
        ]
      })
    });

    const result = await handleWeatherTool(db, userId, 'hourly', {});
    expect(result).toContain('Weather Forecast for **Calhoun County**');
    expect(result).toContain('77°F');
    expect(result).toContain('broken clouds');
    // When the paid hourly endpoint refuses, the data is 3-hour blocks - the heading must say
    // so rather than claiming hourly resolution.
    expect(result).toContain('3-hour intervals');
    expect(result).not.toContain('hourly)');
  });

  test('daily action - calculates daily values from standard 5-day forecast fallback', async () => {
    // Mock 1: Geocoding zip lookup
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        lat: 30.9254,
        lon: -85.1278,
        name: 'Calhoun County'
      })
    });

    // Mock 2: Daily forecast fails (401)
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 401
    });

    // Mock 3: Standard 5-day / 3-hour forecast fallback succeeds
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        list: [
          {
            dt: 1661875200,
            main: { temp: 80.0, temp_min: 75.0, temp_max: 85.0, humidity: 60 },
            weather: [{ description: 'clear sky' }],
            wind: { speed: 3.5 },
            clouds: { all: 10 },
            dt_txt: '2026-06-30 12:00:00'
          }
        ]
      })
    });

    const result = await handleWeatherTool(db, userId, 'daily', { cnt: 1 });
    expect(result).toContain('Daily Weather Forecast for **Calhoun County**');
    expect(result).toContain('80°F');
    expect(result).toContain('clear sky');
  });

  test('daily action - flags a partial day rather than reporting it as a full-day high/low', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ lat: 30.9254, lon: -85.1278, name: 'Calhoun County' })
    });
    global.fetch.mockResolvedValueOnce({ ok: false, status: 401 });

    // Only 3 blocks for the day - what "today" looks like when asked mid-afternoon. A full
    // day would be 8 blocks, so this range covers the evening only, not the real daily high.
    const partialDayBlocks = [
      { dt: 1661882400, main: { temp: 88.0, humidity: 55 }, weather: [{ description: 'scattered clouds' }], wind: { speed: 7.0 }, clouds: { all: 40 } },
      { dt: 1661893200, main: { temp: 84.0, humidity: 62 }, weather: [{ description: 'scattered clouds' }], wind: { speed: 6.0 }, clouds: { all: 45 } },
      { dt: 1661904000, main: { temp: 79.0, humidity: 70 }, weather: [{ description: 'clear sky' }], wind: { speed: 5.0 }, clouds: { all: 10 } }
    ];
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ list: partialDayBlocks })
    });

    const result = await handleWeatherTool(db, userId, 'daily', { cnt: 1 });
    expect(result).toContain('only)');
    expect(result).toContain('not the full-day high/low');
  });

  test('daily action - does not flag a complete day', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ lat: 30.9254, lon: -85.1278, name: 'Calhoun County' })
    });
    global.fetch.mockResolvedValueOnce({ ok: false, status: 401 });

    // 8 blocks at 3-hour spacing anchored to local midnight, so they all fall inside one
    // America/Chicago calendar day (05:00 UTC is 00:00 CDT). Anchoring matters: blocks that
    // straddle midnight split across two days and each partial group is correctly flagged.
    const localMidnightUtc = Date.UTC(2026, 6, 15, 5, 0, 0) / 1000;
    const fullDayBlocks = Array.from({ length: 8 }, (_, i) => ({
      dt: localMidnightUtc + i * 10800,
      main: { temp: 70 + i, humidity: 60 },
      weather: [{ description: 'clear sky' }],
      wind: { speed: 4.0 },
      clouds: { all: 5 }
    }));
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ list: fullDayBlocks })
    });

    const result = await handleWeatherTool(db, userId, 'daily', { cnt: 1 });
    expect(result).not.toContain('only)');
    expect(result).not.toContain('not the full-day high/low');
  });

  test('error path - geocoding fails', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' });
    const result = await handleWeatherTool(db, userId, 'current', { zipcode: '00000' });
    expect(result).toContain('Error: Failed to resolve coordinates');
  });

  test('error path - hourly fallback fails', async () => {
    // Mock 1: Geocoding succeeds
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ lat: 10, lon: 10, name: 'FailedCity' })
    });
    // Mock 2: Pro API fails
    global.fetch.mockResolvedValueOnce({ ok: false, status: 401 });
    // Mock 3: Standard fallback fails too
    global.fetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Bad Request' });

    const result = await handleWeatherTool(db, userId, 'hourly', {});
    expect(result).toContain('Failed to fetch hourly forecast');
  });

  test('error path - daily fallback fails', async () => {
    // Mock 1: Geocoding succeeds
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ lat: 10, lon: 10, name: 'FailedCity' })
    });
    // Mock 2: Daily API fails
    global.fetch.mockResolvedValueOnce({ ok: false, status: 401 });
    // Mock 3: Standard fallback fails
    global.fetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await handleWeatherTool(db, userId, 'daily', {});
    expect(result).toContain('Failed to fetch daily forecast');
  });

  test('error path - missing api key', async () => {
    const userRes = await db.run("INSERT INTO users (username, password_hash) VALUES ('nokeyuser', 'hashed')");
    const noKeyId = userRes.lastID;

    const result = await handleWeatherTool(db, noKeyId, 'current', {});
    expect(result).toContain('OpenWeatherMap API Key is not configured');
  });

  test('error path - missing zipcode but has key', async () => {
    const userRes = await db.run("INSERT INTO users (username, password_hash, weather_api_key) VALUES ('nozipuser', 'hashed', 'test_key')");
    const noZipId = userRes.lastID;

    const result = await handleWeatherTool(db, noZipId, 'current', {});
    expect(result).toContain('Zipcode is not configured');
  });

  test('error path - db or userId missing', async () => {
    const res1 = await handleWeatherTool(null, userId, 'current', {});
    expect(res1).toContain('Database connection and User ID are required');

    const res2 = await handleWeatherTool(db, null, 'current', {});
    expect(res2).toContain('Database connection and User ID are required');
  });

  test('error path - db query failure', async () => {
    const brokenDb = {
      get: jest.fn().mockRejectedValueOnce(new Error('Query error'))
    };
    const result = await handleWeatherTool(brokenDb, userId, 'current', {});
    expect(result).toContain('Failed to query user profile details: Query error');
  });

  test('error path - current weather fetch fails', async () => {
    // Geocode succeeds
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ lat: 10, lon: 10, name: 'FailedFetchCity' })
    });
    // Weather fetch returns ok: false
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request'
    });

    const result = await handleWeatherTool(db, userId, 'current', {});
    expect(result).toContain('Failed to query current weather: Current weather API returned status 400');
  });

  test('geocode action - retrieves and returns coordinates successfully', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        lat: 34.0522,
        lon: -118.2437,
        name: 'Los Angeles'
      })
    });

    const result = await handleWeatherTool(db, userId, 'geocode', { zipcode: '90012' });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.cityName).toBe('Los Angeles');
    expect(parsed.lat).toBe(34.0522);
    expect(parsed.lon).toBe(-118.2437);
  });

  test('forecast_5day action - retrieves 5-day / 3-hour forecast successfully with timezone formatting', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        list: [
          {
            dt: 1661875200, // Unix timestamp
            main: { temp: 75.0, feels_like: 76.5, humidity: 55 },
            weather: [{ description: 'partly cloudy' }],
            wind: { speed: 8.5 },
            clouds: { all: 40 }
          }
        ]
      })
    });

    const result = await handleWeatherTool(db, userId, 'forecast_5day', {
      lat: 34.0522,
      lon: -118.2437,
      timezone: 'UTC'
    });

    expect(result).toContain('5-Day Forecast (3-Hour Increments) for **Coordinates (34.0522, -118.2437)**');
    expect(result).toContain('75°F');
    expect(result).toContain('partly cloudy');
  });

  test('timezone fallback - formats with America/Chicago if invalid timezone passed', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        weather: [{ description: 'clear sky' }],
        main: {
          temp: 68.0,
          feels_like: 68.0,
          temp_min: 68.0,
          temp_max: 68.0,
          humidity: 40,
          pressure: 1013,
          sea_level: 1013,
          grnd_level: 1013
        },
        wind: { speed: 2.0 },
        sys: { sunrise: 1661875200, sunset: 1661918400 }
      })
    });

    const result = await handleWeatherTool(db, userId, 'current', {
      lat: 34.0522,
      lon: -118.2437,
      timezone: 'INVALID_ZONE'
    });

    expect(result).toContain('Report Time');
    expect(result).toContain('Timezone: INVALID_ZONE');
  });
});
