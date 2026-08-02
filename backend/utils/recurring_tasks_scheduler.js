const { handleWeatherTool } = require('../tools/weather_tool');
const { handleGoogleNewsTool } = require('../ai');
const { generateText, buildSettingsForUser } = require('./llm_text');
const { getUserLocalNow } = require('./timezone');
const { getTodayEventsFormatted, getUserMemoriesFormatted } = require('./scheduled_digest_helpers');
const { notifyUser } = require('./notifications');
const logger = require('./logger');

const RESULTS_CHAT_TITLE = 'Recurring Tasks';

async function postToResultsChat(db, userId, content) {
  let chat = await db.get('SELECT * FROM chats WHERE user_id = ? AND title = ?', [userId, RESULTS_CHAT_TITLE]);
  if (!chat) {
    const result = await db.run('INSERT INTO chats (user_id, title) VALUES (?, ?)', [userId, RESULTS_CHAT_TITLE]);
    chat = { id: result.lastID, title: RESULTS_CHAT_TITLE };
  }
  await db.run('INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)', [chat.id, 'assistant', content]);
  return chat.id;
}

// Executes one due recurring task: gathers the same fixed, cheap data sources the
// daily briefing already gathers unconditionally every time (weather, today's
// calendar, memories), plus news only if the task specified a news_query at creation
// time - no LLM-driven tool selection at execution time at all, so this can run
// entirely deterministically on a plain setInterval tick. See utils/briefing.js for
// the same pattern this is generalized from.
async function runRecurringTask(db, task) {
  const tz = task.timezone || 'America/Chicago';
  const { dateStr } = getUserLocalNow(tz);

  const weatherText = await handleWeatherTool(db, task.user_id, 'current', {});
  const eventsText = await getTodayEventsFormatted(db, task.user_id, dateStr);
  const memoriesText = await getUserMemoriesFormatted(db, task.user_id);

  let newsText = 'Not requested for this task.';
  if (task.news_query) {
    try {
      newsText = await handleGoogleNewsTool(task.news_query);
    } catch (err) {
      newsText = `News retrieval offline: ${err.message}`;
    }
  }

  const systemPrompt = `You are PATTI's Recurring Task Assistant, answering a specific standing request "${task.label}" that ${task.name || task.username} set up to run automatically.
Answer this specific request: "${task.prompt}", using only what's relevant from the data below. Do not include sections the request didn't ask for - if it only asked for weather and news, don't add a calendar summary just because the data is present. Use rich markdown with emoji headings, matching the tone of a friendly personal digest.`;

  const userPrompt = `
### Today's Date: ${dateStr}

### User Profile:
- Name: ${task.name || task.username}
- Temp Unit: ${task.temp_unit || 'imperial'}

### Weather Forecast:
${weatherText}

### Today's Schedule:
${eventsText}

### User Preferences/Memories:
${memoriesText}

### News:
${newsText}

Generate the response to "${task.prompt}" now. Keep it focused, well-structured, and warm.
`;

  const llmSettings = await buildSettingsForUser(db, task.user_id);
  const content = await generateText(llmSettings, systemPrompt, userPrompt);

  const resultsChatId = await postToResultsChat(db, task.user_id, content);
  await db.run('UPDATE recurring_tasks SET last_run_at = datetime(\'now\') WHERE id = ?', [task.id]);
  await notifyUser(db, task.user_id, { type: 'info', message: `Your recurring task "${task.label}" is ready.`, chatId: resultsChatId });
}

// Background scheduler checker, same shape as utils/briefing.js's startBriefingScheduler -
// a single 5-minute poll shared across all users/tasks, with per-task eligibility (day of
// week, local hour, already-run-today) resolved individually via getUserLocalNow since a
// single shared SQL comparison can't correctly gate tasks across different timezones.
let isRunning = false;
function startRecurringTaskScheduler(db) {
  setInterval(async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      const candidates = await db.all(
        `SELECT rt.*, u.timezone, u.name, u.username, u.temp_unit
         FROM recurring_tasks rt
         JOIN users u ON u.id = rt.user_id
         WHERE rt.is_active = 1`
      );

      for (const task of candidates) {
        const tz = task.timezone || 'America/Chicago';
        const { hour, dateStr, weekday } = getUserLocalNow(tz);
        const lastLocalDate = task.last_run_at
          ? getUserLocalNow(tz, new Date(task.last_run_at + 'Z')).dateStr
          : null;

        if (lastLocalDate === dateStr) continue; // already ran today, in the user's own timezone
        if (!task.days_of_week.split(',').includes(weekday)) continue; // not scheduled today
        if (hour < task.hour) continue; // not time yet

        try {
          logger.info(`Triggering recurring task "${task.label}" for user: ${task.username}`);
          await runRecurringTask(db, task);
        } catch (err) {
          // Deliberately do NOT update last_run_at on failure, so this task naturally
          // retries on the next 5-minute tick within the same local day - matches
          // briefing.js's own failure-retry convention exactly. One task failing must
          // not stop the rest of this tick's candidates from running.
          logger.error(`Recurring task "${task.label}" failed for user ${task.username}:`, err);
          try {
            await notifyUser(db, task.user_id, { type: 'error', message: `Your recurring task "${task.label}" failed to run.` });
          } catch (notifyErr) {
            logger.warn('Failed to send recurring task failure notification:', notifyErr.message);
          }
        }
      }
    } catch (err) {
      logger.error('Recurring task scheduler checking loop encountered error:', err);
    } finally {
      isRunning = false;
    }
  }, 300000); // 5 minutes
}

module.exports = { startRecurringTaskScheduler, runRecurringTask };
