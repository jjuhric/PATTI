const jwt = require('jsonwebtoken');
const { getDb } = require('../db');
const isTest = process.env.NODE_ENV === 'test';
if (!process.env.JWT_SECRET && !isTest) {
  console.error('FATAL ERROR: JWT_SECRET env variable is not configured.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_key_patti_assistant_2026';

// SEC-5: name of the httpOnly cookie set on login (backend/routes/auth.js). Only
// authenticateTokenOrCookie (below) ever accepts it - every mutating route and most GETs stay
// on authenticateToken (Authorization header only), so a forged cross-site request that only
// carries the cookie can never reach a state-changing endpoint. That keeps the blast radius of
// accepting a cookie at all limited to a small safelist of GET-based streaming/media routes
// that browser APIs (EventSource, WebSocket upgrade, <img src>, window.open downloads) can't
// attach a custom Authorization header to - no separate CSRF-token scheme needed.
const AUTH_COOKIE_NAME = 'patti_token';

async function verifyAndAttachUser(token, req, res, next) {
  if (!token) return res.status(401).json({ error: 'Access token required.' });

  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) return res.status(403).json({ error: 'Session expired or invalid.' });

    try {
      const db = await getDb();
      const dbUser = await db.get('SELECT id, tokens_valid_after FROM users WHERE id = ?', [user.id]);
      if (!dbUser) {
        return res.status(401).json({ error: 'Stale session: User no longer exists.' });
      }
      // SEC-5: a JWT issued at or before the user's revocation cutoff is rejected even though
      // it hasn't reached its own expiry - see POST /api/auth/logout-everywhere in routes/auth.js.
      // Both `iat` and the SQLite CURRENT_TIMESTAMP cutoff are whole-second precision, so a
      // token issued in the same second as the revocation call (including the very token that
      // made the call) must compare as revoked too - a strict `<` let that token slip through,
      // intermittently on a fast CI runner where login and logout-everywhere land in the same
      // second.
      if (dbUser.tokens_valid_after && user.iat * 1000 <= new Date(dbUser.tokens_valid_after).getTime()) {
        return res.status(401).json({ error: 'Session revoked. Please log in again.' });
      }
    } catch (dbErr) {
      console.warn('Database user check failed during authentication, proceeding with JWT payload:', dbErr.message);
    }

    req.user = user;
    next();
  });
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  return verifyAndAttachUser(token, req, res, next);
}

// SEC-5: use only on GET-based streaming/media routes that browser APIs can't attach an
// Authorization header to. Never wire this into a route that changes state.
function authenticateTokenOrCookie(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.split(' ')[1]) || (req.cookies && req.cookies[AUTH_COOKIE_NAME]);
  return verifyAndAttachUser(token, req, res, next);
}

module.exports = { authenticateToken, authenticateTokenOrCookie, JWT_SECRET, AUTH_COOKIE_NAME };
