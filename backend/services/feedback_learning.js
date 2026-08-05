const { storeLearnedBehavior, searchLearnedBehaviors } = require('../utils/embeddings');

// Known agents list for simple heuristic extraction from corrections
const AGENTS_LIST = [
  'weather_expert',
  'system_specialist',
  'node_agent',
  'memory_agent',
  'calendar_handler',
  'web_searcher',
  'document_vault',
  'developer_agent',
  'qa_engineer',
  'tool_creator_agent',
  'agent_creator_agent',
  'deep_research_agent'
];

async function handleUserFeedback(db, userId, chatId, userMessage) {
  try {
    // 1. Fetch previous messages to understand context
    const history = await db.all(
      'SELECT id, role, content, agents_used FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 5',
      [chatId]
    );
    if (!history || history.length < 2) return; // Need at least some history

    const lastAssistantMsg = history.find(m => m.role === 'assistant');
    // Find the original user prompt before the assistant's turn
    const previousUserMsg = history.find(m => m.role === 'user' && m.id < (lastAssistantMsg ? lastAssistantMsg.id : Infinity));

    if (!previousUserMsg) return;

    // BUG-13 (docs/REVIEW_2026-08-03.md): which worker agent(s), if any, the previous turn
    // actually delegated to - captured live in routes/chat.js since subtask_results (the
    // richer per-subtask record) is wiped at the end of every turn as scratchpad cleanup.
    let agentsUsed = [];
    if (lastAssistantMsg && lastAssistantMsg.agents_used) {
      try {
        agentsUsed = JSON.parse(lastAssistantMsg.agents_used);
      } catch (e) {
        agentsUsed = [];
      }
    }

    const lowerMessage = userMessage.toLowerCase();

    // 2. Positive Reinforcement Detection
    const positiveKeywords = /\b(good|perfect|great|awesome|excellent|amazing|works)\b/i;
    if (positiveKeywords.test(userMessage)) {
      console.log(`[Feedback System] Positive reinforcement detected: "${userMessage}"`);
      await storeLearnedBehavior(previousUserMsg.content, {
        type: 'success',
        userPrompt: previousUserMsg.content,
        agentsUsed,
        feedback: userMessage,
        timestamp: new Date().toISOString()
      });
      return;
    }

    // 3. Correction Detection
    const correctionKeywords = /\b(no|wrong|incorrect|should have|instead|use|ask|route to)\b/i;
    if (correctionKeywords.test(userMessage)) {
      // Check if user named any specific agent to route to
      let matchedAgent = null;
      for (const agent of AGENTS_LIST) {
        // Handle variations (e.g. "weather expert" -> "weather_expert")
        const normalizedAgent = agent.replace('_', ' ');
        if (lowerMessage.includes(agent) || lowerMessage.includes(normalizedAgent)) {
          matchedAgent = agent;
          break;
        }
      }

      if (matchedAgent) {
        console.log(`[Feedback System] Correction detected. Directing "${previousUserMsg.content}" -> "${matchedAgent}"`);
        await storeLearnedBehavior(previousUserMsg.content, {
          type: 'correction',
          correctAgent: matchedAgent,
          // What actually ran and got corrected away from, when known - lets a future
          // read of this record distinguish "wrong agent used" from "right agent, bad output".
          agentsUsed,
          userPrompt: previousUserMsg.content,
          feedback: userMessage,
          timestamp: new Date().toISOString()
        });
      }
    }
  } catch (err) {
    console.error('[Feedback System] Error handling user feedback:', err);
  }
}

async function getInjectedContext(queryText) {
  try {
    const matches = await searchLearnedBehaviors(queryText, 3);
    const relevantRules = matches.filter(m => m.score > 0.75);
    
    if (relevantRules.length === 0) return '';

    let context = `\n### CRITICAL: LEARNED ROUTING DIRECTIVES (PRIORITY RULES):\n`;
    context += `You have previously received explicit corrections or success workflows for similar queries. You MUST prioritize these directives:\n`;

    relevantRules.forEach(rule => {
      const meta = rule.metadata;
      if (meta.type === 'correction' && meta.correctAgent) {
        context += `- For queries similar to "${meta.userPrompt}", you MUST delegate directly to the **${meta.correctAgent}** sub-agent.\n`;
      } else if (meta.type === 'success') {
        // BUG-13: only claim a specific repeatable agent sequence when we actually know it -
        // an empty/missing agentsUsed means the turn never delegated to a worker agent at all
        // (e.g. communication_specialist answered directly), so say that plainly instead of
        // pointing at a "successful sequence" that doesn't exist.
        if (meta.agentsUsed && meta.agentsUsed.length > 0) {
          context += `- Successful past workflow for similar query "${meta.userPrompt}": delegate to **${meta.agentsUsed.join(', ')}**, which worked well last time.\n`;
        } else {
          context += `- Successful past workflow for similar query "${meta.userPrompt}": answered directly with no sub-agent delegation, and that worked well.\n`;
        }
      }
    });

    return context;
  } catch (err) {
    console.error('[Feedback System] Error generating injected context:', err);
    return '';
  }
}

module.exports = {
  handleUserFeedback,
  getInjectedContext
};
