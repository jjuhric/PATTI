const express = require('express');
const router = express.Router();
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/adminAuth');
const { cleanupDuplicateNodes } = require('../utils/db_maintenance');
const logger = require('../utils/logger');

router.use(authenticateToken, requireAdmin);

// List users and their token quota/usage
router.get('/users', async (req, res) => {
  try {
    const db = await getDb();
    const users = await db.all(`
      SELECT
        u.id,
        u.username,
        u.name,
        u.is_admin,
        u.created_at,
        COALESCE(s.token_quota, 1000000) as token_quota,
        (
          SELECT COALESCE(SUM(token_count), 0)
          FROM token_usage
          WHERE user_id = u.id
            AND created_at >= datetime('now', '-24 hours')
        ) as total_used_24h
      FROM users u
      LEFT JOIN user_settings s ON u.id = s.user_id
      ORDER BY u.id ASC
    `);
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new user account directly - the admin-run alternative to the public
// invite-code-gated /api/auth/register flow (see SEC-8 in docs/REVIEW_2026-08-03.md).
router.post('/users', async (req, res) => {
  const { username, password, is_admin } = req.body;
  if (!username || !password || username.trim() === '' || password.length < 4) {
    return res.status(400).json({ error: 'Username and password (min 4 characters) are required.' });
  }
  try {
    const db = await getDb();
    const existing = await db.get('SELECT id FROM users WHERE username = ?', [username.trim()]);
    if (existing) return res.status(400).json({ error: 'Username is already taken.' });

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const makeAdmin = is_admin === true || is_admin === 1 || is_admin === '1';

    const result = await db.run(
      'INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)',
      [username.trim(), passwordHash, makeAdmin ? 1 : 0]
    );
    await db.run(
      'INSERT INTO user_settings (user_id, provider, model_name) VALUES (?, ?, ?)',
      [result.lastID, 'local', 'qwen2.5-coder-7b-instruct']
    );

    res.json({ success: true, userId: result.lastID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a specific user's token quota
router.put('/users/:userId/quota', async (req, res) => {
  const { userId } = req.params;
  const { token_quota } = req.body;

  if (token_quota === undefined || isNaN(token_quota) || token_quota < 0) {
    return res.status(400).json({ error: 'Invalid token quota. Must be a non-negative number.' });
  }

  try {
    const db = await getDb();
    await db.run(`
      INSERT INTO user_settings (user_id, token_quota)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET token_quota = excluded.token_quota
    `, [userId, token_quota]);

    res.json({ success: true, message: `Token quota updated successfully for user ${userId}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset a user's password
router.post('/users/:userId/reset-password', async (req, res) => {
  const { userId } = req.params;
  const { newPassword } = req.body;

  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'New password (min 4 characters) is required.' });
  }

  try {
    const db = await getDb();
    const user = await db.get('SELECT id FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);

    res.json({ success: true, message: `Password reset successfully for user ${userId}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Promote/demote a user's admin status
router.put('/users/:userId/admin', async (req, res) => {
  const { userId } = req.params;
  const { is_admin } = req.body;
  const targetId = Number(userId);
  const makeAdmin = is_admin === true || is_admin === 1 || is_admin === '1';

  try {
    const db = await getDb();
    const user = await db.get('SELECT id FROM users WHERE id = ?', [targetId]);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (!makeAdmin) {
      if (targetId === req.user.id) {
        return res.status(400).json({ error: 'You cannot remove your own admin access.' });
      }
      const adminCount = await db.get('SELECT COUNT(*) as count FROM users WHERE is_admin = 1');
      if (adminCount.count <= 1) {
        return res.status(400).json({ error: 'Cannot remove the last remaining admin.' });
      }
    }

    await db.run('UPDATE users SET is_admin = ? WHERE id = ?', [makeAdmin ? 1 : 0, targetId]);
    res.json({ success: true, message: `User ${targetId} is now ${makeAdmin ? 'an admin' : 'a regular user'}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a user account
router.delete('/users/:userId', async (req, res) => {
  const { userId } = req.params;
  const targetId = Number(userId);

  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }

  try {
    const db = await getDb();
    const user = await db.get('SELECT id FROM users WHERE id = ?', [targetId]);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    await db.run('DELETE FROM users WHERE id = ?', [targetId]);
    res.json({ success: true, message: `User ${targetId} deleted successfully.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Row counts for the main tables
router.get('/db/stats', async (req, res) => {
  const tables = [
    'users', 'chats', 'messages', 'network_nodes', 'memories',
    'vault_documents', 'generated_documents', 'token_usage', 'message_attachments'
  ];

  try {
    const db = await getDb();
    const stats = {};
    for (const table of tables) {
      const row = await db.get(`SELECT COUNT(*) as count FROM ${table}`);
      stats[table] = row.count;
    }
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clean up duplicate/gateway network_nodes entries
router.post('/db/cleanup-duplicate-nodes', async (req, res) => {
  try {
    const db = await getDb();
    const result = await cleanupDuplicateNodes(db);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download a consistent point-in-time backup of the database
router.get('/db/backup', async (req, res) => {
  const backupPath = path.join(os.tmpdir(), `patti_backup_${Date.now()}.db`);
  try {
    const db = await getDb();
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    await db.run('VACUUM INTO ?', [backupPath]);

    res.download(backupPath, `patti_backup_${Date.now()}.db`, (err) => {
      if (err) logger.error('Failed to stream DB backup download:', err);
      fs.unlink(backupPath, () => {});
    });
  } catch (err) {
    fs.unlink(backupPath, () => {});
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
