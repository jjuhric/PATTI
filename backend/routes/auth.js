const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db');
const { authenticateToken, JWT_SECRET, AUTH_COOKIE_NAME } = require('../middleware/auth');

// SEC-5: options for the httpOnly auth cookie, mirrored between the set on login and the
// clear on logout so the browser recognizes them as the same cookie. `secure` follows the
// actual connection (req.secure), not NODE_ENV, since server.js falls back to plain HTTP if
// no TLS certificate is configured even in production - hardcoding `true` there would make the
// cookie silently never get sent.
function authCookieOptions(req) {
  return {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'lax'
  };
}
const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit each IP to 20 requests per window
  message: { error: 'Too many authentication attempts from this IP, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Every test in this router's test file shares one IP and one 15-minute window, so the
  // limiter would otherwise trip on unrelated tests well before any of them actually means to
  // exercise rate limiting - skip it under test the same way other cross-cutting middleware
  // (e.g. requireAdmin's DB check) is bypassed via mocking elsewhere in the suite.
  skip: () => process.env.NODE_ENV === 'test'
});

router.post('/register', authLimiter, async (req, res) => {
  const { username, password, inviteCode } = req.body;
  if (!username || !password || username.trim() === '' || password.length < 4) {
    return res.status(400).json({ error: 'Username and password (min 4 characters) are required.' });
  }
  try {
    const db = await getDb();
    const existing = await db.get('SELECT id FROM users WHERE username = ?', [username.trim()]);
    if (existing) return res.status(400).json({ error: 'Username is already taken.' });

    // Registration is open with no invite code only for the very first account on a fresh
    // instance (which becomes the owner/admin). After that, self-registration requires an
    // invite code matching REGISTRATION_INVITE_CODE - unset means "closed" by default, since
    // this is a personal/household assistant, not a public service. See SEC-8 in
    // docs/REVIEW_2026-08-03.md. An admin can also create accounts directly via
    // POST /api/admin/users, which bypasses this gate entirely.
    const { count: existingUserCount } = await db.get('SELECT COUNT(*) as count FROM users');
    const isFirstUser = existingUserCount === 0;
    if (!isFirstUser) {
      const requiredCode = process.env.REGISTRATION_INVITE_CODE;
      if (!requiredCode || inviteCode !== requiredCode) {
        return res.status(403).json({ error: 'Registration is invite-only on this instance. Ask an admin for an invite code or account.' });
      }
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const result = await db.run(
      'INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)',
      [username.trim(), passwordHash, isFirstUser ? 1 : 0]
    );

    // Initialize default user settings
    await db.run(
      'INSERT INTO user_settings (user_id, provider, model_name) VALUES (?, ?, ?)',
      [result.lastID, 'local', 'qwen2.5-coder-7b-instruct']
    );

    res.json({ success: true, userId: result.lastID, isAdmin: isFirstUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

  try {
    const db = await getDb();
    const user = await db.get('SELECT * FROM users WHERE username = ?', [username.trim()]);
    if (!user) return res.status(400).json({ error: 'Invalid username or password.' });

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) return res.status(400).json({ error: 'Invalid username or password.' });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie(AUTH_COOKIE_NAME, token, { ...authCookieOptions(req), maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SEC-5: revokes every currently-issued token for this account (including the one used to
// call this endpoint) by moving the revocation cutoff to now. There is no per-device/session
// tracking, so this is all-or-nothing - the right response to "I think my token leaked."
router.post('/logout-everywhere', authenticateToken, async (req, res) => {
  try {
    const db = await getDb();
    await db.run('UPDATE users SET tokens_valid_after = CURRENT_TIMESTAMP WHERE id = ?', [req.user.id]);
    res.clearCookie(AUTH_COOKIE_NAME, authCookieOptions(req));
    res.json({ success: true, message: 'All sessions have been logged out. You will need to log in again.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SEC-5: the auth cookie is httpOnly, so client-side JS can't clear it itself on a normal
// (single-device) logout - it just drops the token from localStorage and calls this to have
// the browser drop the cookie too. Deliberately not gated behind authenticateToken: an
// already-expired/invalid token should still be able to clear the cookie, and clearing it is
// harmless either way.
router.post('/logout', (req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME, authCookieOptions(req));
  res.json({ success: true });
});

router.get('/me', authenticateToken, async (req, res) => {
  try {
    const db = await getDb();
    const user = await db.get('SELECT id, username, is_admin FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ user: { id: user.id, username: user.username, is_admin: user.is_admin === 1 } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
