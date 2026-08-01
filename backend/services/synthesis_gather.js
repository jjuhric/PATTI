const { handleTaskResultTool } = require('../tools/task_result_tool');

// Above this combined-character threshold across all subtask_results rows for a
// request, the final synthesis step switches from inlining every row's full text
// directly into one prompt to a bounded read-by-id gather loop (see
// runSynthesisGatherLoop below). Below it, a single small/typical request (e.g.
// one weather lookup) keeps the original one-shot inline behavior unchanged - no
// extra LLM round-trip. Hardware-dependent, so it's overridable via env.
const SYNTHESIS_GATHER_THRESHOLD_CHARS = parseInt(process.env.SYNTHESIS_GATHER_THRESHOLD, 10) || 12000;

// Hard ceiling on the total characters accumulated across the whole gather phase,
// regardless of how many subtask_results rows exist for the request (bounded at
// the Supervisor's own maxToolCalls = 10 delegations per request). Guarantees the
// final synthesis prompt can never blow out a local LLM's context window just
// because the user asked for a lot of unrelated things at once.
const SYNTHESIS_GATHER_AGGREGATE_CAP = 40000;

function formatSourceBlock(agentName, taskLabel, status, content) {
  return `--- [Source: ${agentName}${taskLabel ? ` - ${taskLabel}` : ''}${status === 'error' ? ' - ERRORED' : ''}] ---\n${content}`;
}

/**
 * Assembles the full "DATA_AVAILABLE: yes" block from a list of sources, always led
 * by a code-computed SOURCE CHECKLIST. A DATA_AVAILABLE flag alone wasn't enough to
 * stop a smaller/quantized local model from occasionally ignoring a successful result
 * sitting right there in the prompt (observed: weather_expert succeeded and was fully
 * present in a 3-source prompt, but the final answer still claimed weather "was not
 * available" - the model latched onto the one ERRORED source and generalized from it).
 * An explicit per-source list the model must check off is a much harder thing for it
 * to silently skip than a paragraph of prose data.
 *
 * Successful sources are also ordered before errored ones, so the model reads
 * everything that worked before it has to acknowledge anything that didn't.
 *
 * @param {Array<{agent_name: string, task_label?: string, status: string, content: string}>} sources
 * @returns {string}
 */
function buildDataBlock(sources) {
  if (!sources || sources.length === 0) {
    return 'DATA_AVAILABLE: no';
  }

  const ordered = [...sources].sort((a, b) => {
    const aFailed = a.status === 'error' ? 1 : 0;
    const bFailed = b.status === 'error' ? 1 : 0;
    return aFailed - bFailed;
  });

  const checklist = ordered
    .map((s, i) => `${i + 1}. ${s.agent_name}${s.task_label ? ` (${s.task_label})` : ''}: ${s.status === 'error' ? 'FAILED' : 'SUCCEEDED'}`)
    .join('\n');

  const blocks = ordered.map(s => formatSourceBlock(s.agent_name, s.task_label, s.status, s.content)).join('\n\n');

  return `DATA_AVAILABLE: yes
SOURCE CHECKLIST (computed automatically - address EVERY one of these in your response; a source marked SUCCEEDED must never be reported as missing, unavailable, or still being gathered):
${checklist}

${blocks}`;
}

/**
 * Same full-text concatenation the fast path uses, but hard-capped to `cap`
 * characters total. Used as the safety-net output whenever the gather loop
 * itself fails or a DB read fails - every failure mode still produces a
 * bounded prompt rather than either an unbounded one or a hard-failed response.
 */
async function buildFallbackDataBlock(db, requestId, cap = SYNTHESIS_GATHER_AGGREGATE_CAP) {
  const rows = await db.all(
    'SELECT agent_name, task_label, result_text, status FROM subtask_results WHERE request_id = ? ORDER BY id',
    [requestId]
  );
  if (!rows || rows.length === 0) {
    return 'DATA_AVAILABLE: no';
  }
  let block = buildDataBlock(rows.map(r => ({ agent_name: r.agent_name, task_label: r.task_label, status: r.status, content: r.result_text })));
  if (block.length > cap) {
    block = block.slice(0, cap) + '\n... [TRUNCATED: Response too large for context]';
  }
  return block;
}

/**
 * Bounded, non-streaming tool-calling loop that lets the Communication
 * Specialist read subtask_results rows one at a time (via the task_result
 * tool, by id) instead of having the orchestrator inline everything into one
 * prompt. Reuses the same JSON-decision pattern (`runAgentTurn`) every other
 * agent in this codebase already uses for tool calls. Returns a dataBlock
 * string in the exact same format the fast path produces, so the caller's
 * downstream responderInstruction construction doesn't need to change.
 *
 * @param {object} opts
 * @param {import('sqlite').Database} opts.db
 * @param {string} opts.requestId
 * @param {Array<{id:number, agent_name:string, task_label:string, status:string, char_count:number}>} opts.metaRows
 * @param {string} opts.userMessage
 * @param {object} opts.settings Passed through to runAgentTurn (provider/model/keys/db/userId/etc.)
 * @param {(msg: string) => void} [opts.onThought]
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<string>} dataBlock text (DATA_AVAILABLE: yes/no + formatted sources)
 */
async function runSynthesisGatherLoop({ db, requestId, metaRows, userMessage, settings, onThought = () => {}, abortSignal }) {
  const { runAgentTurn } = require('../utils/agents');

  const commSpecialistSystemPrompt = require('../utils/agents/communication_specialist');
  const mode2SystemPrompt = commSpecialistSystemPrompt.replace(/<!-- START MODE 1 -->[\s\S]*?<!-- END MODE 1 -->/g, '');

  const rowsListing = metaRows
    .map(r => `- id=${r.id}, agent="${r.agent_name}"${r.task_label ? `, label="${r.task_label}"` : ''}, status="${r.status}", ~${r.char_count} chars`)
    .join('\n');

  const gatherSystemPrompt = `${mode2SystemPrompt}

### GATHER PHASE (read data before answering):
You are about to format a final answer, but the underlying results were too large to inline directly. ${metaRows.length} result(s) are available for this request:
${rowsListing}

Read whichever of these you need with {"tool": "task_result", "action": "read", "params": {"id": <id>}} - typically all of them, since the user asked for all of it. Do NOT write the final formatted answer yet in this phase. Once you've read everything relevant, respond with {"tool": "none", "action": "", "params": {}} to finish gathering.`;

  const gatherHistory = [];
  const seenReadIds = new Set();
  const collected = [];
  let aggregateUsed = 0;
  let aggregateExhausted = false;

  const maxTurns = metaRows.length + 2;
  let turn = 0;

  while (turn < maxTurns) {
    if (abortSignal?.aborted) {
      onThought('Synthesis gather loop aborted by user.\n');
      break;
    }

    const decision = await runAgentTurn('communication_specialist_gather', gatherSystemPrompt, settings, userMessage, gatherHistory);

    if (!decision || !decision.tool || decision.tool === 'none') {
      break;
    }

    if (decision.tool !== 'task_result') {
      gatherHistory.push({
        role: 'assistant',
        content: `Thought: ${decision.thought || ''}\nCalling tool: ${decision.tool}`
      });
      gatherHistory.push({
        role: 'user',
        content: `[System] Only the "task_result" tool (action "read") is available in this gather phase. Read a result by id, or set tool to "none" if you're done reading.`
      });
      turn++;
      continue;
    }

    const readId = decision.params?.id ?? decision.params?.result_id;
    const signature = `read:${readId}`;
    if (seenReadIds.has(signature)) {
      onThought(`[Loop Detector] Duplicate task_result read (id=${readId}) in synthesis gather loop - stopping.\n`);
      break;
    }
    seenReadIds.add(signature);

    let toolOutputText;
    if (aggregateExhausted) {
      toolOutputText = 'Aggregate data budget for this request has been exhausted - stop reading and finish up with what you have.';
    } else {
      onThought(`Reading result id=${readId} for final synthesis...\n`);
      const rawOutput = await handleTaskResultTool(db, 'read', decision.params || {}, { requestId });
      toolOutputText = rawOutput;
      try {
        const parsed = JSON.parse(rawOutput);
        if (parsed && typeof parsed.content === 'string') {
          const remaining = SYNTHESIS_GATHER_AGGREGATE_CAP - aggregateUsed;
          if (remaining <= 0) {
            aggregateExhausted = true;
            toolOutputText = 'Aggregate data budget for this request has been exhausted - stop reading and finish up with what you have.';
          } else {
            let content = parsed.content;
            let truncatedForBudget = false;
            if (content.length > remaining) {
              content = content.slice(0, remaining) + '\n... [TRUNCATED: Response too large for context]';
              truncatedForBudget = true;
              aggregateExhausted = true;
            }
            aggregateUsed += content.length;
            collected.push({
              agent_name: parsed.agent_name,
              task_label: parsed.task_label,
              status: parsed.status,
              content
            });
            toolOutputText = truncatedForBudget
              ? `Result id=${readId} read (truncated to fit remaining data budget).`
              : `Result id=${readId} read successfully.`;
          }
        }
      } catch (e) {
        // Non-JSON (e.g. an "Error: ..." string) - pass through as-is, nothing to collect.
      }
    }

    gatherHistory.push({
      role: 'assistant',
      content: `Thought: ${decision.thought || ''}\nCalling tool: task_result read id=${readId}`
    });
    gatherHistory.push({
      role: 'user',
      content: `[Tool Output for task_result]:\n${toolOutputText}`
    });

    turn++;
  }

  if (collected.length === 0) {
    onThought('Synthesis gather loop collected nothing - falling back to bounded direct read.\n');
    return buildFallbackDataBlock(db, requestId, SYNTHESIS_GATHER_AGGREGATE_CAP);
  }

  return buildDataBlock(collected);
}

module.exports = {
  runSynthesisGatherLoop,
  buildFallbackDataBlock,
  buildDataBlock,
  SYNTHESIS_GATHER_THRESHOLD_CHARS,
  SYNTHESIS_GATHER_AGGREGATE_CAP
};
