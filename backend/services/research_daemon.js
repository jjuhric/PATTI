const { getDb } = require('../db');
const logger = require('../utils/logger');
const { decrypt } = require('../utils/crypto');
const { runWorkerAgent } = require('../utils/agents');

function extractWorkerOutput(rawOutput) {
  if (!rawOutput) return '';
  const trimmed = rawOutput.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && (parsed.status === 'success' || parsed.status === 'error')) {
      if (parsed.data && typeof parsed.data === 'object' && Object.keys(parsed.data).length > 0) {
        return JSON.stringify(parsed.data);
      }
      if (parsed.data && typeof parsed.data === 'string' && parsed.data.trim().length > 0) {
        return parsed.data;
      }
      if (parsed.summary && typeof parsed.summary === 'string') {
        const s = parsed.summary.trim();
        let cleanS = s;
        if (cleanS.startsWith('```')) {
          cleanS = cleanS.replace(/^```(json)?\n/, '').replace(/\n```$/, '').trim();
        }
        if (cleanS.startsWith('{') || cleanS.startsWith('[')) {
          return cleanS;
        }
      }
      if (parsed.summary) {
        return parsed.summary;
      }
      return JSON.stringify(parsed.data || {});
    }
    return trimmed;
  } catch (e) {
    return trimmed;
  }
}

let isRunning = false;
let timerId = null;

async function checkAndRunResearch() {
  if (isRunning) return;
  isRunning = true;
  // Every early-return branch below only records how long to wait before the next
  // check - the actual (single) setTimeout call happens once, in `finally`. Scheduling
  // it at each early-return site too (as this used to do) doesn't get cancelled by
  // reassigning `timerId` afterward - the earlier timer is still live, so every one of
  // these branches ended up scheduling TWO checkAndRunResearch calls 30(or 5) minutes
  // later instead of one, doubling the number of live timers roughly every cycle.
  let nextDelayMs = 30 * 60 * 1000;

  try {
    const db = await getDb();

    // Check if current hour is between 12 AM and 5 AM local time
    const currentHour = new Date().getHours();
    const isTimeWindow = currentHour >= 0 && currentHour < 5;
    if (!isTimeWindow) {
      logger.info(`[Research Daemon] Outside of 12 AM - 5 AM research window (current hour: ${currentHour}). Skipping.`);
      return;
    }

    // Check if the model is currently active/processing
    const isModelIdle = (global.activeAgentOps || 0) === 0;
    if (!isModelIdle) {
      logger.info('[Research Daemon] Model is actively processing another operation. Deferring research run.');
      nextDelayMs = 5 * 60 * 1000;
      return;
    }

    // Check last update timestamp to ensure we only run once per day
    const lastUpdate = await db.get('SELECT MAX(query_date) as last_run FROM coding_language_updates');
    const eighteenHoursAgo = Date.now() - (18 * 60 * 60 * 1000);

    if (lastUpdate && lastUpdate.last_run) {
      const lastRunMs = new Date(lastUpdate.last_run + 'Z').getTime();
      if (lastRunMs > eighteenHoursAgo) {
        logger.info(`[Research Daemon] Already ran daily research recently (last run: ${lastUpdate.last_run}). Skipping check.`);
        return;
      }
    }

    logger.info('[Research Daemon] Language updates are stale or missing. Starting web research...');

    // Load active settings and user ID
    const dbSettings = await db.get('SELECT * FROM user_settings LIMIT 1');
    if (!dbSettings) {
      logger.warn('[Research Daemon] User settings not found. Delaying research.');
      nextDelayMs = 5 * 60 * 1000; // retry in 5 min
      return;
    }

    const firstUser = await db.get('SELECT id FROM users ORDER BY id ASC LIMIT 1');
    if (!firstUser) {
      logger.warn('[Research Daemon] User not found. Delaying research.');
      nextDelayMs = 5 * 60 * 1000;
      return;
    }

    // Build settings context for agent run
    const settings = {
      provider: dbSettings.provider,
      modelName: dbSettings.preferred_online_model || dbSettings.model_name,
      onlineProvider: dbSettings.online_provider,
      onlineKey: decrypt(dbSettings.online_key),
      geminiKey: decrypt(dbSettings.gemini_key),
      localBaseUrl: dbSettings.local_url,
      localApiKey: decrypt(dbSettings.local_key),
      localApiStyle: dbSettings.local_api_style,
      onlineUrl: dbSettings.online_url,
      workingDirectory: dbSettings.working_directory,
      db,
      userId: firstUser.id
    };

    const taskPrompt = `Scour the web for the latest updates, releases, features, API deprecations, or breaking changes in Rust, C++, Python, and Javascript. For each language, list any new versions released, key features, and deprecated syntax/breaking changes that could cause errors in modern code. Return a clean JSON list of language objects, each containing: language, summary, breaking_changes (list of rules or patterns), source_urls.`;

    const resultText = await runWorkerAgent('research_agent', settings, taskPrompt, db, firstUser.id);
    
    // Clean response
    let cleanedText = extractWorkerOutput(resultText);
    if (cleanedText.startsWith('```')) {
      cleanedText = cleanedText.replace(/^```(json)?\n/, '').replace(/\n```$/, '');
    }
    
    try {
      const languagesData = JSON.parse(cleanedText);
      if (Array.isArray(languagesData)) {
        for (const data of languagesData) {
          const lang = (data.language || '').toLowerCase();
          const summary = data.update_summary || data.summary || 'No summary';
          const breaking = JSON.stringify(data.breaking_changes || []);
          const urls = data.source_urls || '';

          // Insert or replace newest update for this language
          await db.run(
            'INSERT INTO coding_language_updates (language, update_summary, breaking_changes, query_date, source_urls) VALUES (?, ?, ?, datetime("now"), ?)',
            [lang, summary, breaking, urls]
          );
        }
        logger.info('[Research Daemon] Scouring complete. Saved updates for: ' + languagesData.map(d => d.language).join(', '));
      } else {
        throw new Error('Research Agent output is not an array.');
      }
    } catch (parseErr) {
      logger.error('[Research Daemon] Failed to parse agent JSON output: ' + parseErr.message + '\nRaw Output: ' + resultText);
    }

  } catch (err) {
    logger.error('[Research Daemon] Background research job failed: ' + err.message);
  } finally {
    isRunning = false;
    timerId = setTimeout(checkAndRunResearch, nextDelayMs);
  }
}

function startDaemon() {
  if (timerId) return;
  logger.info('[Research Daemon] Starting background language research daemon...');
  // Run first check after 10 seconds to allow DB to fully load
  timerId = setTimeout(checkAndRunResearch, 10000);
}

function stopDaemon() {
  if (timerId) {
    clearTimeout(timerId);
    timerId = null;
    logger.info('[Research Daemon] Stopped background language research daemon.');
  }
}

module.exports = {
  startDaemon,
  stopDaemon
};
