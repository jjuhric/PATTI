const jwt = require('jsonwebtoken');
const { getDb } = require('../db');
const isTest = process.env.NODE_ENV === 'test';
if (!process.env.JWT_SECRET && !isTest) {
  console.error('FATAL ERROR: JWT_SECRET env variable is not configured.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_key_patti_assistant_2026';

async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;
  if (!token) return res.status(401).json({ error: 'Access token required.' });

  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) return res.status(403).json({ error: 'Session expired or invalid.' });

    try {
      const db = await getDb();
      const dbUser = await db.get('SELECT id, tokens_valid_after FROM users WHERE id = ?', [user.id]);
      if (!dbUser) {
        return res.status(401).json({ error: 'Stale session: User no longer exists.' });
      }
      // SEC-5: a JWT issued before the user's revocation cutoff is rejected even though it
      // hasn't reached its own expiry - see POST /api/auth/logout-everywhere in routes/auth.js.
      if (dbUser.tokens_valid_after && user.iat * 1000 < new Date(dbUser.tokens_valid_after).getTime()) {
        return res.status(401).json({ error: 'Session revoked. Please log in again.' });
      }
    } catch (dbErr) {
      console.warn('Database user check failed during authentication, proceeding with JWT payload:', dbErr.message);
    }

    req.user = user;
    next();
  });
}

module.exports = { authenticateToken, JWT_SECRET };
