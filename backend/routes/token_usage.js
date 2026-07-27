const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authenticateToken } = require('../middleware/auth');

router.get('/', authenticateToken, async (req, res) => {
  const { timeframe, since } = req.query;
  const userId = req.user.id;

  try {
    const db = await getDb();

    // Session-scoped total for the header stats display ("tokens since this tab was opened").
    // Unlike `timeframe` (a fixed enum, safe to interpolate), `since` is client-supplied, so it
    // is always bound as a parameter - never interpolated - and wrapped in SQLite's datetime()
    // to normalize it against created_at's format rather than comparing raw strings, which
    // would silently miscompare ISO8601's "T"/"Z" against SQLite's own "YYYY-MM-DD HH:MM:SS".
    if (since) {
      const sinceDate = new Date(since);
      if (isNaN(sinceDate.getTime())) {
        return res.status(400).json({ error: 'Invalid "since" timestamp.' });
      }
      const totalRow = await db.get(
        'SELECT SUM(token_count) as total FROM token_usage WHERE user_id = ? AND created_at >= datetime(?)',
        [userId, sinceDate.toISOString()]
      );
      return res.json({ totalTokens: totalRow?.total || 0 });
    }

    let timeFilter = '';
    let isLastRequest = false;

    switch (timeframe) {
      case 'last_request':
        isLastRequest = true;
        break;
      case '1h':
        timeFilter = "datetime('now', '-1 hour')";
        break;
      case '12h':
        timeFilter = "datetime('now', '-12 hours')";
        break;
      case '24h':
        timeFilter = "datetime('now', '-24 hours')";
        break;
      case '7d':
        timeFilter = "datetime('now', '-7 days')";
        break;
      case '30d':
        timeFilter = "datetime('now', '-30 days')";
        break;
      case '365d':
        timeFilter = "datetime('now', '-365 days')";
        break;
      default:
        timeFilter = "datetime('now', '-24 hours')";
    }

    if (isLastRequest) {
      const lastRequest = await db.get(
        'SELECT model_name, provider_type, token_count, created_at FROM token_usage WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
        [userId]
      );
      const totalTokens = lastRequest ? lastRequest.token_count : 0;
      const tableData = lastRequest ? [{
        model_name: lastRequest.model_name,
        provider_type: lastRequest.provider_type,
        total_tokens: lastRequest.token_count,
        call_count: 1
      }] : [];
      const graphData = lastRequest ? [{
        created_at: lastRequest.created_at,
        model_name: lastRequest.model_name,
        provider_type: lastRequest.provider_type,
        token_count: lastRequest.token_count
      }] : [];

      return res.json({
        totalTokens,
        tableData,
        graphData
      });
    }

    // Standard timeframes
    const totalRow = await db.get(
      `SELECT SUM(token_count) as total FROM token_usage WHERE user_id = ? AND created_at >= ${timeFilter}`,
      [userId]
    );
    const totalTokens = totalRow?.total || 0;

    const tableData = await db.all(
      `SELECT model_name, provider_type, SUM(token_count) as total_tokens, COUNT(*) as call_count 
       FROM token_usage 
       WHERE user_id = ? AND created_at >= ${timeFilter}
       GROUP BY model_name, provider_type
       ORDER BY total_tokens DESC`,
      [userId]
    );

    const graphData = await db.all(
      `SELECT created_at, model_name, provider_type, token_count 
       FROM token_usage 
       WHERE user_id = ? AND created_at >= ${timeFilter}
       ORDER BY created_at ASC`,
      [userId]
    );

    res.json({
      totalTokens,
      tableData,
      graphData
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
