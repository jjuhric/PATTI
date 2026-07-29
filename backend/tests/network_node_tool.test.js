const { handleNetworkNodeTool } = require('../tools/network_node_tool');

// Mock db
let mockDb = {
  get: jest.fn(),
  all: jest.fn(),
  run: jest.fn()
};
jest.mock('../db', () => ({
  getDb: jest.fn(() => Promise.resolve(mockDb))
}));

// commandApproval is intentionally NOT mocked - requestApproval() and
// registerPendingCommand() live in the same module and registerPendingCommand is called
// via a direct in-module reference, so mocking just one wouldn't actually intercept the
// other's internal call. Instead, tests resolve the real pending promise via
// resolveCommand(), exactly like coder_tools_approval.test.js does.
const { resolveCommand } = require('../utils/commandApproval');

// Mock coder_tools
let mockHandleCoderTool = jest.fn();
jest.mock('../tools/coder_tools', () => ({
  handleCoderTool: (...args) => mockHandleCoderTool(...args)
}));

// Mock host_machine_tool
let mockHandleHostMachineTool = jest.fn();
jest.mock('../tools/host_machine_tool', () => ({
  handleHostMachineTool: (...args) => mockHandleHostMachineTool(...args)
}));

describe('network_node_tool.js Tests', () => {
  let originalFetch;
  let mockFetch;

  beforeAll(() => {
    originalFetch = global.fetch;
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('list_network_nodes: empty list', async () => {
    mockDb.all.mockResolvedValueOnce([]);
    const res = await handleNetworkNodeTool('list_network_nodes', {}, { userId: 1 });
    expect(res).toContain('No remote network nodes registered');
  });

  test('list_network_nodes: success list', async () => {
    mockDb.all.mockResolvedValueOnce([
      { id: 1, node_name: 'PiNode', device_type: 'rpi-5-8gb', ip_address: '192.168.1.100', port: 3000, is_online: 1 }
    ]);
    const res = await handleNetworkNodeTool('list_network_nodes', {}, { userId: 1 });
    expect(res).toContain('PiNode');
    expect(res).toContain('192.168.1.100');
  });

  test('remote_node_bridge: error missing params', async () => {
    let res = await handleNetworkNodeTool('remote_node_bridge', {}, { userId: 1 });
    expect(res).toContain('Error: "nodeId" is required');

    res = await handleNetworkNodeTool('remote_node_bridge', { nodeId: 1 }, { userId: 1 });
    expect(res).toContain('Error: "action" is required');
  });

  test('remote_node_bridge: node not found', async () => {
    mockDb.get.mockResolvedValueOnce(null);
    const res = await handleNetworkNodeTool('remote_node_bridge', { nodeId: 1, action: 'system_info' }, { userId: 1 });
    expect(res).toContain('Error: Node with ID 1 not found');
  });

  test('remote_node_bridge: routes main host actions locally via coder tools', async () => {
    mockDb.get.mockResolvedValueOnce({ id: 1, node_name: 'Parent', is_main_host: 1 });
    mockHandleCoderTool.mockResolvedValueOnce('Local command execution output');

    const res = await handleNetworkNodeTool(
      'remote_node_bridge', 
      { nodeId: 1, action: 'run_command', actionParams: { command: 'echo "hello"' } }, 
      { userId: 1 }
    );
    expect(mockHandleCoderTool).toHaveBeenCalledWith('execute_command', { command: 'echo "hello"' }, expect.any(Object));
    expect(res).toBe('Local command execution output');
  });

  test('remote_node_bridge: runs sudo command and handles approval success', async () => {
    mockDb.get.mockResolvedValueOnce({ id: 2, node_name: 'RPi5', is_main_host: 0, ip_address: '192.168.1.101', port: 3000, bridge_secret: 'secret123' });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ output: 'Command executed remotely' })
    });

    // Simulates the real /approve-command REST round-trip resolving the pending
    // promise requestApproval() is awaiting inside network_node_tool.js.
    const onCommandApprovalRequired = jest.fn((evt) => {
      setTimeout(() => resolveCommand(evt.commandId, true, undefined, 'sudo_password_123'), 0);
    });

    const res = await handleNetworkNodeTool(
      'remote_node_bridge',
      { nodeId: 2, action: 'run_command', actionParams: { command: 'sudo apt update' } },
      { userId: 1, onCommandApprovalRequired }
    );

    expect(onCommandApprovalRequired).toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledWith(
      'http://192.168.1.101:3000/api/bridge/execute',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer secret123'
        }
      })
    );
    expect(res).toContain('Command executed remotely');
  });

  test('remote_node_bridge: handles sudo command approval rejection', async () => {
    mockDb.get.mockResolvedValueOnce({ id: 2, node_name: 'RPi5', is_main_host: 0, ip_address: '192.168.1.101', port: 3000, bridge_secret: 'secret123' });

    const onCommandApprovalRequired = jest.fn((evt) => {
      setTimeout(() => resolveCommand(evt.commandId, false), 0);
    });

    const res = await handleNetworkNodeTool(
      'remote_node_bridge',
      { nodeId: 2, action: 'run_command', actionParams: { command: 'sudo apt update' } },
      { userId: 1, onCommandApprovalRequired }
    );

    expect(onCommandApprovalRequired).toHaveBeenCalled();
    expect(res).toContain('Command execution rejected by user');
  });

  test('remote_node_bridge: error on remote API fail', async () => {
    mockDb.get.mockResolvedValueOnce({ id: 2, node_name: 'RPi5', is_main_host: 0, ip_address: '192.168.1.101', port: 3000, bridge_secret: 'secret123' });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal error occurred')
    });

    const res = await handleNetworkNodeTool(
      'remote_node_bridge',
      { nodeId: 2, action: 'system_info' },
      { userId: 1 }
    );

    expect(res).toContain('Error: Remote execution failed with status 500');
  });

  test('list_network_nodes: database error handling', async () => {
    mockDb.all.mockRejectedValueOnce(new Error('DB Query Failed'));
    const res = await handleNetworkNodeTool('list_network_nodes', {}, { userId: 1 });
    expect(res).toContain('Error listing network nodes: DB Query Failed');
  });

  test('remote_node_bridge: uses process.env.BRIDGE_SECRET fallback', async () => {
    mockDb.get.mockResolvedValueOnce({ id: 3, node_name: 'RPi-Fallback', is_main_host: 0, ip_address: '192.168.1.102', port: 3000, bridge_secret: null });
    process.env.BRIDGE_SECRET = 'env_secret_123';

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ output: 'Env secret worked' })
    });

    const res = await handleNetworkNodeTool('remote_node_bridge', { nodeId: 3, action: 'system_info' }, { userId: 1 });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer env_secret_123'
        })
      })
    );
    expect(res).toContain('Env secret worked');
    delete process.env.BRIDGE_SECRET;
  });

  test('remote_node_bridge: uses local_key from settings fallback', async () => {
    mockDb.get
      .mockResolvedValueOnce({ id: 3, node_name: 'RPi-Fallback', is_main_host: 0, ip_address: '192.168.1.102', port: 3000, bridge_secret: null }) // select node
      .mockResolvedValueOnce({ local_key: 'settings_key_123' }); // select local_key
    
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ output: 'Settings key worked' })
    });

    const res = await handleNetworkNodeTool('remote_node_bridge', { nodeId: 3, action: 'system_info' }, { userId: 1 });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer settings_key_123'
        })
      })
    );
    expect(res).toContain('Settings key worked');
  });

  test('remote_node_bridge: handles fetch connection errors', async () => {
    mockDb.get.mockResolvedValueOnce({ id: 3, node_name: 'RPi-Fail', is_main_host: 0, ip_address: '192.168.1.103', port: 3000, bridge_secret: 'some_key' });
    mockFetch.mockRejectedValueOnce(new Error('Connection timed out'));

    const res = await handleNetworkNodeTool('remote_node_bridge', { nodeId: 3, action: 'system_info' }, { userId: 1 });
    expect(res).toContain('Error routing command to remote node: Connection timed out');
  });

  test('remote_node_bridge: resolves node by name if nodeId is a string name', async () => {
    mockDb.get.mockResolvedValueOnce({ id: 2, node_name: 'RPi5', is_main_host: 0, ip_address: '192.168.1.101', port: 3000, bridge_secret: 'secret123' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ output: 'System info from RPi5' })
    });

    const res = await handleNetworkNodeTool(
      'remote_node_bridge', 
      { nodeId: 'RPi5', action: 'system_info' }, 
      { userId: 1 }
    );
    expect(mockDb.get).toHaveBeenCalledWith(
      expect.stringContaining('WHERE LOWER(node_name) = ?'),
      ['rpi5', 1]
    );
    expect(res).toContain('System info from RPi5');
  });

  test('remote_node_bridge: resolves node by name if nodeId is a string name and strictly resolves numeric ID', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockDb.get.mockResolvedValueOnce({ id: 2, node_name: 'RPi5', is_main_host: 0, ip_address: '192.168.1.101', port: 3000, bridge_secret: 'secret123' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ output: 'System info from RPi5' })
    });

    const res = await handleNetworkNodeTool(
      'remote_node_bridge', 
      { nodeId: 'RPi5', action: 'system_info' }, 
      { userId: 1 }
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Resolved NodeId: "RPi5" matches Node: "RPi5" [ID: 2]'));
    logSpy.mockRestore();
  });

  test('handleNetworkNodeTool: error on unknown tool action', async () => {
    const res = await handleNetworkNodeTool('invalid_tool_action', {}, { userId: 1 });
    expect(res).toContain('Error: Unknown network node tool action');
  });
});
