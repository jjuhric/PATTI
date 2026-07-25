const os = require('os');
const net = require('net');
const logger = require('./logger');

// Get local IPv4 subnet (e.g. "192.168.1")
function getLocalSubnet() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const netObj of interfaces[name]) {
      if (netObj.family === 'IPv4' && !netObj.internal) {
        const parts = netObj.address.split('.');
        if (parts.length === 4) {
          return `${parts[0]}.${parts[1]}.${parts[2]}`;
        }
      }
    }
  }
  return '192.168.1';
}

// Get all local IPv4 addresses of this machine, so the scanner doesn't discover
// and register itself as a remote field node.
function getLocalIps() {
  const ips = new Set(['127.0.0.1', 'localhost']);
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const netObj of interfaces[name]) {
      if (netObj.family === 'IPv4') {
        ips.add(netObj.address);
      }
    }
  }
  return ips;
}

// Raw TCP port checker
function checkTcpPort(ip, port, timeout = 600) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let isDone = false;

    socket.setTimeout(timeout);

    socket.on('connect', () => {
      socket.destroy();
      if (!isDone) {
        isDone = true;
        resolve(true);
      }
    });

    const handleError = () => {
      socket.destroy();
      if (!isDone) {
        isDone = true;
        resolve(false);
      }
    };

    socket.on('error', handleError);
    socket.on('timeout', handleError);

    socket.connect(port, ip);
  });
}

// The sole positive-identification signal for a device we know nothing else about:
// a real, well-formed JSON response on GET /health. No magic field required.
async function probeHealth(ip, port, timeout = 1500) {
  try {
    const controller = new AbortController();
    const tId = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(`http://${ip}:${port}/health`, { signal: controller.signal });
    clearTimeout(tId);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// PATTI-node-specific discovery payload (used by other PATTI installs on the network)
async function probeDiscoveryPayload(ip, port = 3000, timeout = 1500) {
  try {
    const controller = new AbortController();
    const tId = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(`http://${ip}:${port}/api/nodes/discovery`, { signal: controller.signal });
    clearTimeout(tId);
    if (res.ok) return await res.json();
  } catch (e) {
    // ignore
  }
  return null;
}

// Precise Google Cast/Nest identification via mDNS - not a guess, so it's trusted outright.
async function probeGoogleCast(subnet, timeout = 1500) {
  const map = new Map();
  try {
    const mDnsSd = require('node-dns-sd');
    const devices = await mDnsSd.discover({ name: '_googlecast._tcp.local', timeout });
    for (const d of devices) {
      if (d && d.address && (!subnet || d.address.startsWith(subnet))) {
        map.set(d.address, {
          node_name: d.friendlyName || d.modelName || 'Google Assistant',
          device_type: 'google_home',
          port: 8009
        });
      }
    }
  } catch (err) {
    logger.warn(`[Network Discovery] mDNS Cast discovery skipped/error: ${err.message}`);
  }
  return map;
}

// Insert or update a discovered node, never clobbering a name the user (or a more
// specific prior discovery) already gave it back to a generic auto-discovery label.
async function upsertNode(db, userId, ip, info) {
  const exist = await db.get(
    'SELECT id, node_name, device_type FROM network_nodes WHERE user_id = ? AND ip_address = ?',
    [userId, ip]
  );

  if (!exist) {
    await db.run(
      'INSERT INTO network_nodes (user_id, node_name, device_type, ip_address, port, is_online, last_seen) VALUES (?, ?, ?, ?, ?, 1, datetime("now"))',
      [userId, info.node_name, info.device_type, ip, info.port]
    );
    return;
  }

  const hasCustomName = exist.node_name && !exist.node_name.startsWith('New Device (');
  const finalName = hasCustomName ? exist.node_name : info.node_name;
  const finalDeviceType = exist.device_type === 'google_home'
    ? 'google_home'
    : (hasCustomName ? exist.device_type : info.device_type);

  await db.run(
    'UPDATE network_nodes SET is_online = 1, last_seen = datetime("now"), node_name = ?, device_type = ?, port = ? WHERE id = ?',
    [finalName, finalDeviceType, info.port, exist.id]
  );
}

// Main entry point: discover real, reachable devices on the local subnet and sync
// them into network_nodes. A device is only ever added if it's precisely identified
// (mDNS Cast, or a PATTI /api/nodes/discovery payload on port 3000) or it answers
// with a valid JSON body on GET /health for one of the candidate ports.
async function discoverAndSyncNodes(db, userId, options = {}) {
  const ports = options.ports || [3000, 80, 8080, 8000];
  const subnet = getLocalSubnet();
  const localIps = getLocalIps();

  const castMap = await probeGoogleCast(subnet);
  for (const [ip, info] of castMap.entries()) {
    await upsertNode(db, userId, ip, info);
  }

  const ipList = [];
  for (let i = 2; i <= 254; i++) {
    const ip = `${subnet}.${i}`;
    if (ip === `${subnet}.1` || localIps.has(ip) || castMap.has(ip)) continue;
    ipList.push(ip);
  }

  const batchSize = 40;
  for (let i = 0; i < ipList.length; i += batchSize) {
    const batch = ipList.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (ip) => {
        for (const port of ports) {
          // No separate raw-TCP pre-filter here: it's redundant with the HTTP probes
          // below (fetch() establishes its own connection) and was an extra flaky
          // failure point - a resource-constrained device can be slow/inconsistent on
          // a bare TCP handshake under concurrent scan load even though it answers a
          // direct HTTP request fine. A genuinely closed port still fails fast via
          // fetch's own connection-refused error, so this doesn't cost real scan time.
          if (port === 3000) {
            const info = await probeDiscoveryPayload(ip, port);
            if (info && info.success) {
              if (info.is_main_host) return;
              const isRpi = info.device_type && info.device_type.toLowerCase().includes('rpi');
              const node_name = info.device_type === 'windows' ? 'Windows Host' : (isRpi ? 'Raspberry Pi' : 'Private AI Node');
              const device_type = info.device_type === 'windows' ? 'Windows' : (isRpi ? 'RPi' : 'Windows');
              await upsertNode(db, userId, ip, { node_name, device_type, port });
              return;
            }
            continue;
          }

          const health = await probeHealth(ip, port);
          if (health !== null) {
            await upsertNode(db, userId, ip, {
              node_name: `New Device (${ip})`,
              device_type: 'Generic (Health Check)',
              port
            });
            return;
          }
        }
      })
    );
  }

  return db.all(
    'SELECT id, node_name, device_type, ip_address, port, last_seen, is_online FROM network_nodes WHERE user_id = ? ORDER BY node_name ASC',
    [userId]
  );
}

module.exports = {
  getLocalSubnet,
  getLocalIps,
  checkTcpPort,
  probeHealth,
  probeDiscoveryPayload,
  probeGoogleCast,
  upsertNode,
  discoverAndSyncNodes
};
