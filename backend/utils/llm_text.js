const { GoogleGenerativeAI } = require('@google/generative-ai');
const { decrypt } = require('./crypto');
const { llmFetchSignal } = require('./fetchTimeout');

// Anthropic doesn't share OpenAI's base URL, so give it its own default.
function defaultOnlineBaseUrl(onlineProvider) {
  return onlineProvider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
}

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
    const targetUrl = provider === 'local'
      ? (localBaseUrl || process.env.LOCAL_LLM_URL || 'http://localhost:1234/v1')
      : (onlineUrl || defaultOnlineBaseUrl(onlineProvider));
    const targetKey = provider === 'local' ? localApiKey : onlineKey;
    const targetStyle = provider === 'local' ? (localApiStyle || 'openai') : (onlineProvider || 'openai');

    let endpoint = '';
    const headers = { 'Content-Type': 'application/json' };
    if (targetKey && targetKey !== 'lm-studio') {
      if (targetStyle === 'anthropic') {
        headers['x-api-key'] = targetKey;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers['Authorization'] = `Bearer ${targetKey}`;
      }
    }

    try {
      const urlObj = new URL(targetUrl);
      const origin = urlObj.origin;
      if (targetStyle === 'lm-studio') endpoint = `${origin}/v1/chat/completions`;
      else if (targetStyle === 'anthropic') endpoint = `${origin}/v1/messages`;
      else if (targetStyle === 'local-gemini') endpoint = `${origin}/api/v1/chat`;
      else endpoint = `${targetUrl.replace(/\/$/, '')}/chat/completions`;
    } catch (e) {
      endpoint = targetStyle === 'local-gemini'
        ? `${targetUrl.replace(/\/$/, '')}/api/v1/chat`
        : `${targetUrl.replace(/\/$/, '')}/chat/completions`;
    }

    const finalModel = (modelName === 'qwen2.5-coder-7b-instruct') ? (process.env.OPENAI_API_MODEL || 'qwen2.5-coder-7b-instruct') : modelName;
    let body = {};
    if (targetStyle === 'anthropic') {
      body = { model: finalModel, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }], max_tokens: 4096 };
    } else if (targetStyle === 'local-gemini') {
      body = { model: finalModel, system_prompt: systemPrompt, input: userPrompt };
    } else {
      body = {
        model: finalModel,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        temperature: 0.4,
        ...(provider === 'local' ? {} : { max_tokens: 4096 }),
        ...(targetStyle === 'lm-studio' ? { num_ctx: 16384 } : {})
      };
    }

    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: llmFetchSignal() });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`LLM error: ${res.status} - ${errText}`);
    }
    const data = await res.json();
    respText = targetStyle === 'anthropic'
      ? (data.content?.[0]?.text || '')
      : (data.choices?.[0]?.message?.content || data.response || data.content || '');

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

  return respText
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<\|channel>thought[\s\S]*?<channel\|>/g, '')
    .trim();
}

module.exports = { generateText, buildSettingsForUser, defaultOnlineBaseUrl };
