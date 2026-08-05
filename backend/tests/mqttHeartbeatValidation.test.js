const { isValidHeartbeatPayload } = require('../utils/mqttHeartbeatValidation');

describe('isValidHeartbeatPayload (SEC-7)', () => {
  test('accepts a well-formed heartbeat payload', () => {
    expect(isValidHeartbeatPayload({
      nodeId: 'esp32-livingroom_1',
      device_type: 'esp32',
      ip_address: '192.168.1.55',
      port: 80,
      os: 'micropython'
    })).toBe(true);
  });

  test('accepts a minimal payload with only nodeId', () => {
    expect(isValidHeartbeatPayload({ nodeId: 'node-1' })).toBe(true);
  });

  test.each([
    [null],
    [undefined],
    [{}],
    [{ nodeId: '' }],
    [{ nodeId: 123 }],
    [{ nodeId: 'a'.repeat(101) }],
    [{ nodeId: 'has spaces' }],
    [{ nodeId: 'has/slash' }],
    [{ nodeId: 'DROP TABLE;' }],
  ])('rejects invalid nodeId: %j', (payload) => {
    expect(isValidHeartbeatPayload(payload)).toBe(false);
  });

  test.each([
    ['not-an-ip'],
    ['999.999.999.999'],
    ['192.168.1.1; rm -rf /'],
  ])('rejects an invalid ip_address: %s', (ip_address) => {
    expect(isValidHeartbeatPayload({ nodeId: 'n1', ip_address })).toBe(false);
  });

  test('accepts a valid IPv6 ip_address', () => {
    expect(isValidHeartbeatPayload({ nodeId: 'n1', ip_address: '::1' })).toBe(true);
  });

  test.each([
    [0],
    [-1],
    [65536],
    ['not-a-port'],
    [3.5],
  ])('rejects an invalid port: %j', (port) => {
    expect(isValidHeartbeatPayload({ nodeId: 'n1', port })).toBe(false);
  });

  test('rejects an overly long device_type or os string', () => {
    expect(isValidHeartbeatPayload({ nodeId: 'n1', device_type: 'x'.repeat(51) })).toBe(false);
    expect(isValidHeartbeatPayload({ nodeId: 'n1', os: 'x'.repeat(51) })).toBe(false);
  });
});
