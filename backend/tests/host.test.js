const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const hostMachineTool = require('../tools/host_machine_tool');

// Mock host_machine_tool
jest.mock('../tools/host_machine_tool', () => ({
  handleHostMachineTool: jest.fn()
}));

// requireAdmin (backend/middleware/adminAuth.js) checks the live is_admin flag in the DB, so
// unlike before, these routes now need a real (in-memory) DB and real JWTs for an admin and a
// non-admin user - the same pattern used in tests/admin.test.js.
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

const hostRouter = require('../routes/host');
const { JWT_SECRET } = require('../middleware/auth');

describe('Host Route Telemetry and Control Tests', () => {
  let app;
  let adminToken;
  let regularToken;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use('/api/host', hostRouter);

    const db = await mockTestDb || (await require('../db').getDb());
    const adminRes = await mockTestDb.run(
      "INSERT INTO users (username, password_hash, is_admin) VALUES ('host_admin', 'hashed', 1)"
    );
    adminToken = jwt.sign({ id: adminRes.lastID, username: 'host_admin' }, JWT_SECRET);

    const regularRes = await mockTestDb.run(
      "INSERT INTO users (username, password_hash, is_admin) VALUES ('host_regular', 'hashed', 0)"
    );
    regularToken = jwt.sign({ id: regularRes.lastID, username: 'host_regular' }, JWT_SECRET);
  });

  afterAll(async () => {
    if (mockTestDb) {
      await mockTestDb.close();
      mockTestDb = null;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('GET /api/host/status returns hardware telemetry successfully', async () => {
    hostMachineTool.handleHostMachineTool.mockImplementation((action) => {
      if (action === 'get_temperature') return Promise.resolve('42.5°C');
      if (action === 'get_power') return Promise.resolve('Power telemetry output');
      if (action === 'get_network_info') return Promise.resolve('Network info output');
      if (action === 'get_capabilities') return Promise.resolve({ deviceType: 'rpi-5', isMainHost: 0, capabilities: { gpio: true } });
      return Promise.resolve('');
    });

    const res = await request(app).get('/api/host/status').set('Authorization', `Bearer ${regularToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.cpu).toBeDefined();
    expect(res.body.memory).toBeDefined();
    expect(res.body.telemetry.temperature).toBe('42.5°C');
    expect(res.body.telemetry.power).toBe('Power telemetry output');
  });

  test('GET /api/host/status handles failure', async () => {
    hostMachineTool.handleHostMachineTool.mockRejectedValue(new Error('Telemetry failure'));
    const res = await request(app).get('/api/host/status').set('Authorization', `Bearer ${regularToken}`);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Telemetry failure');
  });

  test('POST /api/host/service/restart is blocked for a non-admin user', async () => {
    const res = await request(app)
      .post('/api/host/service/restart')
      .set('Authorization', `Bearer ${regularToken}`)
      .send({ service: 'test-service' });

    expect(res.statusCode).toBe(403);
    expect(hostMachineTool.handleHostMachineTool).not.toHaveBeenCalled();
  });

  test('POST /api/host/service/restart restarts a service for an admin', async () => {
    hostMachineTool.handleHostMachineTool.mockResolvedValue('Successfully restarted service "test-service".');
    const res = await request(app)
      .post('/api/host/service/restart')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ service: 'test-service' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('POST /api/host/service/restart handles non-success response', async () => {
    hostMachineTool.handleHostMachineTool.mockResolvedValue('Failed to restart service - systemd error.');
    const res = await request(app)
      .post('/api/host/service/restart')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ service: 'test-service' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Failed to restart service - systemd error.');
  });

  test('POST /api/host/service/restart handles throw catch block', async () => {
    hostMachineTool.handleHostMachineTool.mockRejectedValue(new Error('Restart throw error'));
    const res = await request(app)
      .post('/api/host/service/restart')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ service: 'test-service' });

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Restart throw error');
  });

  test('POST /api/host/service/restart returns 400 if service is missing', async () => {
    const res = await request(app)
      .post('/api/host/service/restart')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(res.statusCode).toBe(400);
  });

  test('POST /api/host/gpio/run is blocked for a non-admin user', async () => {
    const res = await request(app)
      .post('/api/host/gpio/run')
      .set('Authorization', `Bearer ${regularToken}`)
      .send({ scriptPath: 'script.py' });

    expect(res.statusCode).toBe(403);
    expect(hostMachineTool.handleHostMachineTool).not.toHaveBeenCalled();
  });

  test('POST /api/host/gpio/run triggers script execution for an admin', async () => {
    hostMachineTool.handleHostMachineTool.mockResolvedValue('Script output');
    const res = await request(app)
      .post('/api/host/gpio/run')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ scriptPath: 'script.py' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.output).toBe('Script output');
  });

  test('POST /api/host/gpio/run handles throw catch block', async () => {
    hostMachineTool.handleHostMachineTool.mockRejectedValue(new Error('Script throw error'));
    const res = await request(app)
      .post('/api/host/gpio/run')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ scriptPath: 'script.py' });

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Script throw error');
  });

  test('POST /api/host/gpio/run returns 400 if scriptPath is missing', async () => {
    const res = await request(app)
      .post('/api/host/gpio/run')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(res.statusCode).toBe(400);
  });
});
