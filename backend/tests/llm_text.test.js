const fs = require('fs');
const path = require('path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { encrypt } = require('../utils/crypto');
const { generateText, buildSettingsForUser } = require('../utils/llm_text');

describe('buildSettingsForUser', () => {
  let db;
  let userId;

  beforeAll(async () => {
    db = await open({ filename: ':memory:', driver: sqlite3.Database });
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await db.exec(schemaSql);

    const result = await db.run("INSERT INTO users (username, password_hash) VALUES ('llmtextuser', 'hashed')");
    userId = result.lastID;
    await db.run(
      `INSERT INTO user_settings (user_id, provider, model_name, local_url, local_api_style, local_key)
       VALUES (?, 'local', 'test-model', 'http://localhost:1234/v1', 'openai', ?)`,
      [userId, encrypt('lm-studio')]
    );
  });

  afterAll(async () => {
    await db.close();
  });

  test('throws when the user has no settings row', async () => {
    await expect(buildSettingsForUser(db, 999999)).rejects.toThrow('User settings not found.');
  });

  test('returns a decrypted settings object for an existing user', async () => {
    const settings = await buildSettingsForUser(db, userId);
    expect(settings.provider).toBe('local');
    expect(settings.modelName).toBe('test-model');
    expect(settings.localBaseUrl).toBe('http://localhost:1234/v1');
    expect(settings.localApiKey).toBe('lm-studio');
    expect(settings.db).toBe(db);
    expect(settings.userId).toBe(userId);
  });
});

describe('generateText', () => {
  const baseSettings = {
    provider: 'local',
    modelName: 'test-model',
    localBaseUrl: 'http://localhost:1234/v1',
    localApiKey: 'lm-studio',
    localApiStyle: 'openai'
  };

  afterEach(() => {
    delete global.fetch;
  });

  test('sends an openai-style chat completion request and returns trimmed text', async () => {
    global.fetch = jest.fn(async (url, options) => {
      expect(url).toBe('http://localhost:1234/v1/chat/completions');
      const body = JSON.parse(options.body);
      expect(body.model).toBe('test-model');
      expect(body.messages).toEqual([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'user' }
      ]);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '  Hello there.  ' } }] }) };
    });

    const result = await generateText(baseSettings, 'sys', 'user');
    expect(result).toBe('Hello there.');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('uses anthropic-style headers and message shape for an anthropic provider', async () => {
    const settings = {
      provider: 'online',
      onlineProvider: 'anthropic',
      onlineKey: 'sk-ant-test',
      modelName: 'claude-test',
      onlineUrl: 'https://api.anthropic.com'
    };

    global.fetch = jest.fn(async (url, options) => {
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect(options.headers['x-api-key']).toBe('sk-ant-test');
      expect(options.headers['anthropic-version']).toBeDefined();
      const body = JSON.parse(options.body);
      expect(body.system).toBe('sys');
      expect(body.messages).toEqual([{ role: 'user', content: 'user' }]);
      return { ok: true, json: async () => ({ content: [{ text: 'Claude says hi.' }] }) };
    });

    const result = await generateText(settings, 'sys', 'user');
    expect(result).toBe('Claude says hi.');
  });

  test('retries on failure and succeeds on a later attempt', async () => {
    let callCount = 0;
    global.fetch = jest.fn(async () => {
      callCount++;
      if (callCount < 3) {
        return { ok: false, status: 500, text: async () => 'server error' };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Third time lucky.' } }] }) };
    });

    const result = await generateText(baseSettings, 'sys', 'user');
    expect(result).toBe('Third time lucky.');
    expect(callCount).toBe(3);
  }, 15000);

  test('throws the last error after exhausting all retry attempts', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => 'still broken' }));

    await expect(generateText(baseSettings, 'sys', 'user')).rejects.toThrow(/LLM error: 500/);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  }, 15000);

  test('strips <think> reasoning blocks from the returned text', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '<think>internal reasoning</think>Final answer.' } }] })
    }));

    const result = await generateText(baseSettings, 'sys', 'user');
    expect(result).toBe('Final answer.');
  });
});
