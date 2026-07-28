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
      // Voice Mode is the single, persisted gate for all TTS generation - the agent must
      // never speak on its own initiative when the user hasn't turned it on.
      const voiceSettings = await db.get('SELECT voice_mode FROM user_settings WHERE user_id = ?', [userId]);
      if (!voiceSettings || !voiceSettings.voice_mode) {
        return 'Voice Mode is currently turned off, so no audio was generated. Let the user know they can turn on Voice Mode (the speaker icon in the chat header) if they want spoken responses.';
      }

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
