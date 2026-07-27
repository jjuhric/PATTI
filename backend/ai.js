// Thin facade preserving this module's public API. The actual implementations live in
// backend/services/agent_loop.js (the Supervisor/worker delegation loop and its direct-action
// interceptors) and backend/llm/ (provider request building and streaming) - this file used to
// contain all of it directly, at ~1700 lines mixing five unrelated responsibilities. Nothing
// outside this file needed to change: every import site still does `require('./ai')` or
// `require('../ai')` and gets the same five exports.
const { handleGoogleNewsTool } = require('./tools/google_news_tool');
const { callLMStudio } = require('./utils/lmstudio');
const { runAgentLoop } = require('./services/agent_loop');

async function generateGreetingAndSave(db, userId, chatId) {
  let userName = '';
  try {
    const user = await db.get('SELECT name FROM users WHERE id = ?', [userId]);
    userName = user?.name || '';
  } catch (err) {
    console.error('Failed to fetch user name for greeting:', err);
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const greeting = `Hello${userName ? ' ' + userName : ''}! Today is ${dateStr} ${timeStr}. What can I do for you next?`;

  try {
    await db.run(
      'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)',
      [chatId, 'assistant', greeting]
    );
  } catch (dbErr) {
    console.error('Failed to save generated greeting to database:', dbErr);
  }
}

/**
 * Sanitizes incoming text by stripping off any embedded
 * <think> reasoning tokens before processing JSON payloads.
 */
function cleanAgentResponse(rawText) {
  if (!rawText) return '';
  let cleanText = rawText.trim();

  // Safely discard the internal trace block if it bypasses the parser
  if (cleanText.includes('</think>')) {
    const parts = cleanText.split('</think>');
    cleanText = parts[parts.length - 1].trim();
  }

  return cleanText;
}

// Example integration within your multi-agent execution thread:
async function processAgentTurn(promptContext) {
  // 1. Dispatch formatted prompt context to the local server array
  const rawLLMOutput = await callLMStudio(promptContext);

  // 2. Clean out any loose markdown logic or lingering thought blocks
  const sanitizedJSON = cleanAgentResponse(rawLLMOutput);

  try {
    // 3. Hand the raw action instructions directly to tool registries safely
    return JSON.parse(sanitizedJSON);
  } catch (parseError) {
    console.error("Failed to parse clean model output into structural JSON object:", parseError);
    console.error("Attempted Content String was:", sanitizedJSON);
    throw new Error("Model emitted an invalid tool orchestration structure.");
  }
}

module.exports = {
  runAgentLoop,
  handleGoogleNewsTool,
  generateGreetingAndSave,
  cleanAgentResponse,
  processAgentTurn
};
