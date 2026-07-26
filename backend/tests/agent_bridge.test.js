const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

// Mock db
let mockDb = {
  get: jest.fn(),
  all: jest.fn(),
  run: jest.fn()
};
jest.mock('../db', () => ({
  getDb: jest.fn(() => Promise.resolve(mockDb))
}));

// Mock child_process spawn
const mockSpawn = jest.fn(() => ({ unref: jest.fn() }));
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: (...args) => mockSpawn(...args)
}));

// Mock coder tools
const mockHandleCoderTool = jest.fn();
jest.mock('../tools/coder_tools', () => ({
  handleCoderTool: (...args) => mockHandleCoderTool(...args)
}));

// Mock host machine tool
const mockHandleHostMachineTool = jest.fn();
jest.mock('../tools/host_machine_tool', () => ({
  handleHostMachineTool: (...args) => mockHandleHostMachineTool(...args)
}));

// Mock tool manager
const mockInstallTool = jest.fn(() => Promise.resolve({ version: '1.0.0' }));
const mockUninstallTool = jest.fn(() => Promise.resolve());
jest.mock('../services/tool_manager', () => ({
  installTool: (...args) => mockInstallTool(...args),
  uninstallTool: (...args) => mockUninstallTool(...args)
}));

// Mock agents
const mockRunWorkerAgent = jest.fn();
const mockRunSupervisorHandoff = jest.fn();
jest.mock('../utils/agents', () => ({
  runWorkerAgent: (...args) => mockRunWorkerAgent(...args),
  runSupervisorHandoff: (...args) => mockRunSupervisorHandoff(...args),
  AGENT_PROMPTS: {}
}));

const JWT_SECRET = 'dev_secret_key_patti_assistant_2026';
const testToken = jwt.sign({ id: 1 }, JWT_SECRET);

describe('agent_bridge.js API Endpoint Tests', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    const router = require('../routes/agent_bridge');
    app.use('/api/bridge', router);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('POST /execute: 401 if missing Authorization header', async () => {
    const res = await request(app)
      .post('/api/bridge/execute')
      .send({ action: 'system_info' });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Authorization header is required');
  });

  test('POST /execute: 401 if token is empty in header', async () => {
    const res = await request(app)
      .post('/api/bridge/execute')
      .set('Authorization', 'Bearer ')
      .send({ action: 'system_info' });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Token is required');
  });

  test('POST /execute: 403 if invalid token', async () => {
    mockDb.get.mockResolvedValueOnce(null); // No matching bridge secret either

    const res = await request(app)
      .post('/api/bridge/execute')
      .set('Authorization', 'Bearer invalid_token')
      .send({ action: 'system_info' });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Forbidden');
  });

  test('POST /execute: success via standard JWT token', async () => {
    mockDb.get.mockResolvedValueOnce({ is_main_host: 0 }); // Settings check (not main host)
    mockHandleHostMachineTool.mockResolvedValue('telemetry_report');

    const res = await request(app)
      .post('/api/bridge/execute')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ action: 'system_info' });

    expect(res.status).toBe(200);
    expect(res.body.output).toContain('System telemetry details');
  });

  test('POST /execute: success via bridge_secret', async () => {
    // 1st get (in authenticateBridge: settings):
    mockDb.get.mockResolvedValueOnce({ local_key: null });
    // 2nd get (in authenticateBridge: network_nodes): Match bridge_secret in network_nodes
    mockDb.get.mockResolvedValueOnce({ id: 4, user_id: 1, node_name: 'MainCaller', bridge_secret: 'bridge_secret_123' });
    // 3rd get (in route handler): Settings check (is_main_host = 0)
    mockDb.get.mockResolvedValueOnce({ is_main_host: 0 });
    
    mockHandleHostMachineTool.mockResolvedValue('telemetry_report');

    const res = await request(app)
      .post('/api/bridge/execute')
      .set('Authorization', 'Bearer bridge_secret_123')
      .send({ action: 'system_info' });

    expect(res.status).toBe(200);
    expect(res.body.output).toContain('System telemetry details');
  });

  test('POST /execute: success via BRIDGE_SECRET environment variable', async () => {
    process.env.BRIDGE_SECRET = 'env_secret_999';
    // 1st get (in authenticateBridge for firstUser):
    mockDb.get.mockResolvedValueOnce({ id: 1 });
    // 2nd get (in route handler): Settings check (is_main_host = 0)
    mockDb.get.mockResolvedValueOnce({ is_main_host: 0 });
    
    mockHandleHostMachineTool.mockResolvedValue('telemetry_report');

    const res = await request(app)
      .post('/api/bridge/execute')
      .set('Authorization', 'Bearer env_secret_999')
      .send({ action: 'system_info' });

    expect(res.status).toBe(200);
    expect(res.body.output).toContain('System telemetry details');
    delete process.env.BRIDGE_SECRET;
  });

  test('POST /execute: success via decrypted local_key in user_settings', async () => {
    const { encrypt } = require('../utils/crypto');
    const encryptedKey = encrypt('my_local_key_token_888');

    // 1st get (in authenticateBridge: settings):
    mockDb.get.mockResolvedValueOnce({ local_key: encryptedKey });
    // 2nd get (in authenticateBridge: firstUser):
    mockDb.get.mockResolvedValueOnce({ id: 1 });
    // 3rd get (in route handler): Settings check (is_main_host = 0)
    mockDb.get.mockResolvedValueOnce({ is_main_host: 0 });
    
    mockHandleHostMachineTool.mockResolvedValue('telemetry_report');

    const res = await request(app)
      .post('/api/bridge/execute')
      .set('Authorization', 'Bearer my_local_key_token_888')
      .send({ action: 'system_info' });

    expect(res.status).toBe(200);
    expect(res.body.output).toContain('System telemetry details');
  });

  test('POST /execute: blocks requests if target is the Parent Node (is_main_host = 1)', async () => {
    // 1st get (in authenticateBridge: settings):
    mockDb.get.mockResolvedValueOnce({ local_key: null });
    // 2nd get (in authenticateBridge: network_nodes): Authenticate via bridge_secret
    mockDb.get.mockResolvedValueOnce({ id: 4, user_id: 1, node_name: 'MainCaller', bridge_secret: 'bridge_secret_123' });
    // 3rd get (in route handler): Settings check returns is_main_host = 1 (Parent node)
    mockDb.get.mockResolvedValueOnce({ is_main_host: 1 });

    const res = await request(app)
      .post('/api/bridge/execute')
      .set('Authorization', 'Bearer bridge_secret_123')
      .send({ action: 'run_command', params: { command: 'ls' } });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Access denied: Commands cannot be routed to the Parent Node');
  });

  test('POST /execute: routes run_command to handleCoderTool', async () => {
    mockDb.get.mockResolvedValueOnce({ is_main_host: 0 });
    mockHandleCoderTool.mockResolvedValue('stdout: list of files');

    const res = await request(app)
      .post('/api/bridge/execute')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ action: 'run_command', params: { command: 'ls -la', sudo_password: 'root_password' } });

    expect(res.status).toBe(200);
    expect(mockHandleCoderTool).toHaveBeenCalledWith(
      'execute_command',
      expect.objectContaining({ command: 'ls -la', sudo_password: 'root_password' }),
      expect.any(Object)
    );
    expect(res.body.output).toBe('stdout: list of files');
  });

  test('POST /execute: routes write_file to handleCoderTool', async () => {
    mockDb.get.mockResolvedValueOnce({ is_main_host: 0 });
    mockHandleCoderTool.mockResolvedValue('Successfully wrote content');

    const res = await request(app)
      .post('/api/bridge/execute')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ action: 'write_file', params: { filePath: 'notes.txt', content: 'hello world' } });

    expect(res.status).toBe(200);
    expect(mockHandleCoderTool).toHaveBeenCalledWith(
      'write_file',
      expect.objectContaining({ filePath: 'notes.txt', content: 'hello world' })
    );
  });

  test('POST /execute: routes read_file to handleCoderTool', async () => {
    mockDb.get.mockResolvedValueOnce({ is_main_host: 0 });
    mockHandleCoderTool.mockResolvedValue('hello world content');

    const res = await request(app)
      .post('/api/bridge/execute')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ action: 'read_file', params: { filePath: 'notes.txt' } });

    expect(res.status).toBe(200);
    expect(mockHandleCoderTool).toHaveBeenCalledWith(
      'read_file',
      expect.objectContaining({ filePath: 'notes.txt' })
    );
  });

  test('POST /execute: triggers install_tool, uninstall_tool', async () => {
    mockDb.get.mockResolvedValue({ is_main_host: 0 });

    // Test install_tool
    const installRes = await request(app)
      .post('/api/bridge/execute')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ action: 'install_tool', params: { toolName: 'email_sender' } });
    expect(installRes.status).toBe(200);
    expect(installRes.body.output).toContain('Successfully installed');
    expect(mockInstallTool).toHaveBeenCalledWith('email_sender');

    // Test uninstall_tool
    const uninstallRes = await request(app)
      .post('/api/bridge/execute')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ action: 'uninstall_tool', params: { toolName: 'email_sender' } });
    expect(uninstallRes.status).toBe(200);
    expect(uninstallRes.body.output).toContain('Successfully uninstalled');
    expect(mockUninstallTool).toHaveBeenCalledWith('email_sender');
  });

  test('POST /execute: 400 on unrecognized action', async () => {
    mockDb.get.mockResolvedValueOnce({ is_main_host: 0 });

    const res = await request(app)
      .post('/api/bridge/execute')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ action: 'invalid_action' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Unknown action');
  });

  test('POST /execute: routes get_specifications to handleHostMachineTool', async () => {
    mockDb.get.mockResolvedValueOnce({ is_main_host: 0 });
    mockHandleHostMachineTool.mockResolvedValueOnce('mocked specifications report');

    const res = await request(app)
      .post('/api/bridge/execute')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ action: 'get_specifications', params: { detail: true } });

    expect(res.status).toBe(200);
    expect(res.body.output).toBe('mocked specifications report');
    expect(mockHandleHostMachineTool).toHaveBeenCalledWith('get_specifications', { detail: true }, 1);
  });

  test('POST /execute: routes get_service_status to handleHostMachineTool', async () => {
    mockDb.get.mockResolvedValueOnce({ is_main_host: 0 });
    mockHandleHostMachineTool.mockResolvedValueOnce('mocked service status');

    const res = await request(app)
      .post('/api/bridge/execute')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ action: 'get_service_status', params: { serviceName: 'test-service' } });

    expect(res.status).toBe(200);
    expect(res.body.output).toBe('mocked service status');
    expect(mockHandleHostMachineTool).toHaveBeenCalledWith('get_service_status', { serviceName: 'test-service' }, 1);
  });

  test('POST /execute: 500 on execution error exception', async () => {
    mockDb.get.mockResolvedValueOnce({ is_main_host: 0 });
    mockHandleHostMachineTool.mockRejectedValueOnce(new Error('Internal handler crash'));

    const res = await request(app)
      .post('/api/bridge/execute')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ action: 'system_info' });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Internal handler crash');
  });

  describe('GET /health endpoint and restricted mutations', () => {
    test('GET /health: returns online status and dependencies status', async () => {
      mockDb.get.mockResolvedValueOnce({ 1: 1 }); // Database check success
      mockDb.get.mockResolvedValueOnce({ local_url: 'http://localhost:1234/v1', provider: 'local' }); // Settings check

      // Mock fetch response for models check
      const mockFetchResponse = { ok: true, json: () => Promise.resolve([]) };
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue(mockFetchResponse);

      const res = await request(app).get('/api/bridge/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('online');
      expect(res.body.dependencies.database).toBe('stable');
      expect(res.body.dependencies.llm_provider).toBe('stable');

      global.fetch = originalFetch;
    });

    test('POST /execute: denies mutation actions on Main Host', async () => {
      // Mock db.get:
      // 1. authenticateBridge local_key check
      mockDb.get.mockResolvedValueOnce({ local_key: null });
      // 2. authenticateBridge node check
      mockDb.get.mockResolvedValueOnce({ id: 1, user_id: 1, bridge_secret: 'test-bridge-token' });
      // 3. is_main_host settings check
      mockDb.get.mockResolvedValueOnce({ is_main_host: 1 });

      const res = await request(app)
        .post('/api/bridge/execute')
        .set('Authorization', 'Bearer test-bridge-token')
        .send({ action: 'write_file', params: { filePath: 'test.js', content: 'alert(1)' } });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Access denied: Commands cannot be routed to the Parent Node');
    });

    test('POST /execute: successfully routes agent_step action, parsing raw_output and calling runWorkerAgent', async () => {
      mockDb.get.mockResolvedValueOnce({ is_main_host: 0 }); // Settings check (not main host)
      mockRunWorkerAgent.mockResolvedValueOnce('mocked worker agent response');

      const res = await request(app)
        .post('/api/bridge/execute')
        .set('Authorization', `Bearer ${testToken}`)
        .send({
          action: 'agent_step',
          params: {
            raw_output: '```json\n{"intent": "search", "refined_data": {"query": "weather"}, "next_action": "delegate"}\n```',
            next_agent: 'web_searcher',
            settings: { modelName: 'qwen3-8b' }
          }
        });

      expect(res.status).toBe(200);
      expect(mockRunWorkerAgent).toHaveBeenCalledWith(
        'web_searcher',
        expect.objectContaining({ modelName: 'qwen3-8b' }),
        JSON.stringify({ query: 'weather' }),
        expect.any(Object),
        1
      );
      expect(res.body.output).toBe('mocked worker agent response');
    });

    test('POST /supervisor-handoff: successfully executes supervisor routing and hands off to worker', async () => {
      const mockResult = {
        supervisor_decision: {
          intent: 'search',
          refined_data: { query: 'Seattle weather' },
          next_action: 'delegate_to_weather_expert'
        },
        worker_output: 'Sunny, 72 degrees'
      };
      mockRunSupervisorHandoff.mockResolvedValueOnce(mockResult);

      const res = await request(app)
        .post('/api/bridge/supervisor-handoff')
        .set('Authorization', `Bearer ${testToken}`)
        .send({
          userPrompt: 'what is the weather in Seattle?'
        });

      expect(res.status).toBe(200);
      expect(mockRunSupervisorHandoff).toHaveBeenCalledWith(
        'what is the weather in Seattle?',
        expect.any(Object),
        expect.any(Object),
        1
      );
      expect(res.body.success).toBe(true);
      expect(res.body.supervisor_decision.intent).toBe('search');
      expect(res.body.worker_output).toBe('Sunny, 72 degrees');
    });
  });
});
