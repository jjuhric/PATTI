const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { AGENT_PROMPTS } = require('../utils/agents');

// FEAT-5 (docs/REVIEW_2026-08-03.md): single source of truth for "what agents exist", backed
// by the same AGENT_PROMPTS proxy (utils/agents.js) that already discovers agent prompt files
// from disk. Fixes the actual bug this endpoint exists to close (BUG-4): the monitor dashboard
// hardcoding its own agent roster, which has already silently gone stale once (six agents
// missing until added by hand).
//
// Deliberately scoped to name + displayName only. Agent prompt files are free-form text with no
// structured description/tool-list convention - parsing one out reliably (vs. a plausible-looking
// but wrong guess) isn't something worth building today. Name + displayName is what actually
// fixes BUG-4 (a hardcoded array going stale, and substring-matching status chains); a
// description/tool-list field can be added later without a breaking change if a real need for
// it shows up.
function humanizeAgentName(name) {
  return name
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

router.get('/', authenticateToken, (req, res) => {
  try {
    const names = Object.keys(AGENT_PROMPTS).sort();
    const agents = names.map((name) => ({
      name,
      displayName: humanizeAgentName(name)
    }));
    res.json({ agents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
