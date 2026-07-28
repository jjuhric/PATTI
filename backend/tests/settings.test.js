const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

// Mock db.js
let mockTestDb = null;
let mockDbError = false;
jest.mock('../db', () => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const fs = require('fs');
  const path = require('path');

  return {
    getDb: async () => {
      if (mockDbError) throw new Error('Database error');
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

const settingsRouter = require('../routes/settings');
const { JWT_SECRET } = require('../middleware/auth');
const app = express();
app.use(express.json());
app.use('/api/settings', settingsRouter);

describe('Settings Router Tests', () => {
  let token;
  let userId;

  beforeAll(async () => {
    const { open } = require('sqlite');
    const sqlite3 = require('sqlite3');
    const fs = require('fs');
    const path = require('path');

    const db = await open({
      filename: ':memory:',
      driver: sqlite3.Database
    });
    mockTestDb = db;
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await mockTestDb.exec(schemaSql);

    const result = await db.run("INSERT INTO users (username, password_hash) VALUES ('settingsuser', 'hashed')");
    userId = result.lastID;
    token = jwt.sign({ id: userId, username: 'settingsuser' }, JWT_SECRET);
  });

  afterAll(async () => {
    if (mockTestDb) {
      await mockTestDb.close();
      mockTestDb = null;
    }
  });

  beforeEach(() => {
    mockDbError = false;
    jest.clearAllMocks();
  });

  afterEach(async () => {
    if (mockTestDb) {
      await mockTestDb.run(
        `UPDATE user_settings SET provider = 'online', online_provider = 'gemini', online_key = 'gemini_test_key', online_url = NULL, local_api_style = 'openai', local_url = 'http://localhost:1234/v1' WHERE user_id = ?`,
        [userId]
      );
    }
  });

  test('GET /api/settings - retrieves or inserts user settings', async () => {
    const res = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('user_id', userId);
    expect(res.body.provider).toBe('local');
    expect(res.body.model_name).toBe('google/gemma-4-e4b');
  });

  test('PUT /api/settings - updates user settings configurations', async () => {
    const payload = {
      provider: 'online',
      model_name: 'gemini-2.5-flash',
      online_provider: 'gemini',
      online_key: 'gemini_test_key'
    };

    const res = await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send(payload);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Settings updated successfully.' });

    // Verify GET retrieves update
    const getRes = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${token}`);

    expect(getRes.body.provider).toBe('online');
    expect(getRes.body.online_key).toBe('gemi••••••••_key');
  });

  test('GET /api/settings/local-models - success path', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'local-model-1' }, { id: 'local-model-2' }]
      })
    });

    const res = await request(app)
      .get('/api/settings/local-models')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(['local-model-1', 'local-model-2']);
  });

  test('GET /api/settings/local-models - fetch error fallback', async () => {
    global.fetch.mockRejectedValueOnce(new Error('Connection failed'));

    const res = await request(app)
      .get('/api/settings/local-models')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('google/gemma-4-e4b');
  });

  test('GET /api/settings/local-models - lm-studio style and invalid URL', async () => {
    // 1. lm-studio style success
    await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({
        provider: 'local',
        model_name: 'local-model-1',
        local_url: 'http://localhost:1234/v1',
        local_key: '',
        local_api_style: 'lm-studio'
      });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'lm-model-1' }]
      })
    });

    let res = await request(app)
      .get('/api/settings/local-models')
      .set('Authorization', `Bearer ${token}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(['lm-model-1']);

    // 2. Invalid URL path constructor throw fallback
    await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({
        provider: 'local',
        model_name: 'local-model-1',
        local_url: 'not-a-valid-url',
        local_key: '',
        local_api_style: 'openai'
      });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'fallback-url-model' }]
      })
    });

    res = await request(app)
      .get('/api/settings/local-models')
      .set('Authorization', `Bearer ${token}`);
    expect(res.statusCode).toBe(200);

    // 3. Non-ok fetch status throws error
    global.fetch.mockResolvedValueOnce({
      ok: false,
      statusText: 'Model service unavailable'
    });

    res = await request(app)
      .get('/api/settings/local-models')
      .set('Authorization', `Bearer ${token}`);
    expect(res.statusCode).toBe(200); // returns fallback array
  });

  test('GET /api/settings/online-models - custom provider fetch failure fallback', async () => {
    await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({
        provider: 'online',
        online_provider: 'custom',
        online_url: 'http://custom-model-api/v1',
        online_key: 'custom_key'
      });

    // Make fetch fail to trigger lines 183-184 database fallback
    global.fetch.mockRejectedValueOnce(new Error('Custom API error simulated'));

    const res = await request(app)
      .get('/api/settings/online-models')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
  });

  test('GET /api/settings/online-models - gemini success path', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-embedding', supportedGenerationMethods: ['embedContent'] }
        ]
      })
    });

    const res = await request(app)
      .get('/api/settings/online-models')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(['gemini-2.5-flash']);
  });

  test('GET /api/settings/online-models - gemini filters out image/tts/audio/agent-preview models', async () => {
    // Mirrors the real /v1beta/models catalog shape: chat models mixed in with
    // image (Imagen/"nano-banana"), video (Veo), music (Lyria), TTS,
    // embedding, and narrow agent-preview families that also expose
    // generateContent. Only real chat models should survive the filter.
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.0-flash-001', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-1.0-pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-pro-vision', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-3-pro-image-preview', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/nano-banana-pro-preview', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/lyria-3-pro-preview', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-robotics-er-1.5-preview', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-computer-use-preview-10-2025', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/deep-research-preview-04-2026', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemma-4-31b-it', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/aqa', supportedGenerationMethods: ['generateAnswer'] }
        ]
      })
    });

    const res = await request(app)
      .get('/api/settings/online-models')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-flash-latest']);
  });

  test('GET /api/settings/online-models - openai and custom success paths', async () => {
    // OpenAI success path
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'gpt-4o' }]
      })
    });

    // Update settings provider to openai
    await mockTestDb.run('UPDATE user_settings SET online_provider = "openai", online_key = "op_key" WHERE user_id = ?', [userId]);

    const resOpenAI = await request(app)
      .get('/api/settings/online-models')
      .set('Authorization', `Bearer ${token}`);

    expect(resOpenAI.statusCode).toBe(200);
    expect(resOpenAI.body).toContain('gpt-4o');

    // Custom success path
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'custom-model-id' }]
      })
    });

    await mockTestDb.run('UPDATE user_settings SET online_provider = "custom", online_url = "https://custom.api/v1", online_key = "cust_key" WHERE user_id = ?', [userId]);

    const resCustom = await request(app)
      .get('/api/settings/online-models')
      .set('Authorization', `Bearer ${token}`);

    expect(resCustom.statusCode).toBe(200);
    expect(resCustom.body).toContain('custom-model-id');
  });

  test('GET /api/settings/online-models - anthropic fallback path (no key)', async () => {
    await mockTestDb.run('UPDATE user_settings SET online_provider = "anthropic", online_key = NULL WHERE user_id = ?', [userId]);

    const res = await request(app)
      .get('/api/settings/online-models')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('claude-3-5-sonnet-latest');
  });

  test('GET /api/settings/online-models - anthropic live fetch success path', async () => {
    await mockTestDb.run('UPDATE user_settings SET online_provider = "anthropic", online_key = "anthropic_key" WHERE user_id = ?', [userId]);

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'claude-3-7-sonnet-latest' }, { id: 'claude-3-5-haiku-latest' }]
      })
    });

    const res = await request(app)
      .get('/api/settings/online-models')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(['claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest']);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': 'anthropic_key', 'anthropic-version': '2023-06-01' }) })
    );
  });

  test('GET /api/settings/online-models - anthropic filters out retired pre-Claude-3 models', async () => {
    await mockTestDb.run('UPDATE user_settings SET online_provider = "anthropic", online_key = "anthropic_key" WHERE user_id = ?', [userId]);

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-3-7-sonnet-latest' },
          { id: 'claude-3-5-haiku-latest' },
          { id: 'claude-2.1' },
          { id: 'claude-2.0' },
          { id: 'claude-instant-1.2' }
        ]
      })
    });

    const res = await request(app)
      .get('/api/settings/online-models')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(['claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest']);
  });

  test('GET /api/settings/online-models - anthropic live fetch failure falls back to defaults', async () => {
    await mockTestDb.run('UPDATE user_settings SET online_provider = "anthropic", online_key = "anthropic_key" WHERE user_id = ?', [userId]);

    global.fetch.mockResolvedValueOnce({ ok: false, statusText: 'Unauthorized' });

    const res = await request(app)
      .get('/api/settings/online-models')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('claude-3-5-sonnet-latest');
  });

  test('GET /api/settings/online-models - openai fetches from the OpenAI base URL, not LOCAL_LLM_URL', async () => {
    await mockTestDb.run('UPDATE user_settings SET online_provider = "openai", online_key = "op_key", online_url = NULL WHERE user_id = ?', [userId]);

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-4o' }] })
    });

    const res = await request(app)
      .get('/api/settings/online-models')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('api.openai.com'),
      expect.anything()
    );
  });

  test('GET /api/settings/online-models - fallback when API fails', async () => {
    global.fetch.mockRejectedValueOnce(new Error('API Down'));

    const res = await request(app)
      .get('/api/settings/online-models')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    // Returns default fallback list
    expect(res.body).toBeDefined();
  });

  test('PUT /api/settings/voice-mode - enables and disables without touching other settings fields', async () => {
    // Regression guard: the main PUT / is a full-object upsert where several fields overwrite
    // unconditionally rather than COALESCE-ing, so this route must do a targeted UPDATE instead
    // of reusing that handler, or toggling Voice Mode would silently reset provider/model/keys.
    const before = await request(app).get('/api/settings').set('Authorization', `Bearer ${token}`);
    const providerBefore = before.body.provider;

    let res = await request(app)
      .put('/api/settings/voice-mode')
      .set('Authorization', `Bearer ${token}`)
      .send({ enabled: true });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, voice_mode: true });

    let getRes = await request(app).get('/api/settings').set('Authorization', `Bearer ${token}`);
    expect(getRes.body.voice_mode).toBe(1);
    expect(getRes.body.provider).toBe(providerBefore);

    res = await request(app)
      .put('/api/settings/voice-mode')
      .set('Authorization', `Bearer ${token}`)
      .send({ enabled: false });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, voice_mode: false });

    getRes = await request(app).get('/api/settings').set('Authorization', `Bearer ${token}`);
    expect(getRes.body.voice_mode).toBe(0);
  });

  test('PUT /api/settings/voice-mode - creates a settings row for a user with none yet', async () => {
    const fresh = await mockTestDb.run("INSERT INTO users (username, password_hash) VALUES ('novoiceuser', 'hashed')");
    const freshToken = jwt.sign({ id: fresh.lastID, username: 'novoiceuser' }, JWT_SECRET);

    const res = await request(app)
      .put('/api/settings/voice-mode')
      .set('Authorization', `Bearer ${freshToken}`)
      .send({ enabled: true });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, voice_mode: true });

    const row = await mockTestDb.get('SELECT voice_mode FROM user_settings WHERE user_id = ?', [fresh.lastID]);
    expect(row.voice_mode).toBe(1);
  });

  test('PUT /api/settings/voice-mode - database failure returns 500', async () => {
    mockDbError = true;
    const res = await request(app)
      .put('/api/settings/voice-mode')
      .set('Authorization', `Bearer ${token}`)
      .send({ enabled: true });
    expect(res.statusCode).toBe(500);
  });

  test('error paths - database failure catches', async () => {
    mockDbError = true;

    const getRes = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${token}`);
    expect(getRes.statusCode).toBe(500);

    const putRes = await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'local' });
    expect(putRes.statusCode).toBe(500);

    const localModelsRes = await request(app)
      .get('/api/settings/local-models')
      .set('Authorization', `Bearer ${token}`);
    expect(localModelsRes.statusCode).toBe(200); // Route catch block returns defaults on failure

    const onlineModelsRes = await request(app)
      .get('/api/settings/online-models')
      .set('Authorization', `Bearer ${token}`);
    expect(onlineModelsRes.statusCode).toBe(200); // Route catch block returns defaults on failure
  });

  test('GET /api/settings/online-models - defaults when keys are null', async () => {
    // OpenAI no key
    await mockTestDb.run('UPDATE user_settings SET online_provider = "openai", online_key = NULL WHERE user_id = ?', [userId]);
    const resOpenAI = await request(app)
      .get('/api/settings/online-models')
      .set('Authorization', `Bearer ${token}`);
    expect(resOpenAI.statusCode).toBe(200);
    expect(resOpenAI.body).toContain('gpt-4o');

    // Anthropic no key
    await mockTestDb.run('UPDATE user_settings SET online_provider = "anthropic", online_key = NULL WHERE user_id = ?', [userId]);
    const resAnth = await request(app)
      .get('/api/settings/online-models')
      .set('Authorization', `Bearer ${token}`);
    expect(resAnth.statusCode).toBe(200);
    expect(resAnth.body).toContain('claude-3-5-sonnet-latest');

    // Unknown provider
    await mockTestDb.run('UPDATE user_settings SET online_provider = "unknown_prov", online_key = NULL WHERE user_id = ?', [userId]);
    const resUnknown = await request(app)
      .get('/api/settings/online-models')
      .set('Authorization', `Bearer ${token}`);
    expect(resUnknown.statusCode).toBe(200);
    expect(resUnknown.body).toEqual([]);
  });

  test('POST /api/settings/test-connection - local provider success and fail', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true });
    let res = await request(app)
      .post('/api/settings/test-connection')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'local', localUrl: 'http://localhost:1234/v1' });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    global.fetch.mockResolvedValueOnce({ ok: false, status: 500 });
    res = await request(app)
      .post('/api/settings/test-connection')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'local', localUrl: 'http://localhost:1234/v1' });
    expect(res.statusCode).toBe(400);
  });

  test('POST /api/settings/test-connection - online gemini success and fail', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true });
    let res = await request(app)
      .post('/api/settings/test-connection')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'online', onlineProvider: 'gemini', onlineKey: 'gemini_test_key' });
    expect(res.statusCode).toBe(200);

    // Missing key error
    res = await request(app)
      .post('/api/settings/test-connection')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'online', onlineProvider: 'gemini' });
    expect(res.statusCode).toBe(400);

    global.fetch.mockResolvedValueOnce({ ok: false, status: 403 });
    res = await request(app)
      .post('/api/settings/test-connection')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'online', onlineProvider: 'gemini', onlineKey: 'invalid' });
    expect(res.statusCode).toBe(400);
  });

  test('POST /api/settings/test-connection - online openai success and fail', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true });
    let res = await request(app)
      .post('/api/settings/test-connection')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'online', onlineProvider: 'openai', onlineKey: 'op_key', onlineUrl: 'https://api.openai.com/v1' });
    expect(res.statusCode).toBe(200);

    global.fetch.mockResolvedValueOnce({ ok: false, status: 401 });
    res = await request(app)
      .post('/api/settings/test-connection')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'online', onlineProvider: 'openai', onlineKey: 'invalid', onlineUrl: 'https://api.openai.com/v1' });
    expect(res.statusCode).toBe(400);
  });

  test('POST /api/settings/test-connection - online anthropic success and fail', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true });
    let res = await request(app)
      .post('/api/settings/test-connection')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'online', onlineProvider: 'anthropic', onlineKey: 'sk-ant-test' });
    expect(res.statusCode).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' }) })
    );

    // Missing key error
    res = await request(app)
      .post('/api/settings/test-connection')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'online', onlineProvider: 'anthropic' });
    expect(res.statusCode).toBe(400);

    global.fetch.mockResolvedValueOnce({ ok: false, status: 401 });
    res = await request(app)
      .post('/api/settings/test-connection')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'online', onlineProvider: 'anthropic', onlineKey: 'invalid' });
    expect(res.statusCode).toBe(400);
  });

  test('GET /api/settings includes is_setup_complete flag', async () => {
    const res = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${token}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.is_setup_complete).toBeDefined();
  });

  test('POST /api/settings/test-connection - headers with key and fetch rejection', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true });
    let res = await request(app)
      .post('/api/settings/test-connection')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'local', localUrl: 'http://localhost:1234/v1', localApiKey: 'real_secret_api_key' });
    expect(res.statusCode).toBe(200);

    // Mock fetch rejection to trigger catch block
    global.fetch.mockRejectedValueOnce(new Error('Network error on local host'));
    res = await request(app)
      .post('/api/settings/test-connection')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'local', localUrl: 'http://localhost:1234/v1' });
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toContain('Connection failed: Network error on local host');
  });
});
