const {
  isSendMessageCommand,
  isIpOnlyMessage,
  stripSendMessagePrefix,
  isGoogleHomeDeviceRequest,
  isAgentInfoRequest,
  isUserInfoRequest
} = require('../services/interceptors');

describe('isSendMessageCommand', () => {
  test.each([
    'send a message to device saying hello',
    'Send message to esp32 saying it is done',
    '  send message to esp saying hi',
    'SEND A MESSAGE TO DEVICE hello there'
  ])('matches "%s"', (msg) => {
    expect(isSendMessageCommand(msg)).toBe(true);
  });

  test.each([
    'what is the weather',
    'send a message to my friend',
    'message device please',
    '',
    null,
    undefined
  ])('does not match %p', (msg) => {
    expect(isSendMessageCommand(msg)).toBe(false);
  });
});

describe('isIpOnlyMessage', () => {
  test.each(['192.168.1.42', '  10.0.0.1  ', '255.255.255.255'])('matches "%s"', (msg) => {
    expect(isIpOnlyMessage(msg)).toBe(true);
  });

  test.each([
    'the ip is 192.168.1.42',
    '192.168.1',
    'not an ip',
    ''
  ])('does not match %p', (msg) => {
    expect(isIpOnlyMessage(msg)).toBe(false);
  });
});

describe('stripSendMessagePrefix', () => {
  test('removes the prefix and leaves the rest of the message', () => {
    expect(stripSendMessagePrefix('send message to device saying turn off')).toBe(' saying turn off');
  });

  test('leaves non-matching text untouched', () => {
    expect(stripSendMessagePrefix('hello world')).toBe('hello world');
  });
});

describe('isGoogleHomeDeviceRequest', () => {
  test.each([
    'turn off the office lights',
    'turn on the living room tv',
    'set the bedroom thermostat to 70',
    'dim the office lights',
    'stop the living room speaker',
    "turn off jeffery's room fan"
  ])('matches "%s" (location + device + action)', (msg) => {
    expect(isGoogleHomeDeviceRequest(msg)).toBe(true);
  });

  test.each([
    ['office lights', 'no action verb'],
    ['turn off the lights', 'no location'],
    ['turn off the office', 'no device'],
    ['is the office light on', 'no action verb from the allowed list'],
    ['', 'empty string']
  ])('does not match "%s" (%s)', (msg) => {
    expect(isGoogleHomeDeviceRequest(msg)).toBe(false);
  });

  test('is case-insensitive', () => {
    expect(isGoogleHomeDeviceRequest('TURN OFF THE OFFICE LIGHTS')).toBe(true);
  });

  test('respects word boundaries - "ac" does not match inside another word', () => {
    // "backpack" contains "ac" but must not be treated as the "AC"/air-conditioner device.
    expect(isGoogleHomeDeviceRequest('turn on the office backpack')).toBe(false);
  });

  test('"all" as a location works alongside a device and action', () => {
    expect(isGoogleHomeDeviceRequest('turn off all lights')).toBe(true);
  });
});

describe('isAgentInfoRequest', () => {
  test.each([
    'tell me about your info',
    'who are you',
    'What are your specs?',
    "what's your system like"
  ])('matches "%s"', (msg) => {
    expect(isAgentInfoRequest(msg)).toBe(true);
  });

  test.each(['what is the weather', 'who am i', 'my info please'])('does not match "%s"', (msg) => {
    expect(isAgentInfoRequest(msg)).toBe(false);
  });
});

describe('isUserInfoRequest', () => {
  test.each([
    'what is my name',
    'tell me about me',
    'who am I',
    "what's my zipcode"
  ])('matches "%s"', (msg) => {
    expect(isUserInfoRequest(msg)).toBe(true);
  });

  test.each(['who are you', 'what is the weather', 'your name please'])('does not match "%s"', (msg) => {
    expect(isUserInfoRequest(msg)).toBe(false);
  });
});
