const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { getTavilyUsage, isConfigured } = require('../utils/tavily_search');

// Server-scoped (one shared TAVILY_API_KEY, not per-user) credit usage for the header stats
// display - "X / 1,000" matching Tavily's own dashboard.
router.get('/', authenticateToken, async (req, res) => {
  if (!isConfigured()) {
    return res.json({ configured: false, used: 0, limit: 0 });
  }
  const usage = await getTavilyUsage();
  if (!usage) {
    return res.status(502).json({ configured: true, error: 'Failed to fetch Tavily usage.' });
  }
  res.json({ configured: true, used: usage.used, limit: usage.limit });
});

module.exports = router;
