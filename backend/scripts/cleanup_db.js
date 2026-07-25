const { getDb } = require('../db');
const logger = require('../utils/logger');
const path = require('path');
const { cleanupDuplicateNodes } = require('../utils/db_maintenance');

// Set environment variable to make sure it loads the correct DB path if configured
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'database.db');

async function runCleanup() {
  try {
    const db = await getDb();
    logger.info('Starting database node duplicates cleanup...');

    const result = await cleanupDuplicateNodes(db);
    logger.info(`Deleted gateway/subnet router nodes (192.168.1.1): ${result.gatewayNodesDeleted}`);
    logger.info(`Deleted duplicate network node entries: ${result.duplicateNodesDeleted}`);

    logger.info('Database cleanup complete.');
    process.exit(0);
  } catch (err) {
    logger.error(`Database cleanup failed: ${err.message}`);
    process.exit(1);
  }
}

runCleanup();
