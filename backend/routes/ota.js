const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '../..');

// Defense in depth: this route is meant to be reachable from the home LAN only
// (no port-forward/tunnel is set up for it). Reject anything that isn't a
// private/loopback address even if that assumption is ever broken later.
function isPrivateIp(ip) {
  const addr = (ip || '').replace('::ffff:', '');
  return addr === '::1' || addr === '127.0.0.1' ||
    /^10\./.test(addr) ||
    /^192\.168\./.test(addr) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(addr);
}

function secretMatches(provided) {
  const expected = process.env.OTA_SECRET;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Triggers the same git-pull + reinstall + service-restart flow patti-cli.js
// already runs for a manual update, just kicked off over HTTP. Responds first,
// then runs the update in a detached process, since the update kills the port
// this very request is being served on.
router.post('/update', (req, res) => {
  if (!isPrivateIp(req.ip)) {
    return res.status(403).json({ error: 'OTA update is only available from the local network.' });
  }
  if (!secretMatches(req.get('X-OTA-Secret'))) {
    return res.status(403).json({ error: 'Invalid or missing X-OTA-Secret header.' });
  }

  res.json({ success: true, message: 'OTA update started: pulling latest from git, reinstalling, and restarting PATTI.' });

  const child = spawn(process.execPath, [path.join(ROOT, 'patti-cli.js'), 'install', '--non-interactive'], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
});

module.exports = router;
