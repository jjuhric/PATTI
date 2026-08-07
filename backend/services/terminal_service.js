const WebSocket = require('ws');
const { Client } = require('ssh2');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db');
const { decrypt } = require('../utils/crypto');
const logger = require('../utils/logger');

const { JWT_SECRET, AUTH_COOKIE_NAME } = require('../middleware/auth');

// SEC-5: the browser WebSocket API can't attach a custom Authorization header, and this
// connection is upgraded directly on the raw HTTP server (before Express/cookie-parser ever
// see the request), so the httpOnly auth cookie has to be read straight off the raw `Cookie`
// header here.
function getCookieFromRequest(request, name) {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

function init(server) {
  const wss = new WebSocket.Server({ noServer: true });

  // Handle server upgrades
  server.on('upgrade', (request, socket, head) => {
    const urlStr = request.url;
    if (urlStr.includes('/api/terminal')) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  // Handle WS connection
  wss.on('connection', async (ws, request) => {
    logger.info('[WebSocket Terminal] Client connected, authenticating...');

    // Extract search params
    const reqUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const token = getCookieFromRequest(request, AUTH_COOKIE_NAME);
    const ip = reqUrl.searchParams.get('ip');

    if (!token || !ip) {
      ws.send(JSON.stringify({ type: 'status', message: 'Missing parameters.\r\n' }));
      ws.close();
      return;
    }

    // Verify authentication token
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      ws.send(JSON.stringify({ type: 'status', message: 'Unauthorized: Invalid token.\r\n' }));
      ws.close();
      return;
    }

    const userId = decoded.id;

    try {
      const db = await getDb();
      const node = await db.get(
        'SELECT ip_address, device_type, ssh_username, ssh_password, ssh_key FROM network_nodes WHERE user_id = ? AND ip_address = ?',
        [userId, ip]
      );

      if (!node) {
        ws.send(JSON.stringify({ type: 'status', message: `Node with IP ${ip} not found in database.\r\n` }));
        ws.close();
        return;
      }

      // Check device compatibility (must be Raspberry Pi or generic Linux)
      const devType = node.device_type ? node.device_type.toLowerCase() : '';
      if (!devType.includes('rpi') && !devType.includes('linux')) {
        ws.send(JSON.stringify({ type: 'status', message: 'Terminal connection is only supported for Raspberry Pi or Linux nodes.\r\n' }));
        ws.close();
        return;
      }

      const sshUser = node.ssh_username || 'jeffery-uhrick';
      const sshPass = node.ssh_password ? decrypt(node.ssh_password) : '';
      const sshKey = node.ssh_key ? decrypt(node.ssh_key) : '';

      ws.send(JSON.stringify({ type: 'status', message: `Establishing SSH connection to ${sshUser}@${ip}...\r\n` }));

      const conn = new Client();

      conn.on('ready', () => {
        ws.send(JSON.stringify({ type: 'status', message: 'SSH connection established. Spawning interactive shell...\r\n' }));
        
        conn.shell((err, stream) => {
          if (err) {
            ws.send(JSON.stringify({ type: 'status', message: `Shell launch error: ${err.message}\r\n` }));
            ws.close();
            conn.end();
            return;
          }

          // Pipe SSH stream to WebSocket
          stream.on('data', (chunk) => {
            ws.send(JSON.stringify({ type: 'data', data: chunk.toString('utf8') }));
          });

          stream.on('close', () => {
            ws.send(JSON.stringify({ type: 'status', message: '\r\nConnection closed by remote RPi.\r\n' }));
            ws.close();
            conn.end();
          });

          // Pipe WebSocket inputs to SSH stream
          ws.on('message', (message) => {
            try {
              const parsed = JSON.parse(message);
              if (parsed.type === 'data') {
                stream.write(parsed.data);
              } else if (parsed.type === 'resize') {
                stream.setWindow(parsed.rows || 24, parsed.cols || 80, 0, 0);
              }
            } catch (e) {
              // Fallback raw text write
              stream.write(message);
            }
          });
        });
      });

      conn.on('error', (err) => {
        logger.error(`[WebSocket SSH Client Error] ${err.message}`);
        ws.send(JSON.stringify({ type: 'status', message: `SSH Client error: ${err.message}\r\n` }));
        ws.close();
      });

      conn.on('close', () => {
        ws.close();
      });

      ws.on('close', () => {
        logger.info('[WebSocket Terminal] Client disconnected. Closing SSH session.');
        conn.end();
      });

      // Connect configuration
      const connConfig = {
        host: ip,
        port: 22,
        username: sshUser,
        readyTimeout: 10000
      };

      if (sshKey) {
        connConfig.privateKey = sshKey;
      } else if (sshPass) {
        connConfig.password = sshPass;
      } else {
        ws.send(JSON.stringify({ type: 'status', message: 'Warning: No SSH password or private key configured for this node. Attempting passwordless SSH...\r\n' }));
      }

      conn.connect(connConfig);

    } catch (dbErr) {
      logger.error(`[WebSocket Terminal DB Error] ${dbErr.message}`);
      ws.send(JSON.stringify({ type: 'status', message: `Database error: ${dbErr.message}\r\n` }));
      ws.close();
    }
  });
}

module.exports = { init };
