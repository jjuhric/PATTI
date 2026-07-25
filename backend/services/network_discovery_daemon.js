const { getDb } = require('../db');
const logger = require('../utils/logger');
const { discoverAndSyncNodes } = require('../utils/network_discovery');

let isRunning = false;
let timerId = null;

const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function resolveMainHostUserId(db) {
  const row = await db.get('SELECT user_id FROM user_settings WHERE is_main_host = 1 LIMIT 1');
  return row ? row.user_id : 1;
}

async function runDiscovery() {
  if (isRunning) return;
  isRunning = true;

  try {
    const db = await getDb();
    const userId = await resolveMainHostUserId(db);
    logger.info('[Network Discovery Daemon] Scanning for reachable devices...');
    const nodes = await discoverAndSyncNodes(db, userId);
    logger.info(`[Network Discovery Daemon] Scan complete. ${nodes.length} node(s) registered.`);
  } catch (err) {
    logger.error('[Network Discovery Daemon] Error during background scan:', err);
  } finally {
    isRunning = false;
    timerId = setTimeout(runDiscovery, INTERVAL_MS);
  }
}

function startDaemon() {
  if (timerId) return;
  logger.info('[Network Discovery Daemon] Starting background network device discovery daemon...');
  // Run first scan after 20s (after the other startup daemons have settled)
  timerId = setTimeout(runDiscovery, 20000);
}

function stopDaemon() {
  if (timerId) {
    clearTimeout(timerId);
    timerId = null;
    logger.info('[Network Discovery Daemon] Stopped background network device discovery daemon.');
  }
}

module.exports = {
  startDaemon,
  stopDaemon
};
