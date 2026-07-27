const { generateTTS } = require('../utils/tts');
const { narrateForSpeech } = require('../utils/tts_narration');
const { buildSettingsForUser } = require('../utils/llm_text');

async function handleTtsTool(db, userId, action, params) {
  if (action === 'speak') {
    const text = params?.text;
    if (!text) {
      return 'Error: "text" parameter is required.';
    }

    try {
      let spokenText = text;
      try {
        const settings = await buildSettingsForUser(db, userId);
        spokenText = await narrateForSpeech(settings, text);
      } catch (err) {
        // Narration is best-effort; fall back to speaking the raw text.
      }
      const audioUrl = await generateTTS(spokenText);
      return `Success: Speech generated successfully.\nAudio URL: ${audioUrl}`;
    } catch (err) {
      return `Error: Failed to generate TTS speech: ${err.message}`;
    }
  }

  return `Error: Unknown action "${action}" for tts tool.`;
}

module.exports = { handleTtsTool };
