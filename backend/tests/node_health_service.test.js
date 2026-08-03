let mockDb = { all: jest.fn(), run: jest.fn() };
jest.mock('../db', () => ({
  getDb: jest.fn(() => Promise.resolve(mockDb))
}));

jest.mock('../routes/alerts', () => ({
  broadcastAlert: jest.fn()
}));

jest.mock('../services/mqtt_service', () => ({
  publishAndAwaitResponse: jest.fn()
}));
const mqttService = require('../services/mqtt_service');

const { checkNodeHealth } = require('../services/node_health_service');

describe('node_health_service.js - checkNodeHealth', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('ESP32 devices', () => {
    test('routes to an MQTT round trip instead of HTTP/TCP probing, and reports healthy on success', async () => {
      mqttService.publishAndAwaitResponse.mockResolvedValueOnce({ status: 'success', data: {} });

      const isOnline = await checkNodeHealth({
        device_type: 'esp32-wroom',
        ip_address: '192.168.1.117',
        port: 80,
        mqtt_topic: 'esp32_aabbcc'
      });

      expect(isOnline).toBe(true);
      expect(mqttService.publishAndAwaitResponse).toHaveBeenCalledWith('esp32_aabbcc', 'get_system_info', 4000);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('reports unhealthy when the MQTT round trip times out - this used to be permanently unreachable via HTTP/TCP', async () => {
      mqttService.publishAndAwaitResponse.mockRejectedValueOnce(new Error('MQTT Request Timeout after 4000ms'));

      const isOnline = await checkNodeHealth({
        device_type: 'esp32-wroom',
        ip_address: '192.168.1.117',
        port: 80,
        mqtt_topic: 'esp32_aabbcc'
      });

      expect(isOnline).toBe(false);
    });

    test('reports unhealthy with no MQTT round trip attempted when mqtt_topic is unset', async () => {
      const isOnline = await checkNodeHealth({
        device_type: 'esp32-wroom',
        ip_address: '192.168.1.117',
        port: 80,
        mqtt_topic: null
      });

      expect(isOnline).toBe(false);
      expect(mqttService.publishAndAwaitResponse).not.toHaveBeenCalled();
    });

    test('detects ESP32 regardless of device_type casing/suffix (the ESP32 vs esp32-wroom mismatch)', async () => {
      mqttService.publishAndAwaitResponse.mockResolvedValueOnce({ status: 'success', data: {} });

      const isOnline = await checkNodeHealth({
        device_type: 'ESP32',
        ip_address: '192.168.1.117',
        port: 80,
        mqtt_topic: 'esp32_aabbcc'
      });

      expect(isOnline).toBe(true);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('non-ESP32 devices', () => {
    test('reports healthy via the /health endpoint', async () => {
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

      const isOnline = await checkNodeHealth({ device_type: 'rpi-5-8gb', ip_address: '192.168.1.10', port: 3000 });

      expect(isOnline).toBe(true);
    });

    test('falls back to /api/bridge/health, then a raw TCP check, when /health fails', async () => {
      global.fetch
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: true });

      const isOnline = await checkNodeHealth({ device_type: 'rpi-5-8gb', ip_address: '192.168.1.10', port: 3000 });

      expect(isOnline).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('skips the /api/bridge/health fallback for Google Assistant devices', async () => {
      global.fetch.mockResolvedValueOnce({ ok: false });

      const isOnline = await checkNodeHealth({ device_type: 'Google Assistant', ip_address: '192.168.1.20', port: 8009 });

      expect(isOnline).toBe(false);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});
