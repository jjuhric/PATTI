const { getDb } = require('../db');

// Must run after authenticateToken - checks the live is_admin flag on req.user.id
// (never trusts a role claim baked into the JWT, since tokens live for 30 days).
async function requireAdmin(req, res, next) {
  try {
    const db = await getDb();
    const user = await db.get('SELECT is_admin FROM users WHERE id = ?', [req.user.id]);
    if (!user || user.is_admin !== 1) {
      return res.status(403).json({ error: 'Access denied: Admin permissions required.' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { requireAdmin };
