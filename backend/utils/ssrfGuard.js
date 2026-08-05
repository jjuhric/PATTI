const dns = require('dns').promises;
const net = require('net');

// Closes the SSRF path where a chat message's URL (or a link found on a scraped page) could
// make the server fetch an internal LAN service - router admin pages, other IoT nodes, or a
// cloud metadata endpoint - instead of the public page the user actually meant.
// See SEC-4 in docs/REVIEW_2026-08-03.md.

const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0']);

function isPrivateOrReservedIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true; // malformed - treat as unsafe rather than let it through
  }
  const [a, b] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT shared address space
  if (a === 169 && b === 254) return true; // link-local, includes the 169.254.169.254 cloud metadata address
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a >= 224) return true; // multicast/reserved (224-255)
  return false;
}

function isPrivateOrReservedIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10 link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique local
  if (lower.startsWith('::ffff:')) {
    // IPv4-mapped IPv6 address - evaluate the embedded IPv4 address instead.
    const v4 = lower.slice('::ffff:'.length);
    if (net.isIPv4(v4)) return isPrivateOrReservedIPv4(v4);
  }
  return false;
}

function isBlockedAddress(address) {
  return net.isIPv4(address) ? isPrivateOrReservedIPv4(address) : isPrivateOrReservedIPv6(address);
}

/**
 * Validates that `rawUrl` is http(s) and resolves only to public, non-reserved addresses.
 * Throws with a human-readable reason if not; callers should catch and degrade gracefully
 * (return null / an error object) rather than let the throw propagate as an unhandled failure.
 *
 * @param {string} rawUrl
 * @returns {Promise<URL>} the parsed URL, for convenience
 */
async function assertPublicHttpUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing to fetch non-http(s) URL: ${rawUrl}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.local')) {
    throw new Error(`Refusing to fetch a local/internal hostname: ${hostname}`);
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(`Could not resolve hostname: ${hostname}`);
  }
  if (!addresses || addresses.length === 0) {
    throw new Error(`Hostname resolved to no addresses: ${hostname}`);
  }
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error(`Refusing to fetch ${hostname}: resolves to a private/internal address (${address}).`);
    }
  }

  return parsed;
}

module.exports = { assertPublicHttpUrl, isPrivateOrReservedIPv4, isPrivateOrReservedIPv6 };
