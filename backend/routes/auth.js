const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db');
const { authenticateToken, JWT_SECRET } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit each IP to 20 requests per window
  message: { error: 'Too many authentication attempts from this IP, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

router.post('/register', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.trim() === '' || password.length < 4) {
    return res.status(400).json({ error: 'Username and password (min 4 characters) are required.' });
  }
  try {
    const db = await getDb();
    const existing = await db.get('SELECT id FROM users WHERE username = ?', [username.trim()]);
    if (existing) return res.status(400).json({ error: 'Username is already taken.' });

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const result = await db.run(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      [username.trim(), passwordHash]
    );

    // Initialize default user settings
    await db.run(
      'INSERT INTO user_settings (user_id, provider, model_name) VALUES (?, ?, ?)',
      [result.lastID, 'local', 'qwen2.5-coder-7b-instruct']
    );

    res.json({ success: true, userId: result.lastID });
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
    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
