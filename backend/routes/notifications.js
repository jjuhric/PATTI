const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authenticateToken } = require('../middleware/auth');

// Recent notifications + unread count for the current user.
router.get('/', authenticateToken, async (req, res) => {
  try {
    const db = await getDb();
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    // Order by id, not created_at: CURRENT_TIMESTAMP only has second-level resolution, so
    // notifications created within the same second (plausible for near-simultaneous
    // background job completions) would otherwise sort unpredictably.
    const notifications = await db.all(
      'SELECT id, type, message, chat_id, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?',
      [req.user.id, limit]
    );
    const unreadRow = await db.get(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0',
      [req.user.id]
    );
    res.json({ notifications, unreadCount: unreadRow?.count || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/read', authenticateToken, async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.run(
      'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Notification not found.' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/read-all', authenticateToken, async (req, res) => {
  try {
    const db = await getDb();
    await db.run('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', [req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
