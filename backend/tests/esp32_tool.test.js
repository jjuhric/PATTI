const { handleEsp32Tool } = require('../tools/esp32_tool');

let mockDb = { get: jest.fn() };
jest.mock('../db', () => ({
  getDb: jest.fn(() => Promise.resolve(mockDb))
}));

jest.mock('../services/mqtt_service', () => ({
  publishAndAwaitResponse: jest.fn()
}));
const mqttService = require('../services/mqtt_service');

describe('ESP32 Tool Tests (MQTT)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns an error when no IP address is provided and no default is set', async () => {
    const result = await handleEsp32Tool(null, null, 'send_message', { message: 'hi' });
    expect(result).toContain('Error: No ESP32 IP address provided');
  });

  test('returns a clear error when no node is registered for the given IP', async () => {
    mockDb.get.mockResolvedValueOnce(null);
    const result = await handleEsp32Tool('192.168.1.117', null, 'send_message', { message: 'hi' });
    expect(result).toContain('Error:');
    expect(result).toContain('No registered node found for IP 192.168.1.117');
    expect(mqttService.publishAndAwaitResponse).not.toHaveBeenCalled();
  });

  test('returns a clear error when the registered node has no mqtt_topic configured', async () => {
    mockDb.get.mockResolvedValueOnce({ id: 1, node_name: 'Kitchen ESP32', device_type: 'esp32-wroom', mqtt_topic: null });
    const result = await handleEsp32Tool('192.168.1.117', null, 'send_message', { message: 'hi' });
    expect(result).toContain('Error:');
    expect(result).toContain('has no MQTT ID configured');
    expect(mqttService.publishAndAwaitResponse).not.toHaveBeenCalled();
  });

  test('sends a send_message command over MQTT, deriving the client ID from a bare mqtt_topic', async () => {
    mockDb.get.mockResolvedValueOnce({ id: 1, node_name: 'Kitchen ESP32', device_type: 'esp32-wroom', mqtt_topic: 'esp32_aabbcc' });
    mqttService.publishAndAwaitResponse.mockResolvedValueOnce({
      status: 'success',
      data: { success: true, displayed: false }
    });

    const result = await handleEsp32Tool('192.168.1.117', null, 'send_message', { message: 'hello' });

    expect(mqttService.publishAndAwaitResponse).toHaveBeenCalledWith('esp32_aabbcc', 'send_message', 8000, { message: 'hello' });
    expect(JSON.parse(result)).toEqual({ success: true, displayed: false });
  });

  test('derives the client ID from a full "nodes/<id>/responses"-shaped mqtt_topic', async () => {
    mockDb.get.mockResolvedValueOnce({ id: 1, node_name: 'Kitchen ESP32', device_type: 'esp32-wroom', mqtt_topic: 'nodes/esp32_aabbcc/responses' });
    mqttService.publishAndAwaitResponse.mockResolvedValueOnce({ status: 'success', data: { success: true } });

    await handleEsp32Tool('192.168.1.117', null, 'send_message', { message: 'hello' });

    expect(mqttService.publishAndAwaitResponse).toHaveBeenCalledWith('esp32_aabbcc', 'send_message', 8000, { message: 'hello' });
  });

  test('returns the firmware\'s own "not implemented" error for a command it does not support', async () => {
    mockDb.get.mockResolvedValueOnce({ id: 1, node_name: 'Kitchen ESP32', device_type: 'esp32-wroom', mqtt_topic: 'esp32_aabbcc' });
    mqttService.publishAndAwaitResponse.mockResolvedValueOnce({
      status: 'error',
      data: { error: "Command 'toggle_screen' is not implemented on this firmware." }
    });

    const result = await handleEsp32Tool('192.168.1.117', null, 'toggle_screen', {});

    expect(result).toBe("Error: Command 'toggle_screen' is not implemented on this firmware.");
  });

  test('send_message failure over MQTT returns an "Error:"-prefixed message with details', async () => {
    mockDb.get.mockResolvedValueOnce({ id: 1, node_name: 'Kitchen ESP32', device_type: 'esp32-wroom', mqtt_topic: 'esp32_aabbcc' });
    mqttService.publishAndAwaitResponse.mockRejectedValueOnce(new Error('MQTT Request Timeout after 8000ms'));

    const result = await handleEsp32Tool('192.168.1.117', null, 'send_message', { message: 'hello' });

    expect(result).toContain('Error: Failed to communicate with ESP32 at 192.168.1.117');
    expect(result).toContain('MQTT Request Timeout after 8000ms');
  });

  test('a non-send_message failure returns a message without the "Error:" prefix, matching the toggle-screen route\'s check', async () => {
    mockDb.get.mockResolvedValueOnce({ id: 1, node_name: 'Kitchen ESP32', device_type: 'esp32-wroom', mqtt_topic: 'esp32_aabbcc' });
    mqttService.publishAndAwaitResponse.mockRejectedValueOnce(new Error('MQTT Request Timeout after 8000ms'));

    const result = await handleEsp32Tool('192.168.1.117', null, 'toggle_screen', {});

    expect(result.startsWith('Error:')).toBe(false);
    expect(result).toContain('Failed to communicate with ESP32 at 192.168.1.117');
    expect(result).toContain('MQTT Request Timeout after 8000ms');
  });

  test('uses "device" instead of "ESP32" in error messages for a non-ESP32 device_type', async () => {
    mockDb.get.mockResolvedValueOnce({ id: 2, node_name: 'Living Room Pi', device_type: 'rpi-5-8gb', mqtt_topic: 'node_livingroom' });
    mqttService.publishAndAwaitResponse.mockRejectedValueOnce(new Error('offline'));

    const result = await handleEsp32Tool('192.168.1.150', null, 'toggle_screen', {});

    expect(result).toContain('Failed to communicate with device at 192.168.1.150');
  });

  test('falls back to ESP32_DEFAULT_IP when no IP is passed', async () => {
    const originalEnv = process.env.ESP32_DEFAULT_IP;
    process.env.ESP32_DEFAULT_IP = '192.168.1.200';
    mockDb.get.mockResolvedValueOnce({ id: 1, node_name: 'Default ESP32', device_type: 'esp32-wroom', mqtt_topic: 'esp32_default' });
    mqttService.publishAndAwaitResponse.mockResolvedValueOnce({ status: 'success', data: { success: true } });

    await handleEsp32Tool(null, null, 'send_message', { message: 'hi' });

    expect(mockDb.get).toHaveBeenCalledWith(expect.any(String), ['192.168.1.200']);
    process.env.ESP32_DEFAULT_IP = originalEnv;
  });
});
