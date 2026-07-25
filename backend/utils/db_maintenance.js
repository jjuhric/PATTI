const logger = require('./logger');

// Removes the gateway/router node (192.168.1.1) and de-duplicates network_nodes by
// ip_address, preferring the 'google_home' entry then the oldest row per IP.
async function cleanupDuplicateNodes(db) {
  const delGateway = await db.run("DELETE FROM network_nodes WHERE ip_address = '192.168.1.1'");

  const keepIdsResult = await db.all(`
    SELECT id, ip_address, device_type FROM (
      SELECT id, ip_address, device_type,
             ROW_NUMBER() OVER (
               PARTITION BY ip_address
               ORDER BY CASE WHEN device_type = 'google_home' THEN 0 ELSE 1 END, id ASC
             ) as rn
      FROM network_nodes
    ) WHERE rn = 1
  `);

  const keepIds = keepIdsResult.map(row => row.id);
  let duplicatesDeleted = 0;

  if (keepIds.length > 0) {
    const placeholders = keepIds.map(() => '?').join(',');
    const delDuplicates = await db.run(
      `DELETE FROM network_nodes WHERE id NOT IN (${placeholders})`,
      keepIds
    );
    duplicatesDeleted = delDuplicates.changes;
  }

  return {
    gatewayNodesDeleted: delGateway.changes,
    duplicateNodesDeleted: duplicatesDeleted
  };
}

module.exports = { cleanupDuplicateNodes };
