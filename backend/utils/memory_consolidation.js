const { getEmbedding, getSemanticSimilarity, storeMemory, deleteMemory } = require('./embeddings');
const { generateText, buildSettingsForUser } = require('./llm_text');
const logger = require('./logger');

// "These are duplicates" bar - matches the codebase-wide convention (memory_tool.js's own
// write-time dedup, routes/memory.js's UI-add dedup, deep_research_tool.js's cache-hit check).
const DUPLICATE_SIMILARITY_THRESHOLD = 0.85;
// A long-term memory that's never been recalled (or wasn't recalled before this tracking
// existed - see db.js's backfill-on-migration) for this many days is eligible for retirement.
const STALE_MEMORY_DAYS = 90;
// Grace window given to a retired memory before the existing expired-memory cleanup
// (runDailyMemoryCheck's own step 1) removes it for good.
const RETIREMENT_GRACE_DAYS = 30;

function parseEmbedding(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

// Union-find clustering: groups memories where every member is >= threshold similar to at
// least one other member of its cluster (not necessarily every other member - same
// transitive-closure behavior as the codebase's other "is this the same thing" groupings).
function clusterBySimilarity(memories) {
  const n = memories.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(i) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(i, j) {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const embA = parseEmbedding(memories[i].embedding);
      const embB = parseEmbedding(memories[j].embedding);
      const sim = getSemanticSimilarity(memories[i].content, embA, memories[j].content, embB);
      if (sim >= DUPLICATE_SIMILARITY_THRESHOLD) union(i, j);
    }
  }

  const clusters = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(memories[i]);
  }
  return [...clusters.values()].filter(c => c.length >= 2);
}

function parseMergeDecision(raw) {
  if (!raw) return null;
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(json)?\n/, '').replace(/\n```$/, '').trim();
  }
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || !['merge', 'keep_separate', 'supersede'].includes(parsed.action)) return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

async function decideMergeAction(llmSettings, cluster) {
  const systemPrompt = `You are PATTI's memory consolidation assistant. You will be shown 2+ candidate long-term memories that were flagged as likely near-duplicates. Decide whether they should be merged into one fact, and if so, produce clean merged wording. If they actually describe different, non-overlapping, or contradictory things (e.g. an old fact vs. a newer superseding one), say so and specify which one should be kept as-is.

Respond with ONLY valid JSON, no markdown code fences, no explanation, in this exact shape:
{"action": "merge" | "keep_separate" | "supersede", "mergedContent": "<final wording, only if action is merge>", "keepIndex": <0-based index of the memory to keep, only if action is supersede>, "reason": "<one sentence>"}`;

  const userPrompt = cluster.map((m, i) => `${i}: ${m.content}`).join('\n');
  const raw = await generateText(llmSettings, systemPrompt, userPrompt);
  return parseMergeDecision(raw);
}

function carryForwardRecallStats(cluster) {
  const recallCount = Math.max(...cluster.map(m => m.recall_count || 0));
  const lastRecalledAt = cluster.reduce((latest, m) => {
    if (!m.last_recalled_at) return latest;
    if (!latest || m.last_recalled_at > latest) return m.last_recalled_at;
    return latest;
  }, null);
  return { recallCount, lastRecalledAt };
}

async function applyMergeDecision(db, userSettings, cluster, decision) {
  if (decision.action === 'keep_separate') return;

  let survivor;
  let losers;
  let mergedContent = null;

  if (decision.action === 'merge') {
    survivor = cluster[0];
    losers = cluster.slice(1);
    mergedContent = (decision.mergedContent && decision.mergedContent.trim()) || survivor.content;
  } else {
    // supersede
    const keepIdx = Number.isInteger(decision.keepIndex) && decision.keepIndex >= 0 && decision.keepIndex < cluster.length
      ? decision.keepIndex
      : 0;
    survivor = cluster[keepIdx];
    losers = cluster.filter((_, i) => i !== keepIdx);
  }

  const { recallCount, lastRecalledAt } = carryForwardRecallStats(cluster);

  // Update the survivor FIRST, before touching the losers - if generating the merged
  // embedding fails partway through, this throws here and the per-cluster catch in
  // mergeDuplicateMemories skips the whole cluster, leaving every row untouched. Deleting
  // the losers first (the old order) meant a failure here could leave them permanently
  // gone with the survivor never having received the merge - real, silent data loss.
  if (mergedContent && mergedContent !== survivor.content) {
    const newEmbedding = await getEmbedding(mergedContent, userSettings);
    await db.run(
      'UPDATE memories SET content = ?, embedding = ?, recall_count = ?, last_recalled_at = ? WHERE id = ?',
      [mergedContent, newEmbedding ? JSON.stringify(newEmbedding) : null, recallCount, lastRecalledAt, survivor.id]
    );
    try {
      await deleteMemory(survivor.content);
      await storeMemory(mergedContent, {
        userId: survivor.user_id,
        level: 'long-term',
        expiresAt: null,
        agentName: survivor.agent_name || null
      });
    } catch (err) {
      logger.warn(`[Memory Consolidation] Failed to refresh LanceDB entry for merged memory ${survivor.id}:`, err.message);
    }
  } else {
    await db.run(
      'UPDATE memories SET recall_count = ?, last_recalled_at = ? WHERE id = ?',
      [recallCount, lastRecalledAt, survivor.id]
    );
  }

  for (const loser of losers) {
    await db.run('DELETE FROM memories WHERE id = ?', [loser.id]);
    try {
      await deleteMemory(loser.content);
    } catch (err) {
      logger.warn(`[Memory Consolidation] Failed to remove loser memory ${loser.id} from LanceDB:`, err.message);
    }
  }
}

async function mergeDuplicateMemories(db, userId, userSettings, llmSettings) {
  const memories = await db.all(
    `SELECT id, content, level, embedding, agent_name, user_id, recall_count, last_recalled_at
     FROM memories WHERE user_id = ? AND level = 'long-term'`,
    [userId]
  );
  if (memories.length < 2) return;

  // Bucket by agent_name (NULL as its own bucket) - mirrors the isSameAgent scoping both
  // existing dedup sites already use. Cross-agent memories must never be compared/merged.
  const buckets = new Map();
  for (const m of memories) {
    const key = m.agent_name || '';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(m);
  }

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const clusters = clusterBySimilarity(bucket);
    for (const cluster of clusters) {
      try {
        const decision = await decideMergeAction(llmSettings, cluster);
        if (!decision) {
          logger.warn(`[Memory Consolidation] Skipping cluster of ${cluster.length} for user ${userId} - malformed/unparseable LLM merge decision.`);
          continue;
        }
        await applyMergeDecision(db, userSettings, cluster, decision);
      } catch (err) {
        logger.warn(`[Memory Consolidation] Failed to process merge cluster for user ${userId}:`, err.message);
      }
    }
  }
}

async function retireStaleMemories(db, userId) {
  const staleRows = await db.all(
    `SELECT id, content, agent_name FROM memories
     WHERE user_id = ? AND level = 'long-term' AND recall_count = 0
       AND COALESCE(last_recalled_at, created_at) <= datetime('now', ?)`,
    [userId, `-${STALE_MEMORY_DAYS} days`]
  );

  for (const row of staleRows) {
    const newExpiresAt = new Date();
    newExpiresAt.setDate(newExpiresAt.getDate() + RETIREMENT_GRACE_DAYS);
    const expiresAtIso = newExpiresAt.toISOString();

    await db.run(
      "UPDATE memories SET level = 'short-term', expires_at = ? WHERE id = ?",
      [expiresAtIso, row.id]
    );
    try {
      await deleteMemory(row.content);
      await storeMemory(row.content, { userId, level: 'short-term', expiresAt: expiresAtIso, agentName: row.agent_name || null });
    } catch (err) {
      logger.warn(`[Memory Consolidation] Failed to refresh LanceDB metadata for retired memory ${row.id}:`, err.message);
    }
  }

  return staleRows.length;
}

async function consolidateUserMemories(db, userId) {
  const userSettings = (await db.get('SELECT * FROM user_settings WHERE user_id = ?', [userId])) || {};

  // Merge needs a configured LLM to adjudicate; retirement doesn't. A user with no
  // user_settings row (buildSettingsForUser throws) should still get the retirement
  // pass rather than having the whole consolidation skipped for them.
  let llmSettings = null;
  try {
    llmSettings = await buildSettingsForUser(db, userId);
  } catch (err) {
    logger.warn(`[Memory Consolidation] No usable LLM settings for user ${userId}, skipping near-duplicate merge pass: ${err.message}`);
  }

  // Merge first, retirement second - evaluated against the post-merge state, so a
  // duplicate's recalled sibling can save it via merging before retirement ever sees it.
  if (llmSettings) {
    await mergeDuplicateMemories(db, userId, userSettings, llmSettings);
  }
  const retiredCount = await retireStaleMemories(db, userId);
  if (retiredCount > 0) {
    logger.info(`[Memory Consolidation] Retired ${retiredCount} stale long-term memories for user ${userId}.`);
  }
}

async function consolidateAllUsersMemories(db) {
  const rows = await db.all("SELECT DISTINCT user_id FROM memories WHERE level = 'long-term'");
  for (const row of rows) {
    try {
      await consolidateUserMemories(db, row.user_id);
    } catch (err) {
      logger.error(`[Memory Consolidation] Failed for user ${row.user_id}:`, err);
    }
  }
}

module.exports = {
  consolidateAllUsersMemories,
  consolidateUserMemories,
  clusterBySimilarity,
  parseMergeDecision,
  DUPLICATE_SIMILARITY_THRESHOLD,
  STALE_MEMORY_DAYS,
  RETIREMENT_GRACE_DAYS
};
