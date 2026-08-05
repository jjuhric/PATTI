jest.mock('dns', () => ({
  promises: { lookup: jest.fn() }
}));

const dns = require('dns').promises;
const { assertPublicHttpUrl, isPrivateOrReservedIPv4, isPrivateOrReservedIPv6 } = require('../utils/ssrfGuard');

describe('ssrfGuard - address classification', () => {
  test.each([
    ['127.0.0.1', true],
    ['127.5.5.5', true],
    ['10.0.0.5', true],
    ['192.168.1.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['169.254.169.254', true], // cloud metadata endpoint
    ['0.0.0.0', true],
    ['100.64.0.1', true], // CGNAT
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['172.32.0.1', false], // just outside the RFC1918 172.16/12 block
    ['172.15.255.255', false],
  ])('isPrivateOrReservedIPv4(%s) === %s', (ip, expected) => {
    expect(isPrivateOrReservedIPv4(ip)).toBe(expected);
  });

  test.each([
    ['::1', true],
    ['fe80::1', true],
    ['fc00::1', true],
    ['fd12:3456::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:10.0.0.1', true],
    ['2001:4860:4860::8888', false], // Google public DNS
  ])('isPrivateOrReservedIPv6(%s) === %s', (ip, expected) => {
    expect(isPrivateOrReservedIPv6(ip)).toBe(expected);
  });
});

describe('ssrfGuard - assertPublicHttpUrl', () => {
  beforeEach(() => {
    dns.lookup.mockReset();
  });

  test('rejects non-http(s) protocols', async () => {
    await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toThrow(/non-http/i);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  test('rejects an invalid URL', async () => {
    await expect(assertPublicHttpUrl('not a url')).rejects.toThrow(/invalid url/i);
  });

  test('rejects the literal hostname localhost without a DNS lookup', async () => {
    await expect(assertPublicHttpUrl('http://localhost:1234/x')).rejects.toThrow(/local\/internal/i);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  test('rejects a .local mDNS hostname without a DNS lookup', async () => {
    await expect(assertPublicHttpUrl('http://my-router.local/admin')).rejects.toThrow(/local\/internal/i);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  test('rejects a hostname that resolves to a private IP', async () => {
    dns.lookup.mockResolvedValue([{ address: '192.168.1.1', family: 4 }]);
    await expect(assertPublicHttpUrl('http://internal.example.com/')).rejects.toThrow(/private\/internal address/i);
  });

  test('rejects when DNS resolution fails', async () => {
    dns.lookup.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(assertPublicHttpUrl('http://does-not-exist.example/')).rejects.toThrow(/could not resolve/i);
  });

  test('allows a hostname that resolves only to public addresses', async () => {
    dns.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const parsed = await assertPublicHttpUrl('https://example.com/page');
    expect(parsed.hostname).toBe('example.com');
  });

  test('rejects if ANY resolved address is private, even when others are public', async () => {
    dns.lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 }
    ]);
    await expect(assertPublicHttpUrl('https://multi-homed.example.com/')).rejects.toThrow(/private\/internal address/i);
  });
});
