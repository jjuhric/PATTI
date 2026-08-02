const { getEmbedding, getSemanticSimilarity, storeMemory, searchMemory, deleteMemory } = require('../utils/embeddings');
const { consolidateAllUsersMemories } = require('../utils/memory_consolidation');
const logger = require('../utils/logger');

/**
 * Handles operations for the Memory tool.
 * 
 * @param {import('sqlite').Database} db The SQLite database instance.
 * @param {number} userId The user's ID.
 * @param {string} action The action to perform: 'remember', 'recall', 'forget'.
 * @param {object} params Parameters for the action.
 * @returns {Promise<string>} Text output to be sent to the AI agent.
 */
async function handleMemoryTool(db, userId, action, params = {}) {
  if (!db) {
    return 'Error: Database connection is not available.';
  }

  try {
    switch (action) {
      case 'remember': {
        const { content, level, expiresAt, days, agentName } = params;
        if (!content || typeof content !== 'string' || content.trim() === '') {
          return 'Error: "content" parameter is required and must be a non-empty string for the "remember" action.';
        }

        const cleanContent = content.trim();
        const memLevel = (level === 'short-term' || level === 'long-term') ? level : 'long-term';
        
        let finalExpiresAt = null;
        if (memLevel === 'short-term') {
          if (expiresAt) {
            const parsedDate = new Date(expiresAt);
            if (!isNaN(parsedDate.getTime())) {
              finalExpiresAt = parsedDate.toISOString();
            }
          }
          
          if (!finalExpiresAt && days && typeof days === 'number') {
            const date = new Date();
            date.setDate(date.getDate() + days);
            finalExpiresAt = date.toISOString();
          }

          if (!finalExpiresAt) {
            // Default to 30 days retention
            const date = new Date();
            date.setDate(date.getDate() + 30);
            finalExpiresAt = date.toISOString();
          }
        }

        // Fetch user settings and generate embedding
        const userSettings = (db.get && typeof db.get === 'function') ? (await db.get('SELECT * FROM user_settings WHERE user_id = ?', [userId]) || {}) : {};
        const newEmbedding = await getEmbedding(cleanContent, userSettings);

        // Fetch active memories from vector DB to check for semantic duplicates
        const searchResultJson = await searchMemory(cleanContent, 5);
        const searchResults = JSON.parse(searchResultJson);

        let duplicate = null;
        const now = new Date();
        if (searchResults && searchResults.length > 0) {
          duplicate = searchResults.find(r => {
            const meta = r.metadata || {};
            const isSameUser = meta.userId === userId;
            const isSameAgent = (agentName ? meta.agentName === agentName : !meta.agentName);
            const isNotExpired = (!meta.expiresAt || new Date(meta.expiresAt) > now);
            return isSameUser && isSameAgent && isNotExpired && r.score > 0.85;
          });
        }

        if (duplicate) {
          const sqliteDup = await db.get(
            'SELECT id FROM memories WHERE user_id = ? AND content = ? AND (agent_name = ? OR (? IS NULL AND agent_name IS NULL))',
            [userId, duplicate.text, agentName || null, agentName || null]
          );

          if (sqliteDup) {
            await db.run(
              'UPDATE memories SET content = ?, level = ?, expires_at = ?, embedding = ?, created_at = datetime(\'now\') WHERE id = ?',
              [cleanContent, memLevel, finalExpiresAt, newEmbedding ? JSON.stringify(newEmbedding) : null, sqliteDup.id]
            );

            // Update in LanceDB: delete old text and store new
            try {
              await deleteMemory(duplicate.text);
            } catch (err) {
              console.error('Failed to delete old duplicate from LanceDB:', err);
            }
            await storeMemory(cleanContent, { userId, level: memLevel, expiresAt: finalExpiresAt, agentName: agentName || null });

            return `Already remembered: "${cleanContent}" (Level: ${memLevel}, Memory ID: ${sqliteDup.id}${finalExpiresAt ? `, Expires at: ${finalExpiresAt}` : ''}). Updated existing memory.`;
          }
        }

        const result = await db.run(
          'INSERT INTO memories (user_id, content, level, expires_at, embedding, agent_name) VALUES (?, ?, ?, ?, ?, ?)',
          [userId, cleanContent, memLevel, finalExpiresAt, newEmbedding ? JSON.stringify(newEmbedding) : null, agentName || null]
        );

        await storeMemory(cleanContent, {
          userId,
          level: memLevel,
          expiresAt: finalExpiresAt,
          agentName: agentName || null
        });

        return `Successfully remembered: "${cleanContent}" (Level: ${memLevel}, Memory ID: ${result.lastID}${finalExpiresAt ? `, Expires at: ${finalExpiresAt}` : ''}).`;
      }

      case 'recall':
      case 'query': {
        const { query, agentName } = params;

        if (query && typeof query === 'string' && query.trim() !== '') {
          const cleanQuery = query.trim();
          const searchResultJson = await searchMemory(cleanQuery, 5);
          const searchResults = JSON.parse(searchResultJson);

          const now = new Date();
          const matchedRows = (searchResults || []).filter(r => {
            const meta = r.metadata || {};
            const isSameUser = meta.userId === userId;
            const isSameAgent = (agentName ? meta.agentName === agentName : !meta.agentName);
            const isNotExpired = (!meta.expiresAt || new Date(meta.expiresAt) > now);
            return isSameUser && isSameAgent && isNotExpired && r.score >= 0.35;
          });

          if (matchedRows.length === 0) {
            // Fallback: search for any active memories if search query yielded nothing
            const allActive = await db.all(
              'SELECT id, content, level, expires_at FROM memories WHERE user_id = ? AND (expires_at IS NULL OR expires_at > datetime(\'now\')) AND (agent_name = ? OR (? IS NULL AND agent_name IS NULL)) ORDER BY created_at DESC LIMIT 5',
              [userId, agentName || null, agentName || null]
            );
            if (allActive.length > 0) {
              return `No memories matched your search for "${query}". Here are the most recent general memories:\n` +
                allActive.map(r => `- [ID ${r.id}] ${r.content} (${r.level}${r.expires_at ? `, expires: ${r.expires_at}` : ''})`).join('\n');
            }
          } else {
            // Look up SQLite IDs for retrieved records to match return formatting
            const matchedRowsWithIds = await Promise.all(matchedRows.map(async r => {
              const sqliteRow = await db.get(
                'SELECT id FROM memories WHERE user_id = ? AND content = ? AND (agent_name = ? OR (? IS NULL AND agent_name IS NULL))',
                [userId, r.text, agentName || null, agentName || null]
              );
              if (sqliteRow) {
                // Only true semantic-relevance matches count as a "recall" - this is what
                // utils/memory_consolidation.js uses to decide whether a long-term memory has
                // actually been used, not just listed. The "no query"/"zero-match fallback"
                // branches below deliberately do not bump this.
                await db.run(
                  'UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = datetime(\'now\') WHERE id = ?',
                  [sqliteRow.id]
                );
              }
              return {
                id: sqliteRow ? sqliteRow.id : 'unknown',
                content: r.text,
                level: r.metadata?.level || 'long-term',
                expires_at: r.metadata?.expiresAt || null
              };
            }));

            return `Retrieved memories:\n` +
              matchedRowsWithIds.map(r => `- [ID ${r.id}] ${r.content} (${r.level}${r.expires_at ? `, expires: ${r.expires_at}` : ''})`).join('\n');
          }
          return 'No active memories found.';
        }

        const rows = await db.all(
          'SELECT id, content, level, expires_at, embedding FROM memories WHERE user_id = ? AND (expires_at IS NULL OR expires_at > datetime(\'now\')) AND (agent_name = ? OR (? IS NULL AND agent_name IS NULL))',
          [userId, agentName || null, agentName || null]
        );

        if (rows.length === 0) {
          return 'No active memories found.';
        }

        // Return most recent memories if no query was provided
        const allActive = await db.all(
          'SELECT id, content, level, expires_at FROM memories WHERE user_id = ? AND (expires_at IS NULL OR expires_at > datetime(\'now\')) AND (agent_name = ? OR (? IS NULL AND agent_name IS NULL)) ORDER BY created_at DESC',
          [userId, agentName || null, agentName || null]
        );
        return `Retrieved memories:\n` +
          allActive.map(r => `- [ID ${r.id}] ${r.content} (${r.level}${r.expires_at ? `, expires: ${r.expires_at}` : ''})`).join('\n');
      }

      case 'forget': {
        const { memoryId } = params;
        if (!memoryId) {
          return 'Error: "memoryId" parameter is required for the "forget" action.';
        }

        const result = await db.run(
          'DELETE FROM memories WHERE id = ? AND user_id = ?',
          [memoryId, userId]
        );

        if (result.changes === 0) {
          return `No memory found with ID ${memoryId} for this user.`;
        }

        return `Successfully forgotten memory ID ${memoryId}.`;
      }

      default:
        return `Error: Unknown memory action "${action}". Supported actions are: 'remember', 'recall', 'forget'.`;
    }
  } catch (err) {
    console.error('Memory tool error:', err);
    return `Error performing memory action: ${err.message}`;
  }
}

/**
 * Deletes expired memories, merges/retires stale long-term memories (see
 * utils/memory_consolidation.js), and scans active memories for today's-date
 * reminders to auto-register as calendar entries. Runs once at boot plus every
 * 24h (see server.js) - the only periodic-maintenance job in this codebase.
 *
 * @param {import('sqlite').Database} db SQLite database instance.
 */
async function runDailyMemoryCheck(db) {
  if (!db) return;

  try {
    // 1. Delete expired memories
    const deleteResult = await db.run('DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= datetime(\'now\')');
    if (deleteResult.changes > 0) {
      logger.info(`Cleaned up ${deleteResult.changes} expired memories.`);
    }

    // 2. Merge near-duplicate and retire stale long-term memories - see
    // utils/memory_consolidation.js. Runs after the expired-memory delete above so
    // retirement's grace-period downgrade starts counting from a consistent state.
    await consolidateAllUsersMemories(db);

    // 3. Fetch active memories to scan for today's reminders
    const activeMemories = await db.all(
      'SELECT id, user_id, content FROM memories WHERE expires_at IS NULL OR expires_at > datetime(\'now\')'
    );

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const todayISO = `${yyyy}-${mm}-${dd}`;

    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const monthName = monthNames[now.getMonth()];
    const todayVerbal = `${monthName} ${now.getDate()}`;
    const todayVerbalFull = `${monthName} ${now.getDate()}, ${yyyy}`;

    for (const mem of activeMemories) {
      const contentLower = mem.content.toLowerCase();
      const matchISO = contentLower.includes(todayISO);
      const matchVerbal = contentLower.includes(todayVerbal.toLowerCase());
      const matchVerbalFull = contentLower.includes(todayVerbalFull.toLowerCase());

      if (matchISO || matchVerbal || matchVerbalFull) {
        const title = `Reminder: ${mem.content}`;
        const startTime = `${todayISO} 09:00`;
        const endTime = `${todayISO} 10:00`;

        const existing = await db.get(
          'SELECT id FROM calendar_events WHERE user_id = ? AND title = ? AND start_time = ?',
          [mem.user_id, title, startTime]
        );

        if (!existing) {
          await db.run(
            'INSERT INTO calendar_events (user_id, title, start_time, end_time, description) VALUES (?, ?, ?, ?, ?)',
            [mem.user_id, title, startTime, endTime, 'Automatically scheduled from AI Memory Vault']
          );
          logger.info(`Auto-scheduled calendar reminder event for memory: "${mem.content}"`);
        }
      }
    }
  } catch (err) {
    logger.error('Error running daily memory check:', err);
  }
}

module.exports = { handleMemoryTool, runDailyMemoryCheck };
