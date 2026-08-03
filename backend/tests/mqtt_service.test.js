const mqttService = require('../services/mqtt_service');
const mqtt = require('mqtt');

jest.mock('mqtt', () => {
  const mClient = {
    on: jest.fn(),
    subscribe: jest.fn((topic, cb) => cb && cb(null)),
    unsubscribe: jest.fn((topic, cb) => cb && cb(null)),
    publish: jest.fn((topic, payload, opts, cb) => {
      if (typeof opts === 'function') {
        opts(null);
      } else if (typeof cb === 'function') {
        cb(null);
      }
    }),
    end: jest.fn(),
  };
  return {
    connect: jest.fn(() => mClient),
  };
});

describe('MQTT Service Tests', () => {
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = mqtt.connect();
    mqtt.connect.mockClear();
    
    // Reset service state
    mqttService.client = null;
    mqttService.connected = false;
    mqttService.subscriptions.clear();
    if (mqttService.heartbeatInterval) {
      clearInterval(mqttService.heartbeatInterval);
      mqttService.heartbeatInterval = null;
    }
  });

  afterEach(() => {
    // Cancel any real setTimeout left behind by an unresolved publishAndAwaitResponse
    // call (e.g. a test that only asserts what was published, not the response) - an
    // uncleared 8s timer otherwise keeps the process alive past the test run.
    for (const { timeout } of mqttService.pendingRequests.values()) {
      clearTimeout(timeout);
    }
    mqttService.pendingRequests.clear();
    mqttService.disconnect();
  });

  test('should initialize and connect to broker', () => {
    mqttService.init();
    expect(mqtt.connect).toHaveBeenCalled();
    expect(mockClient.on).toHaveBeenCalledWith('connect', expect.any(Function));
    expect(mockClient.on).toHaveBeenCalledWith('message', expect.any(Function));
    expect(mockClient.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(mockClient.on).toHaveBeenCalledWith('close', expect.any(Function));
  });

  test('should set connected status and subscribe to pending subscriptions on connect', () => {
    const callback = jest.fn();
    mqttService.subscribe('test/topic', callback);

    mqttService.init();

    // Trigger connect callback
    const connectHandler = mockClient.on.mock.calls.find(c => c[0] === 'connect')[1];
    connectHandler();

    expect(mqttService.connected).toBe(true);
    expect(mockClient.subscribe).toHaveBeenCalledWith('test/topic', expect.any(Function));
  });

  test('should handle message and route to matching subscriptions', () => {
    const callback = jest.fn();
    mqttService.subscribe('test/+/wildcard', callback);

    mqttService.init();

    // Trigger message callback
    const messageHandler = mockClient.on.mock.calls.find(c => c[0] === 'message')[1];
    const payload = JSON.stringify({ data: 'hello' });
    messageHandler('test/match/wildcard', Buffer.from(payload));

    expect(callback).toHaveBeenCalledWith({ data: 'hello' }, 'test/match/wildcard');
  });

  test('should not route message to non-matching subscriptions', () => {
    const callback = jest.fn();
    mqttService.subscribe('test/+/wildcard', callback);

    mqttService.init();

    const messageHandler = mockClient.on.mock.calls.find(c => c[0] === 'message')[1];
    messageHandler('test/no/match', Buffer.from('payload'));

    expect(callback).not.toHaveBeenCalled();
  });

  test('should publish message if connected', () => {
    mqttService.init();
    mqttService.connected = true;

    const result = mqttService.publish('test/publish', { message: 'hello' });
    expect(result).toBe(true);
    expect(mockClient.publish).toHaveBeenCalledWith(
      'test/publish',
      JSON.stringify({ message: 'hello' }),
      expect.any(Object),
      expect.any(Function)
    );
  });

  test('should not publish if disconnected', () => {
    const result = mqttService.publish('test/publish', 'hello');
    expect(result).toBe(false);
    expect(mockClient.publish).not.toHaveBeenCalled();
  });

  test('publishAndAwaitResponse merges extraPayload fields alongside command and requestId', () => {
    mqttService.init();
    mqttService.connected = true;

    // Never resolved/rejected in this test (no response is simulated) - swallow the
    // eventual 8s timeout rejection so it doesn't surface as an unhandled rejection
    // after the test (and suite) has already finished.
    mqttService.publishAndAwaitResponse('esp32_aabbcc', 'send_message', 8000, { message: 'hello' }).catch(() => {});

    expect(mockClient.publish).toHaveBeenCalledWith(
      'nodes/esp32_aabbcc/commands',
      expect.stringContaining('"message":"hello"'),
      expect.any(Object),
      expect.any(Function)
    );
    const publishedPayload = JSON.parse(mockClient.publish.mock.calls[0][1]);
    expect(publishedPayload.command).toBe('send_message');
    expect(publishedPayload.message).toBe('hello');
    expect(typeof publishedPayload.requestId).toBe('string');
  });

  test('publishAndAwaitResponse still works with no extraPayload (backward compatible)', () => {
    mqttService.init();
    mqttService.connected = true;

    mqttService.publishAndAwaitResponse('node_livingroom', 'get_system_info', 8000).catch(() => {});

    const publishedPayload = JSON.parse(mockClient.publish.mock.calls[0][1]);
    expect(publishedPayload.command).toBe('get_system_info');
    expect(publishedPayload.message).toBeUndefined();
  });

  test('topicMatches helper patterns', () => {
    expect(mqttService.topicMatches('a/b/c', 'a/b/c')).toBe(true);
    expect(mqttService.topicMatches('a/+/c', 'a/b/c')).toBe(true);
    expect(mqttService.topicMatches('a/#', 'a/b/c/d')).toBe(true);
    expect(mqttService.topicMatches('a/b', 'a/c')).toBe(false);
    expect(mqttService.topicMatches('a/+/c', 'a/b/d')).toBe(false);
  });
});
