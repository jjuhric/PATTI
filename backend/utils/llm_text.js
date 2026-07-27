const { GoogleGenerativeAI } = require('@google/generative-ai');
const { decrypt } = require('./crypto');
const { llmFetchSignal } = require('./fetchTimeout');
const { defaultOnlineBaseUrl, resolveTarget, resolveEndpoint, buildHeaders, buildBody, extractResponseText } = require('../llm/provider_config');
const { stripThinkTags } = require('../llm/think_filter');

// Build the LLM-calling settings object for a specific userId with no active HTTP request
// in scope - same approach backend/services/research_daemon.js uses for its own background
// LLM calls (used by callers whose LLM call happens after the original request already returned,
// or that were never triggered by an HTTP request at all).
async function buildSettingsForUser(db, userId) {
  const dbSettings = await db.get('SELECT * FROM user_settings WHERE user_id = ?', [userId]);
  if (!dbSettings) {
    throw new Error('User settings not found.');
  }
  return {
    provider: dbSettings.provider,
    modelName: dbSettings.preferred_local_model || dbSettings.model_name,
    onlineProvider: dbSettings.online_provider,
    onlineKey: decrypt(dbSettings.online_key),
    geminiKey: decrypt(dbSettings.gemini_key),
    localBaseUrl: dbSettings.local_url,
    localApiKey: decrypt(dbSettings.local_key),
    localApiStyle: dbSettings.local_api_style,
    onlineUrl: dbSettings.online_url,
    db,
    userId
  };
}

// Single non-streaming text-completion call, serialized through the same ai_queue every
// foreground chat request already goes through (backend/services/ai_queue.js). Without this,
// a background LLM call and a concurrent foreground chat turn can both hit the local LLM server
// at once - most local servers only run one generation at a time, so the second request gets cut
// off ("LLM error: 400 - terminated") instead of queuing politely.
// A short retry-with-backoff on top of that covers the rare genuinely-transient hiccup.
async function generateText(settings, systemPrompt, userPrompt) {
  const { enqueue } = require('../services/ai_queue');
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await enqueue(
        () => generateTextRaw(settings, systemPrompt, userPrompt),
        { nodeId: 'llm-text', name: 'LLM Text Generation' }
      );
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
  }
  throw lastErr;
}

async function generateTextRaw(settings, systemPrompt, userPrompt) {
  const { provider, modelName, onlineProvider, onlineKey, geminiKey, localBaseUrl, localApiKey, localApiStyle, onlineUrl, db, userId } = settings;
  const isGemini = provider === 'gemini' || (provider === 'online' && onlineProvider === 'gemini');
  let respText = '';

  if (isGemini) {
    const activeKey = provider === 'gemini' ? (geminiKey || onlineKey) : onlineKey;
    if (!activeKey) throw new Error('Gemini API key is not configured.');
    const genAI = new GoogleGenerativeAI(activeKey);
    const model = genAI.getGenerativeModel({ model: modelName || 'gemini-2.0-flash', systemInstruction: systemPrompt });
    const result = await model.generateContent(userPrompt);
    respText = result.response.text();

    const tokenCount = result.response.usageMetadata?.totalTokenCount
      || Math.ceil((systemPrompt.length + userPrompt.length + respText.length) / 4);
    if (db && userId) {
      db.run(
        'INSERT INTO token_usage (user_id, model_name, provider_type, token_count) VALUES (?, ?, ?, ?)',
        [userId, modelName || 'gemini-2.0-flash', provider === 'local' ? 'local' : 'online', tokenCount]
      ).catch(() => {});
    }
  } else {
    const { targetUrl, targetKey, targetStyle } = resolveTarget(settings);
    const headers = buildHeaders(targetKey, targetStyle);
    const endpoint = resolveEndpoint(targetUrl, targetStyle);
    // Anthropic previously hardcoded max_tokens: 4096 even for a local provider (every other
    // call site here skips max_tokens for local); preserve that as this call's one deliberate
    // quirk rather than silently aligning it with the others.
    const body = buildBody({
      targetStyle,
      provider: targetStyle === 'anthropic' ? 'online' : provider,
      modelName,
      systemText: systemPrompt,
      userText: userPrompt,
      temperature: 0.4,
      maxTokensOnline: 4096
    });

    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: llmFetchSignal() });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`LLM error: ${res.status} - ${errText}`);
    }
    const data = await res.json();
    respText = extractResponseText(data, targetStyle);

    const tokenCount = data.usage?.total_tokens
      || (data.usage?.input_tokens && data.usage?.output_tokens ? data.usage.input_tokens + data.usage.output_tokens : null)
      || Math.ceil((systemPrompt.length + userPrompt.length + respText.length) / 4);
    if (db && userId) {
      db.run(
        'INSERT INTO token_usage (user_id, model_name, provider_type, token_count) VALUES (?, ?, ?, ?)',
        [userId, modelName || 'unknown', provider === 'local' ? 'local' : 'online', tokenCount]
      ).catch(() => {});
    }
  }

  return stripThinkTags(respText);
}

module.exports = { generateText, buildSettingsForUser, defaultOnlineBaseUrl };
