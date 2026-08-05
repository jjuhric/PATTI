const { countTokens } = require('gpt-tokenizer');

// ENH-1 (docs/REVIEW_2026-08-03.md): replaces the length/4 fallback estimator used at every
// token-logging call site. gpt-tokenizer's cl100k_base encoding isn't an exact match for every
// provider/model - each has its own tokenizer, and none of them is what a local Qwen/Llama
// model actually uses either - but it's a far closer approximation than length/4 for any
// BPE-based modern LLM (effectively all of them), which is what both quota enforcement and the
// admin token dashboards are working off of.
function estimateTokens(text) {
  if (!text) return 0;
  try {
    return countTokens(text);
  } catch (err) {
    // Tokenization itself failing (malformed/unusual input) shouldn't turn into a hard
    // failure for the LLM call it's estimating alongside - fall back to the old rough estimate.
    return Math.ceil(text.length / 4);
  }
}

// ENH-2: centralizes what was previously 10 near-identical `INSERT INTO token_usage` blocks
// across utils/agents.js, utils/llm_text.js, llm/local_stream.js, and llm/gemini_stream.js.
// Best-effort and fire-and-forget by design (callers do not await this) - a broken/unavailable
// DB must never fail the LLM call it's logging usage for.
async function logTokenUsage(db, userId, modelName, providerType, tokenCount, context = '') {
  if (!db || typeof db.run !== 'function' || !userId) return;
  try {
    await db.run(
      'INSERT INTO token_usage (user_id, model_name, provider_type, token_count) VALUES (?, ?, ?, ?)',
      [userId, modelName || 'unknown', providerType, tokenCount]
    );
  } catch (err) {
    console.error(`Failed to log token usage${context ? ` (${context})` : ''}:`, err.message);
  }
}

module.exports = { estimateTokens, logTokenUsage };
