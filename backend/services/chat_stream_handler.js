const { enqueue } = require('./ai_queue');
const { runAgentLoop } = require('../ai');
const { decrypt } = require('../utils/crypto');

// Provider-aware env var fallback: lets a user configure an online key purely via
// environment variables without touching Settings UI. Kept in sync with the copy that
// used to live inline in routes/chat.js.
function envKeyForProvider(provider) {
  if (provider === 'anthropic') return process.env.ANTHROPIC_API_KEY || '';
  if (provider === 'openai') return process.env.OPENAI_API_KEY || '';
  return process.env.GEMINI_API_KEY || '';
}

/**
 * Runs one full agent generation turn against the host's configured LLM: resolves the
 * model, switches the loaded local model if needed, and executes runAgentLoop through the
 * shared ai_queue (host requests always win; PATTI-client requests can be preempted or
 * rejected outright - see ai_queue.js).
 *
 * Used by both the local host /chat/stream route and the /api/bridge/chat-stream route,
 * so host-vs-client arbitration and LM Studio model-switching logic only exist once.
 * Every callback here is a straight passthrough (no internal accumulation) so each caller
 * stays free to decide what to do with each event - e.g. the local route accumulates
 * content/thoughts into closured variables for saving to its own DB on abort/completion,
 * while the bridge route just relays events verbatim over its own SSE response.
 */
async function runChatStream({
  db,
  userId,
  chatId,
  message,
  images,
  history,
  settings,
  onThought,
  onContent,
  onToolCall,
  onAgentStatus,
  onModelUsed,
  onSystemNotice,
  onCommandApprovalRequired,
  abortController,
  origin,
  nodeId,
  taskName
}) {
  // Resolve preferred model names dynamically
  let actualModel = settings.model_name;
  if (settings.provider === 'local') {
    actualModel = settings.preferred_local_model || settings.model_name || 'google/gemma-4-e4b';
  } else if (settings.provider !== 'local' && settings.preferred_online_model) {
    actualModel = settings.preferred_online_model;
  }

  const decryptedLocalKey = decrypt(settings.local_key);
  const decryptedOnlineKey = decrypt(settings.online_key);
  const decryptedGeminiKey = decrypt(settings.gemini_key);

  const selectorSettings = {
    provider: settings.provider,
    modelName: actualModel,
    onlineProvider: settings.online_provider || 'gemini',
    onlineKey: decryptedOnlineKey || decryptedGeminiKey || envKeyForProvider(settings.online_provider || 'gemini'),
    geminiKey: decryptedGeminiKey || decryptedOnlineKey || process.env.GEMINI_API_KEY || '',
    localBaseUrl: settings.local_url || process.env.LOCAL_LLM_URL || 'http://192.168.1.42:1234/v1',
    localApiKey: decryptedLocalKey || process.env.LOCAL_LLM_KEY || '',
    localApiStyle: settings.local_api_style || 'openai'
  };

  const { selectBestModel } = require('../utils/model_selector');
  let selectedModel = actualModel;
  try {
    selectedModel = await selectBestModel(selectorSettings, message, history);
  } catch (selErr) {
    console.error('Model selection routing failed:', selErr);
  }

  // If local provider and model changed, handle unloading of old and loading of new
  if (settings.provider === 'local') {
    const { listLocalModels, loadLocalModel, unloadLocalModel } = require('../utils/lmstudio');
    const localBaseUrl = selectorSettings.localBaseUrl;
    const localApiKey = selectorSettings.localApiKey;

    try {
      const availableModels = await listLocalModels(localBaseUrl, localApiKey);
      const loadedModelObj = availableModels.find(m => m.isLoaded);
      const loadedModel = loadedModelObj ? loadedModelObj.id : null;

      if (loadedModel && loadedModel !== selectedModel) {
        onSystemNotice(`[System] Unloading model '${loadedModel}' and loading '${selectedModel}'... Please wait.\n`);
        if (loadedModelObj.instanceId) {
          await unloadLocalModel(localBaseUrl, localApiKey, loadedModelObj.instanceId);
        }
        await loadLocalModel(localBaseUrl, localApiKey, selectedModel);
      } else if (!loadedModel) {
        // Cold-start load
        onSystemNotice(`[System] Loading model '${selectedModel}'... Please wait.\n`);
        await loadLocalModel(localBaseUrl, localApiKey, selectedModel);
      }
    } catch (switchErr) {
      console.error('Local model switching failed:', switchErr);
      onSystemNotice(`[System] Warning: Local model switching failed: ${switchErr.message}. Proceeding anyway.\n`);
    }
  }

  const actualModelUsed = selectedModel;
  onModelUsed(actualModelUsed);

  try {
    const { broadcastAlert } = require('../routes/alerts');
    broadcastAlert({ type: 'streaming_status', isStreaming: true });
  } catch (e) {
    // BUG-12 (docs/REVIEW_2026-08-03.md): best-effort monitor-dashboard notification - the
    // chat turn itself must not fail just because the alert bus is down. Logged so a
    // persistently broken alert bus isn't invisible.
    console.debug('[Chat Stream Alert] Failed to broadcast streaming_status:', e.message);
  }

  await enqueue(async (onThoughtCallback) => {
    try {
      await runAgentLoop({
        db,
        userId,
        chatId,
        provider: settings.provider,
        modelName: actualModelUsed,
        supervisorModel: actualModelUsed,
        userMessage: message,
        images,
        history,
        localBaseUrl: selectorSettings.localBaseUrl,
        localApiKey: selectorSettings.localApiKey,
        localApiStyle: settings.local_api_style || 'openai',
        onlineUrl: settings.online_url,
        onlineKey: selectorSettings.onlineKey,
        geminiKey: selectorSettings.geminiKey,
        onlineProvider: settings.online_provider || 'gemini',
        isAborted: () => abortController.signal.aborted,
        abortSignal: abortController.signal,
        onThought: (thoughtChunk) => {
          onThought(thoughtChunk);
          onThoughtCallback(thoughtChunk);
        },
        onContent,
        onToolCall: (toolCall) => {
          onToolCall(toolCall);
          try {
            const { broadcastAlert } = require('../routes/alerts');
            broadcastAlert({ type: 'tool_call', toolCall });
          } catch (e) {
            // BUG-12: same best-effort monitor-dashboard notification as above.
            console.debug('[Chat Stream Alert] Failed to broadcast tool_call:', e.message);
          }
        },
        onAgentStatus: (statusData) => {
          onAgentStatus(statusData);
          try {
            const { broadcastAlert } = require('../routes/alerts');
            broadcastAlert({
              type: 'agent_status',
              agent: statusData.agent,
              status: statusData.status
            });
          } catch (e) {
            // BUG-12: same best-effort monitor-dashboard notification as above.
            console.debug('[Chat Stream Alert] Failed to broadcast agent_status:', e.message);
          }
        },
        onCommandApprovalRequired
      });
    } finally {
      try {
        const { broadcastAlert } = require('../routes/alerts');
        broadcastAlert({ type: 'agent_status', agent: 'communication_specialist', status: 'active' });
      } catch (e) {
        // BUG-12: same best-effort monitor-dashboard notification as above.
        console.debug('[Chat Stream Alert] Failed to broadcast final agent_status reset:', e.message);
      }
    }
  }, { nodeId, name: taskName || 'Chat Request', origin, abortController });

  return { model: actualModelUsed };
}

module.exports = { runChatStream };
