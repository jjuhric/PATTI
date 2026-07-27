const { generateText } = require('./llm_text');

// Heuristic for "this reads like a written report, not a short conversational reply" -
// headings/lists are the strongest signal (research reports, daily briefings), long plain
// prose is the fallback signal. Short replies skip narration entirely so casual chat isn't
// slowed down by an extra LLM round-trip.
function looksLikeReport(text) {
  if (!text) return false;
  const headingCount = (text.match(/^#{1,6}\s/gm) || []).length;
  const listItemCount = (text.match(/^\s*(?:[-*]|\d+\.)\s/gm) || []).length;
  return headingCount >= 1 || listItemCount >= 3 || text.length > 500;
}

const NARRATION_SYSTEM_PROMPT = `You are PATTI. You already wrote the report below for the user to read on screen. ` +
  `Now rewrite it as what you would actually SAY out loud if you were briefing the user verbally on its contents.

Rules:
- Speak in flowing, natural spoken sentences, like you're briefing a friend - not reading a document aloud.
- Do not read headings, bullet markers, dashes, or any markdown/formatting symbols.
- Do not recite every date, time, number, or source verbatim - mention only the ones that actually matter, and phrase them naturally (e.g. "this morning" instead of a precise timestamp, "a handful of sources" instead of listing each one), unless a specific date/time/figure is the key point.
- Hit the key takeaways and the overall gist; skip exhaustive detail, repetition, and boilerplate.
- Keep it noticeably shorter than the original - a tight spoken summary, not a full readout.
- Output ONLY the spoken narration text - no headings, no markdown, no preamble like "Here's a summary", no quotation marks.`;

/**
 * Narration is a nice-to-have that shares one local LLM with everything else. Whenever real
 * work is running or queued, skip the rewrite rather than making the user's next chat turn wait
 * behind it - reading is the primary experience here, so voice always yields.
 */
function llmIsBusy() {
  try {
    const aiQueue = require('../services/ai_queue');
    const state = aiQueue.getState();
    return Boolean(state.isBusy) || state.queueLength > 0;
  } catch (err) {
    // If queue state can't be read, assume it's free - worst case narration waits its turn.
    return false;
  }
}

/**
 * Rewrites `text` into a natural-sounding spoken narration when it looks like a structured
 * report (markdown headings/lists, or just long), so PATTI's voice output summarizes
 * meaningfully instead of reading the raw report word-for-word. Short, already-conversational
 * text is returned unchanged. Narration failures fall back to the original text so voice output
 * never breaks because the rewrite step failed.
 *
 * @param {object} settings LLM settings from llm_text.js's buildSettingsForUser
 * @param {string} text The raw text that would otherwise be spoken verbatim
 * @returns {Promise<string>}
 */
async function narrateForSpeech(settings, text) {
  if (!looksLikeReport(text)) return text;
  if (llmIsBusy()) return text;
  try {
    const narration = await generateText(settings, NARRATION_SYSTEM_PROMPT, text);
    return narration && narration.trim() ? narration.trim() : text;
  } catch (err) {
    return text;
  }
}

module.exports = { narrateForSpeech, looksLikeReport, llmIsBusy };
