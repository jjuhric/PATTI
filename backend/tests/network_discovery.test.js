jest.mock('os', () => {
  const actualOs = jest.requireActual('os');
  return {
    ...actualOs,
    networkInterfaces: jest.fn().mockReturnValue({
      eth0: [{ family: 'IPv4', internal: false, address: '192.168.50.10' }]
    })
  };
});

jest.mock('node-dns-sd', () => ({
  discover: jest.fn().mockResolvedValue([])
}));

// Mock net.Socket so checkTcpPort resolves instantly and deterministically per-test
let mockOpenPorts = new Set();
jest.mock('net', () => ({
  Socket: jest.fn().mockImplementation(() => {
    const listeners = {};
    return {
      setTimeout: jest.fn(),
      destroy: jest.fn(),
      connect: jest.fn().mockImplementation(function (port, ip) {
        if (mockOpenPorts.has(`${ip}:${port}`)) {
          if (listeners['connect']) listeners['connect']();
        } else {
          if (listeners['timeout']) listeners['timeout']();
        }
      }),
      on: jest.fn().mockImplementation((event, cb) => { listeners[event] = cb; })
    };
  })
}));

const { discoverAndSyncNodes } = require('../utils/network_discovery');

describe('network_discovery - discoverAndSyncNodes', () => {
  let db;
  const userId = 1;

  beforeAll(async () => {
    const { open } = require('sqlite');
    const sqlite3 = require('sqlite3');
    const fs = require('fs');
    const path = require('path');

    db = await open({ filename: ':memory:', driver: sqlite3.Database });
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await db.exec(schemaSql);
    await db.run("INSERT INTO users (username, password_hash) VALUES ('discoveryuser', 'hashed')");
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    mockOpenPorts = new Set();
    await db.run('DELETE FROM network_nodes');
    global.fetch = jest.fn().mockRejectedValue(new Error('no route to host'));
  });

  test('adds a device that answers GET /health with valid JSON', async () => {
    const targetIp = '192.168.50.77';
    mockOpenPorts.add(`${targetIp}:80`);
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url === `http://${targetIp}:80/health`) {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      return Promise.reject(new Error('no route to host'));
    });

    const nodes = await discoverAndSyncNodes(db, userId, { ports: [80] });
    const found = nodes.find(n => n.ip_address === targetIp);
    expect(found).toBeDefined();
    expect(found.device_type).toBe('Generic (Health Check)');
    expect(found.node_name).toBe(`New Device (${targetIp})`);
  }, 15000);

  test('never adds a device with no open port and no /health response', async () => {
    const nodes = await discoverAndSyncNodes(db, userId, { ports: [80] });
    expect(nodes.length).toBe(0);
  }, 15000);

  test('an open port that does not respond on /health is not added', async () => {
    const targetIp = '192.168.50.88';
    mockOpenPorts.add(`${targetIp}:80`);
    global.fetch = jest.fn().mockResolvedValue({ ok: false });

    const nodes = await discoverAndSyncNodes(db, userId, { ports: [80] });
    expect(nodes.find(n => n.ip_address === targetIp)).toBeUndefined();
  }, 15000);

  test('does not clobber a previously-renamed device on a later scan', async () => {
    const targetIp = '192.168.50.99';
    mockOpenPorts.add(`${targetIp}:80`);
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url === `http://${targetIp}:80/health`) {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      return Promise.reject(new Error('no route to host'));
    });

    await discoverAndSyncNodes(db, userId, { ports: [80] });
    await db.run("UPDATE network_nodes SET node_name = 'Garage Pi' WHERE ip_address = ?", [targetIp]);

    const nodes = await discoverAndSyncNodes(db, userId, { ports: [80] });
    const found = nodes.find(n => n.ip_address === targetIp);
    expect(found.node_name).toBe('Garage Pi');
  }, 15000);

  test('recognizes a PATTI node discovery payload on port 3000 and skips other main hosts', async () => {
    const patiIp = '192.168.50.15';
    const mainHostIp = '192.168.50.16';
    mockOpenPorts.add(`${patiIp}:3000`);
    mockOpenPorts.add(`${mainHostIp}:3000`);
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url === `http://${patiIp}:3000/api/nodes/discovery`) {
        return Promise.resolve({ ok: true, json: async () => ({ success: true, device_type: 'rpi-5-8gb', is_main_host: false }) });
      }
      if (url === `http://${mainHostIp}:3000/api/nodes/discovery`) {
        return Promise.resolve({ ok: true, json: async () => ({ success: true, device_type: 'windows', is_main_host: true }) });
      }
      return Promise.reject(new Error('no route to host'));
    });

    const nodes = await discoverAndSyncNodes(db, userId, { ports: [3000] });
    expect(nodes.find(n => n.ip_address === patiIp).device_type).toBe('RPi');
    expect(nodes.find(n => n.ip_address === mainHostIp)).toBeUndefined();
  }, 15000);
});
