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

// Mock the shared chat-stream handler used by POST /chat-stream
const mockRunChatStream = jest.fn();
jest.mock('../services/chat_stream_handler', () => ({
  runChatStream: (...args) => mockRunChatStream(...args)
}));

// Mock command approval used by POST /approve-command
const mockResolveCommand = jest.fn();
jest.mock('../utils/commandApproval', () => ({
  resolveCommand: (...args) => mockResolveCommand(...args)
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

  describe('GET /llm-status', () => {
    test('returns the current queue state', async () => {
      mockDb.get.mockResolvedValueOnce(undefined); // local_key check (authenticateBridge)
      mockDb.get.mockResolvedValueOnce({ id: 4, user_id: 1, node_name: 'Pi', bridge_secret: 'status-secret', node_role: 'patti_client' });

      const res = await request(app)
        .get('/api/bridge/llm-status')
        .set('Authorization', 'Bearer status-secret');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ busy: false, busyBy: null });
    });
  });

  describe('POST /chat-stream', () => {
    test('403 when the caller is not a registered PATTI client', async () => {
      mockDb.get.mockResolvedValueOnce(undefined);
      mockDb.get.mockResolvedValueOnce({ id: 4, user_id: 1, node_name: 'Sensor', bridge_secret: 'node-secret', node_role: 'node' });

      const res = await request(app)
        .post('/api/bridge/chat-stream')
        .set('Authorization', 'Bearer node-secret')
        .send({ message: 'hello' });

      expect(res.status).toBe(403);
    });

    test('400 when message is missing', async () => {
      mockDb.get.mockResolvedValueOnce(undefined);
      mockDb.get.mockResolvedValueOnce({ id: 4, user_id: 1, node_name: 'Pi', bridge_secret: 'client-secret', node_role: 'patti_client' });

      const res = await request(app)
        .post('/api/bridge/chat-stream')
        .set('Authorization', 'Bearer client-secret')
        .send({});

      expect(res.status).toBe(400);
    });

    test('streams thought/content/model_used/done events on success', async () => {
      mockDb.get.mockResolvedValueOnce(undefined); // local_key check
      mockDb.get.mockResolvedValueOnce({ id: 4, user_id: 1, node_name: 'Pi', bridge_secret: 'client-secret-2', node_role: 'patti_client' });
      mockDb.get.mockResolvedValueOnce({ provider: 'local', model_name: 'test-model' }); // user_settings lookup

      mockRunChatStream.mockImplementation(async (opts) => {
        opts.onModelUsed('test-model');
        opts.onThought('thinking...');
        opts.onContent('Hello there!');
        return { model: 'test-model' };
      });

      const res = await request(app)
        .post('/api/bridge/chat-stream')
        .set('Authorization', 'Bearer client-secret-2')
        .send({ message: 'hi' });

      expect(res.status).toBe(200);
      expect(res.text).toContain('event: model_used');
      expect(res.text).toContain('event: thought');
      expect(res.text).toContain('event: content');
      expect(res.text).toContain('Hello there!');
      expect(res.text).toContain('event: done');
      expect(mockRunChatStream).toHaveBeenCalledWith(expect.objectContaining({
        origin: 'patti_client',
        message: 'hi'
      }));
    });

    test('emits an interrupted event when the host preempts the request', async () => {
      mockDb.get.mockResolvedValueOnce(undefined);
      mockDb.get.mockResolvedValueOnce({ id: 4, user_id: 1, node_name: 'Pi', bridge_secret: 'client-secret-3', node_role: 'patti_client' });
      mockDb.get.mockResolvedValueOnce({ provider: 'local', model_name: 'test-model' });

      const err = new Error('Host interrupted your request. Please try again later.');
      err.code = 'HOST_PREEMPTED';
      mockRunChatStream.mockRejectedValueOnce(err);

      const res = await request(app)
        .post('/api/bridge/chat-stream')
        .set('Authorization', 'Bearer client-secret-3')
        .send({ message: 'hi' });

      expect(res.status).toBe(200);
      expect(res.text).toContain('event: interrupted');
      expect(res.text).toContain('Host interrupted your request');
    });

    test('emits an error event on an unexpected failure', async () => {
      mockDb.get.mockResolvedValueOnce(undefined);
      mockDb.get.mockResolvedValueOnce({ id: 4, user_id: 1, node_name: 'Pi', bridge_secret: 'client-secret-4', node_role: 'patti_client' });
      mockDb.get.mockResolvedValueOnce({ provider: 'local', model_name: 'test-model' });

      mockRunChatStream.mockRejectedValueOnce(new Error('LLM API error: 500'));

      const res = await request(app)
        .post('/api/bridge/chat-stream')
        .set('Authorization', 'Bearer client-secret-4')
        .send({ message: 'hi' });

      expect(res.status).toBe(200);
      expect(res.text).toContain('event: error');
      expect(res.text).toContain('LLM API error');
    });
  });

  describe('POST /approve-command', () => {
    test('403 when the caller is not a registered PATTI client', async () => {
      mockDb.get.mockResolvedValueOnce(undefined);
      mockDb.get.mockResolvedValueOnce({ id: 4, user_id: 1, node_name: 'Sensor', bridge_secret: 'node-secret-2', node_role: 'node' });

      const res = await request(app)
        .post('/api/bridge/approve-command')
        .set('Authorization', 'Bearer node-secret-2')
        .send({ commandId: 'abc', approved: true });

      expect(res.status).toBe(403);
    });

    test('resolves a pending command', async () => {
      mockDb.get.mockResolvedValueOnce(undefined);
      mockDb.get.mockResolvedValueOnce({ id: 4, user_id: 1, node_name: 'Pi', bridge_secret: 'approve-secret', node_role: 'patti_client' });
      mockResolveCommand.mockReturnValueOnce(true);

      const res = await request(app)
        .post('/api/bridge/approve-command')
        .set('Authorization', 'Bearer approve-secret')
        .send({ commandId: 'abc', approved: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockResolveCommand).toHaveBeenCalledWith('abc', true, undefined, undefined);
    });

    test('404 when the command is not found or already resolved', async () => {
      mockDb.get.mockResolvedValueOnce(undefined);
      mockDb.get.mockResolvedValueOnce({ id: 4, user_id: 1, node_name: 'Pi', bridge_secret: 'approve-secret-2', node_role: 'patti_client' });
      mockResolveCommand.mockReturnValueOnce(false);

      const res = await request(app)
        .post('/api/bridge/approve-command')
        .set('Authorization', 'Bearer approve-secret-2')
        .send({ commandId: 'missing', approved: false });

      expect(res.status).toBe(404);
    });
  });
});
