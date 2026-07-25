const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

let mockDb = null;
let mockFetchResponses = {};
let mockGenerateContent = jest.fn();

let mockSpawnStdoutOn = jest.fn();
let mockSpawnStderrOn = jest.fn();
let mockSpawnOn = jest.fn();
let mockSpawnKill = jest.fn();

jest.mock('child_process', () => {
  return {
    spawn: jest.fn().mockImplementation(() => {
      return {
        stdout: { on: mockSpawnStdoutOn },
        stderr: { on: mockSpawnStderrOn },
        on: mockSpawnOn,
        kill: mockSpawnKill
      };
    })
  };
});

jest.mock('@google/generative-ai', () => {
  return {
    GoogleGenerativeAI: jest.fn().mockImplementation(() => {
      return {
        getGenerativeModel: jest.fn().mockImplementation(() => {
          return {
            generateContent: mockGenerateContent
          };
        })
      };
    })
  };
});

jest.mock('../db', () => {
  return {
    getDb: async () => mockDb
  };
});

const { JWT_SECRET } = require('../middleware/auth');
const chatRouter = require('../routes/chat');
const lmstudioRouter = require('../routes/lmstudio');
const app = express();
app.use(express.json());
app.use('/api', chatRouter);
app.use('/api/lmstudio', lmstudioRouter);

describe('LM Studio and Model Selection Tests', () => {
  let token;
  const userId = 1;
  const chatId = 10;
  const originalFetch = global.fetch;

  beforeAll(() => {
    token = jwt.sign({ id: userId, username: 'testuser' }, JWT_SECRET);
  });

  beforeEach(() => {
    mockFetchResponses = {};
    global.fetch = jest.fn().mockImplementation(async (url, options = {}) => {
      const urlStr = url.toString();
      for (const pattern of Object.keys(mockFetchResponses)) {
        if (urlStr.includes(pattern)) {
          const handler = mockFetchResponses[pattern];
          return typeof handler === 'function' ? handler(urlStr, options) : handler;
        }
      }
      return { ok: true, json: async () => ({}) };
    });

    mockDb = {
      get: jest.fn().mockImplementation(async (query, params) => {
        if (query.includes('FROM chats')) {
          return { id: chatId };
        }
        if (query.includes('FROM user_settings')) {
          return {
            provider: 'local',
            model_name: 'preferred-local-model',
            local_url: 'http://localhost:1234/v1',
            local_key: 'encrypted-local-key'
          };
        }
        if (query.includes('FROM users')) {
          return { name: 'Test User' };
        }
        return null;
      }),
      all: jest.fn().mockResolvedValue([]),
      run: jest.fn().mockResolvedValue({ lastID: 1 })
    };
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  test('listLocalModels tries native /api/v1/models first, then falls back to /v1/models', async () => {
    const { listLocalModels } = require('../utils/lmstudio');
    
    // Set native endpoint to return 404, compat to return valid models
    mockFetchResponses['/api/v1/models'] = {
      ok: false,
      status: 404,
      text: async () => 'Not Found'
    };
    mockFetchResponses['/v1/models'] = {
      ok: true,
      json: async () => ({
        data: [{ id: 'model-compat-1' }]
      })
    };

    const models = await listLocalModels('http://localhost:1234/v1', 'key');
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/v1/models'), expect.any(Object));
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/v1/models'), expect.any(Object));
    expect(models).toEqual([{ id: 'model-compat-1', name: 'model-compat-1', isLoaded: false, instanceId: null }]);
  });

  test('loadLocalModel and unloadLocalModel make correct POST requests to native API', async () => {
    const { loadLocalModel, unloadLocalModel } = require('../utils/lmstudio');

    mockFetchResponses['/api/v1/models/load'] = {
      ok: true,
      json: async () => ({ status: 'loaded' })
    };
    mockFetchResponses['/api/v1/models/unload'] = {
      ok: true,
      json: async () => ({ status: 'unloaded' })
    };

    const loadRes = await loadLocalModel('http://localhost:1234/v1', 'key', 'model-1');
    expect(loadRes).toEqual({ status: 'loaded' });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/models/load'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'model-1' })
      })
    );

    const unloadRes = await unloadLocalModel('http://localhost:1234/v1', 'key', 'instance-1');
    expect(unloadRes).toEqual({ status: 'unloaded' });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/models/unload'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ instance_id: 'instance-1' })
      })
    );
  });

  test('selectBestModel local path runs selection query on currently loaded model', async () => {
    const { selectBestModel } = require('../utils/model_selector');

    mockFetchResponses['/api/v1/models'] = {
      ok: true,
      json: async () => ({
        models: [
          { id: 'model-1', loaded_instances: [{ instance_id: 'inst-1' }] },
          { id: 'model-2', loaded_instances: [] }
        ]
      })
    };

    mockFetchResponses['/chat/completions'] = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ selected_model: 'model-2', reasoning: 'better for coding' }) } }]
      })
    };

    const settings = {
      provider: 'local',
      modelName: 'model-1',
      localBaseUrl: 'http://localhost:1234/v1',
      localApiKey: 'key'
    };

    const selected = await selectBestModel(settings, 'write a react component', []);
    expect(selected).toBe('model-1');
  });

  test('selectBestModel offline strict isolation check (does not contact Google/online APIs)', async () => {
    const { selectBestModel } = require('../utils/model_selector');

    mockFetchResponses['/api/v1/models'] = {
      ok: true,
      json: async () => ({
        models: [{ id: 'model-1', loaded_instances: [{ instance_id: 'inst-1' }] }]
      })
    };

    mockFetchResponses['/chat/completions'] = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ selected_model: 'model-1', reasoning: 'keep same' }) } }]
      })
    };

    const settings = {
      provider: 'local',
      modelName: 'model-1',
      localBaseUrl: 'http://localhost:1234/v1',
      localApiKey: 'key',
      onlineKey: 'online-key'
    };

    const selected = await selectBestModel(settings, 'test query', []);
    expect(selected).toBe('model-1');

    // Confirm that no googleapis.com or online endpoints were contacted
    const calls = global.fetch.mock.calls.map(c => c[0]);
    const onlineCalls = calls.filter(url => url.includes('googleapis.com') || url.includes('openai.com'));
    expect(onlineCalls.length).toBe(0);
  });

  test('selectBestModel online path respects the configured online model', async () => {
    const { selectBestModel } = require('../utils/model_selector');

    const settings = {
      provider: 'online',
      onlineProvider: 'gemini',
      modelName: 'gemini-2.5-flash',
      onlineKey: 'test-api-key'
    };

    const selected = await selectBestModel(settings, 'design a database schema', []);
    expect(selected).toBe('gemini-2.5-flash');
  });

  test('selectBestModel online path respects the configured model even without a key', async () => {
    const { selectBestModel } = require('../utils/model_selector');

    // Case 1: Missing Key
    const settingsNoKey = {
      provider: 'online',
      onlineProvider: 'gemini',
      modelName: 'gemini-2.5-flash'
    };
    const selected1 = await selectBestModel(settingsNoKey, 'hello', []);
    expect(selected1).toBe('gemini-2.5-flash');

    // Case 2: Still respects configured model regardless of downstream API state
    const settingsError = {
      provider: 'online',
      onlineProvider: 'gemini',
      modelName: 'gemini-2.5-flash',
      onlineKey: 'test-api-key'
    };
    const selected2 = await selectBestModel(settingsError, 'hello', []);
    expect(selected2).toBe('gemini-2.5-flash');
  });

  test('LM Studio url formatting helpers handle custom host urls', async () => {
    const { listLocalModels } = require('../utils/lmstudio');
    mockFetchResponses['/api/v1/models'] = {
      ok: true,
      json: async () => ({ models: [] })
    };
    await listLocalModels('http://localhost:5000', 'key');
    expect(global.fetch).toHaveBeenCalledWith('http://localhost:5000/api/v1/models', expect.any(Object));
  });

  test('loadLocalModel and unloadLocalModel throw error when HTTP response is not ok', async () => {
    const { loadLocalModel, unloadLocalModel } = require('../utils/lmstudio');

    mockFetchResponses['/api/v1/models/load'] = {
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error'
    };
    mockFetchResponses['/api/v1/models/unload'] = {
      ok: false,
      status: 400,
      text: async () => 'Bad Request'
    };

    await expect(loadLocalModel('http://localhost:1234/v1', 'key', 'model-1')).rejects.toThrow('LM Studio HTTP 500: Internal Server Error');
    await expect(unloadLocalModel('http://localhost:1234/v1', 'key', 'instance-1')).rejects.toThrow('LM Studio HTTP 400: Bad Request');
  });

  test('selectBestModel local path falls back to loaded model when query throws or fails', async () => {
    const { selectBestModel } = require('../utils/model_selector');

    mockFetchResponses['/api/v1/models'] = {
      ok: true,
      json: async () => ({
        models: [{ id: 'model-1', loaded_instances: [{ instance_id: 'inst-1' }] }]
      })
    };

    mockFetchResponses['/chat/completions'] = jest.fn().mockRejectedValue(new Error('Connection timed out'));

    const settings = {
      provider: 'local',
      modelName: 'model-1',
      localBaseUrl: 'http://localhost:1234/v1',
      localApiKey: 'key'
    };

    const selected = await selectBestModel(settings, 'test query', []);
    expect(selected).toBe('model-1');
  });

  test('listLocalModels returns empty list when both native and compat endpoints fail', async () => {
    const { listLocalModels } = require('../utils/lmstudio');

    mockFetchResponses['/api/v1/models'] = jest.fn().mockRejectedValue(new Error('Native API down'));
    mockFetchResponses['/v1/models'] = jest.fn().mockRejectedValue(new Error('Compat API down'));

    const models = await listLocalModels('http://localhost:1234/v1', 'key');
    expect(models).toEqual([]);
  });

  test('selectBestModel local path falls back to keyword matching when response is not valid JSON', async () => {
    const { selectBestModel } = require('../utils/model_selector');

    mockFetchResponses['/api/v1/models'] = {
      ok: true,
      json: async () => ({
        models: [
          { id: 'model-1', loaded_instances: [{ instance_id: 'inst-1' }] },
          { id: 'model-2', loaded_instances: [] }
        ]
      })
    };

    mockFetchResponses['/chat/completions'] = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'This is not JSON but it mentions model-2' } }]
      })
    };

    const settings = {
      provider: 'local',
      modelName: 'model-1',
      localBaseUrl: 'http://localhost:1234/v1',
      localApiKey: 'key'
    };

    const selected = await selectBestModel(settings, 'test query', []);
    expect(selected).toBe('model-1');
  });

  test('GET /api/lmstudio/log-stream returns 403 when user is not main host', async () => {
    mockDb.get = jest.fn().mockImplementation(async (query, params) => {
      if (query.includes('user_settings')) {
        return { is_main_host: 0 };
      }
      if (query.includes('users')) {
        return { id: 1 };
      }
      return null;
    });

    const res = await request(app)
      .get('/api/lmstudio/log-stream')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Only the main host is authorized to stream logs.' });
  });

  test('GET /api/lmstudio/log-stream successfully initiates SSE stream when user is main host', async () => {
    const { spawn } = require('child_process');
    mockDb.get = jest.fn().mockImplementation(async (query, params) => {
      if (query.includes('user_settings')) {
        return { is_main_host: 1 };
      }
      if (query.includes('users')) {
        return { id: 1 };
      }
      return null;
    });

    let stdoutCallback;
    let stderrCallback;
    let errorCallback;
    let closeCallback;

    mockSpawnStdoutOn.mockImplementation((event, cb) => {
      if (event === 'data') stdoutCallback = cb;
    });
    mockSpawnStderrOn.mockImplementation((event, cb) => {
      if (event === 'data') stderrCallback = cb;
    });
    mockSpawnOn.mockImplementation((event, cb) => {
      if (event === 'error') errorCallback = cb;
      if (event === 'close') closeCallback = cb;
    });

    const sseRequest = request(app)
      .get('/api/lmstudio/log-stream')
      .set('Authorization', `Bearer ${token}`);

    const responsePromise = sseRequest.then(res => res);
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(spawn).toHaveBeenCalledWith('lms', ['log', 'stream', '--json'], expect.any(Object));

    if (stdoutCallback) {
      stdoutCallback(Buffer.from('{"level":"info","message":"Loading Gemma..."}\n'));
    }
    if (stderrCallback) {
      stderrCallback(Buffer.from('warning output'));
    }
    if (errorCallback) {
      errorCallback(new Error('Process crash'));
    }
    if (closeCallback) {
      closeCallback(0);
    }

    const res = await responsePromise;
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
  });

  test('selectBestModel silently falls back when selected model matches blocked patterns (e.g. nomic-embed-text)', async () => {
    const { selectBestModel } = require('../utils/model_selector');
    const settingsBlockedDefault = {
      provider: 'local',
      modelName: 'nomic-embed-text',
      localBaseUrl: 'http://localhost:1234/v1',
      localApiKey: 'key'
    };

    mockFetchResponses['/api/v1/models'] = {
      ok: true,
      json: async () => ({
        data: [{ id: 'model-1', object: 'model' }]
      })
    };

    const selected1 = await selectBestModel(settingsBlockedDefault, 'test query', []);
    expect(selected1).toBe('qwen2.5-coder-7b-instruct');

    const settingsNormalDefault = {
      provider: 'local',
      modelName: 'qwen2.5-coder-7b-instruct',
      localBaseUrl: 'http://localhost:1234/v1',
      localApiKey: 'key'
    };

    mockFetchResponses['/api/v1/models'] = {
      ok: true,
      json: async () => [
        { id: 'nomic-embed-text', isLoaded: true }
      ]
    };

    const selected2 = await selectBestModel(settingsNormalDefault, 'test query', []);
    expect(selected2).toBe('qwen2.5-coder-7b-instruct');
  });

  test('selectBestModel returns the configured model unchanged when not blocked', async () => {
    const { selectBestModel } = require('../utils/model_selector');
    const settings = {
      provider: 'local',
      modelName: 'qwen2.5-coder-7b-instruct',
      localBaseUrl: 'http://localhost:1234/v1',
      localApiKey: 'key'
    };

    mockFetchResponses['/api/v1/models'] = {
      ok: true,
      json: async () => [
        { id: 'qwen3.5-9b', isLoaded: true }
      ]
    };

    const selected = await selectBestModel(settings, 'test query', []);
    expect(selected).toBe('qwen2.5-coder-7b-instruct');
  });

  test('POST /api/lmstudio/clear-logs returns 403 when user is not main host', async () => {
    mockDb.get = jest.fn().mockImplementation(async (query, params) => {
      if (query.includes('user_settings')) {
        return { is_main_host: 0 };
      }
      if (query.includes('users')) {
        return { id: 1 };
      }
      return null;
    });

    const res = await request(app)
      .post('/api/lmstudio/clear-logs')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Only the main host is authorized to clear logs.' });
  });

  test('POST /api/lmstudio/clear-logs returns success when user is main host', async () => {
    mockDb.get = jest.fn().mockImplementation(async (query, params) => {
      if (query.includes('user_settings')) {
        return { is_main_host: 1 };
      }
      if (query.includes('users')) {
        return { id: 1 };
      }
      return null;
    });

    const res = await request(app)
      .post('/api/lmstudio/clear-logs')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('POST /api/lmstudio/eject-model returns 403 when user is not main host', async () => {
    mockDb.get = jest.fn().mockImplementation(async (query, params) => {
      if (query.includes('user_settings')) {
        return { is_main_host: 0 };
      }
      if (query.includes('users')) {
        return { id: 1 };
      }
      return null;
    });

    const res = await request(app)
      .post('/api/lmstudio/eject-model')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Only the main host is authorized to eject models.' });
  });

  test('POST /api/lmstudio/eject-model returns success when user is main host and model is loaded', async () => {
    mockDb.get = jest.fn().mockImplementation(async (query, params) => {
      if (query.includes('user_settings')) {
        return { 
          is_main_host: 1, 
          local_key: 'mockkey', 
          local_url: 'http://localhost:1234/v1' 
        };
      }
      if (query.includes('users')) {
        return { id: 1 };
      }
      return null;
    });

    mockFetchResponses['/api/v1/models'] = {
      ok: true,
      json: async () => ({
        models: [
          { id: 'gemma-2b', loaded_instances: [{ instance_id: 'instance-123' }] }
        ]
      })
    };
    mockFetchResponses['/api/v1/models/unload'] = {
      ok: true,
      json: async () => ({ status: 'unloaded' })
    };

    const res = await request(app)
      .post('/api/lmstudio/eject-model')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain("gemma-2b");
  });

  test('POST /api/lmstudio/eject-model returns 404 when no loaded model is found', async () => {
    mockDb.get = jest.fn().mockImplementation(async (query, params) => {
      if (query.includes('user_settings')) {
        return { 
          is_main_host: 1, 
          local_key: 'mockkey', 
          local_url: 'http://localhost:1234/v1' 
        };
      }
      if (query.includes('users')) {
        return { id: 1 };
      }
      return null;
    });

    mockFetchResponses['/api/v1/models'] = {
      ok: true,
      json: async () => ({
        models: [
          { id: 'gemma-2b', loaded_instances: [] }
        ]
      })
    };

    const res = await request(app)
      .post('/api/lmstudio/eject-model')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('No active loaded model found');
  });
});
