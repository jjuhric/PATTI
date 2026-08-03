const request = require('supertest');
const express = require('express');

jest.mock('../utils/network_discovery', () => ({
  checkTcpPort: jest.fn(),
  discoverAndSyncNodes: jest.fn()
}));

const nodesRouter = require('../routes/nodes');
const authMiddleware = require('../middleware/auth');
const dbModule = require('../db');
const { discoverAndSyncNodes } = require('../utils/network_discovery');

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 1, username: 'testuser' };
    next();
  }
}));

jest.mock('../db', () => {
  const mDb = {
    all: jest.fn(),
    get: jest.fn(),
    run: jest.fn()
  };
  return { getDb: jest.fn(() => Promise.resolve(mDb)) };
});

jest.mock('../tools/esp32_tool', () => ({
  handleEsp32Tool: jest.fn()
}));

jest.mock('../services/node_health_service', () => ({
  checkNodeHealth: jest.fn()
}));

jest.mock('bcryptjs', () => ({
  compare: jest.fn()
}));
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json());
app.use('/api/nodes', nodesRouter);

describe('Nodes API', () => {
  let mockDb;

  beforeEach(async () => {
    mockDb = await dbModule.getDb();
    jest.clearAllMocks();
  });

  test('GET /api/nodes returns nodes list', async () => {
    mockDb.all.mockResolvedValueOnce([{ id: 1, node_name: 'Pi Node', is_online: 1, ssh_username: null, ssh_password: null, ssh_key: null }]);
    const res = await request(app).get('/api/nodes');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 1, node_name: 'Pi Node', is_online: 1, ssh_username: null, ssh_password: '', ssh_key: '' }]);
    expect(mockDb.all).toHaveBeenCalledWith(expect.any(String), [1]);
  });

  test('GET /api/nodes handles database error', async () => {
    mockDb.all.mockRejectedValueOnce(new Error('DB read error'));
    const res = await request(app).get('/api/nodes');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('DB read error');
  });

  test('POST /api/nodes adds a node', async () => {
    mockDb.run.mockResolvedValueOnce({ lastID: 2 });
    const res = await request(app).post('/api/nodes').send({
      node_name: 'ESP32 Sensor',
      device_type: 'esp32-wroom',
      ip_address: '192.168.1.100',
      port: 80
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.id).toBe(2);
  });

  test('POST /api/nodes stores mqtt_topic when provided', async () => {
    mockDb.run.mockResolvedValueOnce({ lastID: 3 });
    const res = await request(app).post('/api/nodes').send({
      node_name: 'ESP32 Sensor',
      device_type: 'esp32-wroom',
      ip_address: '192.168.1.100',
      port: 80,
      mqtt_topic: ' esp32_a1b2c3d4e5f6 '
    });
    expect(res.status).toBe(200);
    const insertCall = mockDb.run.mock.calls[0];
    expect(insertCall[1]).toContain('esp32_a1b2c3d4e5f6');
  });

  test('POST /api/nodes validation fails if parameters missing', async () => {
    const res = await request(app).post('/api/nodes').send({
      node_name: 'ESP32 Sensor'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('required');
  });

  test('POST /api/nodes handles database error', async () => {
    mockDb.run.mockRejectedValueOnce(new Error('DB write error'));
    const res = await request(app).post('/api/nodes').send({
      node_name: 'ESP32 Sensor',
      device_type: 'esp32-wroom',
      ip_address: '192.168.1.100'
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('DB write error');
  });

  test('PUT /api/nodes/:id updates a node', async () => {
    mockDb.run.mockResolvedValueOnce();
    const res = await request(app).put('/api/nodes/1').send({
      node_name: 'New Node Name',
      device_type: 'rpi-5',
      ip_address: '192.168.1.101',
      port: 8080,
      is_online: 1
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('PUT /api/nodes/:id handles database error', async () => {
    mockDb.run.mockRejectedValueOnce(new Error('DB update error'));
    const res = await request(app).put('/api/nodes/1').send({
      node_name: 'New Node Name',
      device_type: 'rpi-5',
      ip_address: '192.168.1.101',
      port: 8080,
      is_online: 1
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('DB update error');
  });

  test('DELETE /api/nodes/:id deletes a node', async () => {
    mockDb.run.mockResolvedValueOnce();
    const res = await request(app).delete('/api/nodes/1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('DELETE /api/nodes/:id handles database error', async () => {
    mockDb.run.mockRejectedValueOnce(new Error('DB delete error'));
    const res = await request(app).delete('/api/nodes/1');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('DB delete error');
  });

  test('POST /api/nodes/:id/ping updates status', async () => {
    mockDb.run.mockResolvedValueOnce();
    const res = await request(app).post('/api/nodes/1/ping');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('POST /api/nodes/:id/ping handles database error', async () => {
    mockDb.run.mockRejectedValueOnce(new Error('DB ping error'));
    const res = await request(app).post('/api/nodes/1/ping');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('DB ping error');
  });

  test('GET /api/nodes/discovery returns node specifications', async () => {
    mockDb.get.mockResolvedValueOnce({ device_type: 'rpi-5-8gb', is_main_host: 0 });
    const res = await request(app).get('/api/nodes/discovery');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.device_type).toBe('rpi-5-8gb');
    expect(res.body.is_main_host).toBe(false);
  });

  test('GET /api/nodes/discovery handles database error', async () => {
    mockDb.get.mockRejectedValueOnce(new Error('DB read settings error'));
    const res = await request(app).get('/api/nodes/discovery');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('DB read settings error');
  });

  test('POST /api/nodes/scan delegates to discoverAndSyncNodes and returns its result', async () => {
    discoverAndSyncNodes.mockResolvedValueOnce([
      { id: 1, node_name: 'Raspberry Pi', device_type: 'RPi', ip_address: '192.168.10.2', port: 3000 }
    ]);

    const res = await request(app).post('/api/nodes/scan');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.nodes.length).toBe(1);
    expect(res.body.nodes[0].ip_address).toBe('192.168.10.2');
    expect(discoverAndSyncNodes).toHaveBeenCalledWith(mockDb, 1);
  });

  test('POST /api/nodes/scan returns an empty list when nothing is discovered', async () => {
    discoverAndSyncNodes.mockResolvedValueOnce([]);

    const res = await request(app).post('/api/nodes/scan');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.nodes).toEqual([]);
  });

  test('POST /api/nodes/scan handles failure errors', async () => {
    discoverAndSyncNodes.mockRejectedValueOnce(new Error('Scan failed'));

    const res = await request(app).post('/api/nodes/scan');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Scan failed');
  });

  test('POST /api/nodes/sync delegates to the same discoverAndSyncNodes helper', async () => {
    discoverAndSyncNodes.mockResolvedValueOnce([
      { id: 2, node_name: 'Living Room Speaker', device_type: 'google_home', ip_address: '192.168.10.9', port: 8009 }
    ]);

    const res = await request(app).post('/api/nodes/sync');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.nodes.length).toBe(1);
    expect(discoverAndSyncNodes).toHaveBeenCalledWith(mockDb, 1);
  });

  describe('GET /api/nodes/health-check', () => {
    const { checkNodeHealth } = require('../services/node_health_service');

    test('delegates to the shared checkNodeHealth helper and updates is_online per node', async () => {
      mockDb.all.mockResolvedValueOnce([
        { id: 1, ip_address: '192.168.1.10', port: 3000, device_type: 'rpi-5-8gb', mqtt_topic: null },
        { id: 2, ip_address: '192.168.1.11', port: 80, device_type: 'esp32-wroom', mqtt_topic: 'esp32_aabbcc' }
      ]);
      checkNodeHealth.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      mockDb.run.mockResolvedValue();

      const res = await request(app).get('/api/nodes/health-check');

      expect(res.status).toBe(200);
      expect(res.body[1].status).toBe('online');
      expect(res.body[2].status).toBe('offline');
      expect(checkNodeHealth).toHaveBeenCalledTimes(2);
    });

    test('handles database error', async () => {
      mockDb.all.mockRejectedValueOnce(new Error('DB read error'));
      const res = await request(app).get('/api/nodes/health-check');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('DB read error');
    });
  });

  describe('POST /api/nodes/toggle-screen', () => {
    const { handleEsp32Tool } = require('../tools/esp32_tool');

    test('returns 400 when ip_address is missing', async () => {
      const res = await request(app).post('/api/nodes/toggle-screen').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('ip_address is required');
    });

    test('toggles the screen successfully', async () => {
      handleEsp32Tool.mockResolvedValueOnce(JSON.stringify({ success: true, screen: 'on' }));

      const res = await request(app)
        .post('/api/nodes/toggle-screen')
        .send({ ip_address: '192.168.1.100' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, data: { success: true, screen: 'on' } });
      expect(handleEsp32Tool).toHaveBeenCalledWith('192.168.1.100', null, 'toggle_screen', {});
    });

    test('returns 500 when the device is unreachable', async () => {
      handleEsp32Tool.mockResolvedValueOnce('Failed to communicate with ESP32 at 192.168.1.100: connect ECONNREFUSED');

      const res = await request(app)
        .post('/api/nodes/toggle-screen')
        .send({ ip_address: '192.168.1.100' });

      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('Failed to communicate');
    });

    test('returns 500 when the device tool throws', async () => {
      handleEsp32Tool.mockRejectedValueOnce(new Error('unexpected failure'));

      const res = await request(app)
        .post('/api/nodes/toggle-screen')
        .send({ ip_address: '192.168.1.100' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('unexpected failure');
    });
  });

  describe('POST /api/nodes/register-client', () => {
    const validBody = {
      hostAdminUsername: 'admin',
      hostAdminPassword: 'correct-password',
      nodeName: 'Living Room Pi',
      deviceType: 'rpi-5-8gb',
      ipAddress: '192.168.1.50',
      port: 3000
    };

    test('returns 400 when required fields are missing', async () => {
      const res = await request(app).post('/api/nodes/register-client').send({ hostAdminUsername: 'admin' });
      expect(res.status).toBe(400);
    });

    test('returns 401 when the username does not exist', async () => {
      mockDb.get.mockResolvedValueOnce(null); // users lookup
      const res = await request(app).post('/api/nodes/register-client').send(validBody);
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Invalid host admin username or password');
    });

    test('returns 401 when the password does not match', async () => {
      mockDb.get.mockResolvedValueOnce({ id: 1, username: 'admin', password_hash: 'hashed' }); // users lookup
      bcrypt.compare.mockResolvedValueOnce(false);
      const res = await request(app).post('/api/nodes/register-client').send(validBody);
      expect(res.status).toBe(401);
    });

    test('returns 409 when a PATTI client is already registered and force is not set', async () => {
      mockDb.get.mockResolvedValueOnce({ id: 1, username: 'admin', password_hash: 'hashed' }); // users lookup
      bcrypt.compare.mockResolvedValueOnce(true);
      mockDb.get.mockResolvedValueOnce({ id: 5, node_name: 'Old Pi', ip_address: '192.168.1.40' }); // existing client lookup
      const res = await request(app).post('/api/nodes/register-client').send(validBody);
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('already registered');
      expect(res.body.existingClient.node_name).toBe('Old Pi');
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('replaces the existing client and succeeds when force=true', async () => {
      mockDb.get.mockResolvedValueOnce({ id: 1, username: 'admin', password_hash: 'hashed' }); // users lookup
      bcrypt.compare.mockResolvedValueOnce(true);
      mockDb.get.mockResolvedValueOnce({ id: 5, node_name: 'Old Pi', ip_address: '192.168.1.40' }); // existing client lookup
      mockDb.run.mockResolvedValueOnce({}); // delete old client
      mockDb.run.mockResolvedValueOnce({ lastID: 9 }); // insert new client

      const res = await request(app).post('/api/nodes/register-client').send({ ...validBody, force: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.nodeId).toBe(9);
      expect(typeof res.body.bridgeSecret).toBe('string');
      expect(res.body.bridgeSecret.length).toBeGreaterThan(20);
      expect(mockDb.run).toHaveBeenCalledWith('DELETE FROM network_nodes WHERE id = ?', [5]);
    });

    test('registers successfully when no PATTI client exists yet', async () => {
      mockDb.get.mockResolvedValueOnce({ id: 1, username: 'admin', password_hash: 'hashed' }); // users lookup
      bcrypt.compare.mockResolvedValueOnce(true);
      mockDb.get.mockResolvedValueOnce(null); // no existing client
      mockDb.run.mockResolvedValueOnce({ lastID: 11 });

      const res = await request(app).post('/api/nodes/register-client').send(validBody);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.nodeId).toBe(11);
      expect(res.body.hostVersion).toBeTruthy();
      const insertCall = mockDb.run.mock.calls[0];
      expect(insertCall[0]).toContain("node_role");
      expect(insertCall[0]).toContain("'patti_client'");
    });
  });
});
