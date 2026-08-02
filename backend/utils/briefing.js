const { handleWeatherTool } = require('../tools/weather_tool');
const { handleGoogleNewsTool } = require('../ai');
const { generateText, buildSettingsForUser } = require('./llm_text');
const { getUserLocalNow } = require('./timezone');
const { getTodayEventsFormatted, getUserMemoriesFormatted } = require('./scheduled_digest_helpers');
const logger = require('./logger');

async function generateDailyBriefing(db, userId) {
  try {
    // 1. Fetch user profile
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return null;

    const userTimezone = user.timezone || 'America/Chicago';
    const { dateStr: todayStr } = getUserLocalNow(userTimezone);

    // 2. Fetch today's calendar events (today, in the USER's own local date, not UTC)
    const eventsText = await getTodayEventsFormatted(db, userId, todayStr);

    // 3. Fetch weather - handleWeatherTool self-fetches zipcode/country/temp_unit/API key from
    // the users row by userId (it no longer accepts them as params) and already returns a
    // correct, human-readable error string if something's missing/misconfigured.
    const weatherText = await handleWeatherTool(db, userId, 'current', {});

    // 4. Fetch memories
    const memoriesText = await getUserMemoriesFormatted(db, userId);

    // 5. Fetch live Google News
    let newsText = 'No news updates retrieved today.';
    try {
      newsText = await handleGoogleNewsTool('top general headlines');
    } catch (err) {
      newsText = `News retrieval offline: ${err.message}`;
    }

    // 6. Invoke LLM to generate markdown digest
    const systemPrompt = `You are the Daily Briefing Assistant. Your task is to generate a beautiful, personalized, daily markdown digest for ${user.name || user.username}.
Compile the weather forecast, calendar schedule, relevant memories, and news headlines into a clean, encouraging briefing.
Add a friendly greeting and a daily quote/encouragement based on the user's memories and interests. Use rich markdown layout with emoji headings.`;

    const userPrompt = `
### Today's Date: ${todayStr}

### User Profile:
- Name: ${user.name || user.username}
- Temp Unit: ${user.temp_unit || 'imperial'}

### Weather Forecast:
${weatherText}

### Today's Schedule:
${eventsText}

### User Preferences/Memories:
${memoriesText}

### Today's News Headlines:
${newsText}

Generate the daily briefing now. Keep it professional, highly structured, and warm.
`;

    // A single, direct text-completion call - not runWorkerAgent's multi-turn tool-calling
    // loop, which is the wrong shape for this: all the data above was already gathered by this
    // function itself, so there's nothing left for a "worker agent" to decide or tool-call
    // about, and runWorkerAgent's generic final-response schema ({status, summary, data}) has
    // no way to carry a full markdown digest anyway. generateText/buildSettingsForUser
    // (utils/llm_text.js) are already built for exactly this "background LLM call with no live
    // HTTP request in scope" case, already queued through ai_queue, already retry-with-backoff.
    const llmSettings = await buildSettingsForUser(db, userId);
    const briefingContent = await generateText(llmSettings, systemPrompt, userPrompt);

    // 7. Find or create "Daily Briefings" chat
    let chat = await db.get('SELECT * FROM chats WHERE user_id = ? AND title = ?', [userId, 'Daily Briefings']);
    if (!chat) {
      const result = await db.run('INSERT INTO chats (user_id, title) VALUES (?, ?)', [userId, 'Daily Briefings']);
      chat = { id: result.lastID, title: 'Daily Briefings' };
    }

    // 8. Insert briefing into messages table
    await db.run(
      'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)',
      [chat.id, 'assistant', briefingContent]
    );

    // 9. Update last_briefing_at
    await db.run('UPDATE users SET last_briefing_at = datetime(\'now\') WHERE id = ?', [userId]);

    // 10. Let the user know it's ready - persisted (utils/notifications.js) so it survives
    // even if no tab was open to catch the live broadcastAlert it also fires.
    try {
      const { notifyUser } = require('./notifications');
      await notifyUser(db, userId, { type: 'info', message: 'Your daily briefing is ready.', chatId: chat.id });
    } catch (alertErr) {
      logger.warn('Failed to send daily briefing notification:', alertErr.message);
    }

    return briefingContent;
  } catch (err) {
    logger.error('Error compiling daily briefing:', err);
    throw err;
  }
}

// Background scheduler checker. A single 5-minute poll shared across all users - per-user
// eligibility (local hour vs. their briefing_hour, whether they've already been briefed
// "today" in their own timezone) is resolved individually in JS via getUserLocalNow, since a
// single shared SQL comparison can't correctly gate users across different timezones at once.
let isRunning = false;
function startBriefingScheduler(db) {
  setInterval(async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      // Deliberately generous prefilter (UTC-vs-local day boundaries can differ by up to a
      // day) - this only needs to be a cheap superset; getUserLocalNow makes the real call.
      const candidates = await db.all(
        `SELECT * FROM users WHERE last_briefing_at IS NULL OR date(last_briefing_at) < date('now', '-1 day')`
      );

      for (const user of candidates) {
        const tz = user.timezone || 'America/Chicago';
        const { hour, dateStr } = getUserLocalNow(tz);
        const lastLocalDate = user.last_briefing_at
          ? getUserLocalNow(tz, new Date(user.last_briefing_at + 'Z')).dateStr
          : null;

        if (lastLocalDate === dateStr) continue; // already briefed today, in their own timezone
        if (hour < (user.briefing_hour ?? 7)) continue; // not their briefing hour yet

        logger.info(`Triggering daily briefing schedule for user: ${user.username}`);
        await generateDailyBriefing(db, user.id);
      }
    } catch (err) {
      logger.error('Briefing scheduler checking loop encountered error:', err);
    } finally {
      isRunning = false;
    }
  }, 300000); // 5 minutes
}

module.exports = {
  generateDailyBriefing,
  startBriefingScheduler,
  getUserLocalNow
};
