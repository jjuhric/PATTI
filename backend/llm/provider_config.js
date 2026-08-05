// Single source of truth for "how do I talk to this LLM provider" - endpoint URL, auth headers,
// and request body shape, for every apiStyle PATTI supports (openai, lm-studio, anthropic,
// local-gemini) across both providers (local and online).
//
// Before this module existed, this logic was copy-pasted into six different functions across
// ai.js, agents.js, and llm_text.js, and had already drifted: two of the six had silently lost
// local-gemini support, and a merge had silently reverted num_ctx from 32768 back to 24576 in
// every copy but this one would have needed fixing six times over. Callers now supply only what
// is genuinely different about their call (temperature, token limits, JSON-mode, whether this is
// a streaming request) and get identical, correct provider wiring for free.

// Anthropic doesn't share OpenAI's base URL, so give it its own default.
function defaultOnlineBaseUrl(onlineProvider) {
  return onlineProvider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
}

// Local LLM servers need a large enough context window to hold a full agent turn (system
// prompt + tool history + results) without the server rejecting the request outright. This was
// raised from 16384 after a live "LLM Error: 400" failure and must not silently regress again -
// see IMPLEMENTATION_PLAN.md for the incident.
const LM_STUDIO_NUM_CTX = 32768;

/**
 * Picks which provider/key/style/url a call should target, given the standard settings object
 * every LLM-calling function receives (provider, modelName, onlineProvider, onlineKey,
 * localBaseUrl, localApiKey, localApiStyle, onlineUrl, ...).
 */
function resolveTarget(settings) {
  const { provider, localBaseUrl, localApiKey, localApiStyle, onlineUrl, onlineKey, onlineProvider } = settings;
  if (provider === 'local') {
    return {
      targetUrl: localBaseUrl || process.env.LOCAL_LLM_URL || 'http://localhost:1234/v1',
      targetKey: localApiKey,
      targetStyle: localApiStyle || 'openai'
    };
  }
  return {
    targetUrl: onlineUrl || defaultOnlineBaseUrl(onlineProvider),
    targetKey: onlineKey,
    targetStyle: onlineProvider || 'openai'
  };
}

/**
 * Resolves the chat-completion endpoint for a given base URL and apiStyle. Falls back to
 * treating targetUrl as already-a-full-base if it isn't parseable as a URL (some local servers
 * are configured with a bare host:port that new URL() chokes on without a scheme).
 */
function resolveEndpoint(targetUrl, targetStyle) {
  const trimmed = (url) => url.replace(/\/$/, '');
  try {
    const origin = new URL(targetUrl).origin;
    if (targetStyle === 'lm-studio') return `${origin}/v1/chat/completions`;
    if (targetStyle === 'anthropic') return `${origin}/v1/messages`;
    if (targetStyle === 'local-gemini') return `${origin}/api/v1/chat`;
    return `${trimmed(targetUrl)}/chat/completions`;
  } catch (e) {
    if (targetStyle === 'local-gemini') return `${trimmed(targetUrl)}/api/v1/chat`;
    return `${trimmed(targetUrl)}/chat/completions`;
  }
}

/**
 * Builds auth headers for a request. No Authorization header is sent for a falsy key or the
 * literal placeholder "lm-studio" (LM Studio's local server doesn't check the key at all).
 */
function buildHeaders(targetKey, targetStyle) {
  const headers = { 'Content-Type': 'application/json' };
  if (targetKey && targetKey !== 'lm-studio') {
    if (targetStyle === 'anthropic') {
      headers['x-api-key'] = targetKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${targetKey}`;
    }
  }
  return headers;
}

// Some deployments pin a placeholder local model name; substitute the real configured model in
// that one case, otherwise pass the requested model straight through.
function resolveModelName(modelName) {
  return modelName === 'qwen2.5-coder-7b-instruct'
    ? (process.env.OPENAI_API_MODEL || 'qwen2.5-coder-7b-instruct')
    : modelName;
}

// ENH-3: Anthropic's `system` field accepts either a plain string or an array of content
// blocks, each optionally carrying `cache_control: {type: "ephemeral"}`. Splitting off a
// cacheable prefix block lets Anthropic reuse its cache for that block on subsequent requests
// even though the remainder of the system prompt (per-turn memories/feedback/context) differs
// every time - the cache lookup only needs that leading block to match exactly, not the whole
// prompt. Falls back to the plain string (today's behavior, uncached) whenever no prefix is
// given or it doesn't actually match the start of systemText.
function buildAnthropicSystem(systemText, cacheableSystemPrefix) {
  if (!cacheableSystemPrefix || !systemText || !systemText.startsWith(cacheableSystemPrefix)) {
    return systemText;
  }
  const remainder = systemText.slice(cacheableSystemPrefix.length);
  const blocks = [{ type: 'text', text: cacheableSystemPrefix, cache_control: { type: 'ephemeral' } }];
  if (remainder) {
    blocks.push({ type: 'text', text: remainder });
  }
  return blocks;
}

function attachImages(content, images) {
  const parts = [{ type: 'text', text: content }];
  for (const base64Img of images) {
    const cleanBase64 = base64Img.replace(/^data:image\/\w+;base64,/, '');
    parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${cleanBase64}` } });
  }
  return parts;
}

/**
 * Builds the request body for a non-streaming chat completion.
 *
 * @param {object} opts
 * @param {string} opts.targetStyle - 'openai' | 'lm-studio' | 'anthropic' | 'local-gemini'
 * @param {string} opts.provider - 'local' | 'online' (local skips max_tokens - the local server
 *   picks its own ceiling; online providers are billed per token so a cap is applied)
 * @param {string} opts.modelName
 * @param {string} opts.systemText - system prompt / instructions
 * @param {string} opts.userText - the user-role message content
 * @param {string[]} [opts.images] - base64 image data URLs to attach (ignored for
 *   anthropic/local-gemini, which don't receive image content in any existing caller)
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokensOnline] - max_tokens to send when provider is 'online'
 * @param {boolean} [opts.jsonMode] - request response_format: json_object (openai/lm-studio only)
 * @param {string} [opts.cacheableSystemPrefix] - ENH-3 (docs/REVIEW_2026-08-03.md): the static,
 *   byte-identical-across-turns leading portion of systemText (e.g. an agent's base prompt,
 *   before per-turn memories/feedback/context get appended). anthropic only - ignored for every
 *   other apiStyle, which has no prompt-caching mechanism here. Must be a genuine prefix of
 *   systemText or it's ignored (falls back to the plain uncached string) rather than risk
 *   silently caching the wrong text.
 */
function buildBody({ targetStyle, provider, modelName, systemText, userText, images, temperature, maxTokensOnline, jsonMode, cacheableSystemPrefix }) {
  const finalModel = resolveModelName(modelName);

  if (targetStyle === 'anthropic') {
    return {
      model: finalModel,
      system: buildAnthropicSystem(systemText, cacheableSystemPrefix),
      messages: [{ role: 'user', content: userText }],
      ...(provider === 'local' ? {} : { max_tokens: maxTokensOnline })
    };
  }

  if (targetStyle === 'local-gemini') {
    return {
      model: finalModel,
      system_prompt: systemText,
      input: userText
    };
  }

  let userContent = userText;
  if (images && images.length > 0) {
    userContent = attachImages(userText, images);
  }

  return {
    model: finalModel,
    messages: [
      { role: 'system', content: systemText },
      { role: 'user', content: userContent }
    ],
    ...(temperature !== undefined ? { temperature } : {}),
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    ...(provider === 'local' ? {} : { max_tokens: maxTokensOnline }),
    ...(targetStyle === 'lm-studio' ? { num_ctx: LM_STUDIO_NUM_CTX } : {})
  };
}

/**
 * Builds the request body for a streaming chat completion from a pre-assembled messages array
 * (the streaming callers already build multi-turn history, unlike the single-shot builders
 * above, so this takes messages directly rather than systemText/userText).
 */
function buildStreamBody({ targetStyle, modelName, messages, temperature, frequencyPenalty, presencePenalty, cacheableSystemPrefix }) {
  const finalModel = resolveModelName(modelName);

  if (targetStyle === 'anthropic') {
    const systemMessage = messages.find((m) => m.role === 'system')?.content || '';
    const anthropicMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
    return {
      model: finalModel,
      messages: anthropicMessages,
      stream: true,
      ...(systemMessage ? { system: buildAnthropicSystem(systemMessage, cacheableSystemPrefix) } : {})
    };
  }

  if (targetStyle === 'local-gemini') {
    const systemMessage = messages.find((m) => m.role === 'system')?.content || '';
    const conversation = messages
      .filter((m) => m.role !== 'system')
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');
    return { model: finalModel, system_prompt: systemMessage, input: conversation };
  }

  return {
    model: finalModel,
    messages,
    temperature: temperature !== undefined ? temperature : 0.7,
    frequency_penalty: frequencyPenalty !== undefined ? frequencyPenalty : 0.3,
    presence_penalty: presencePenalty !== undefined ? presencePenalty : 0.1,
    stream: true,
    ...(targetStyle === 'lm-studio' ? { num_ctx: LM_STUDIO_NUM_CTX } : {})
  };
}

// Extracts the completed (non-streaming) response text for each apiStyle's differently-shaped
// response payload.
function extractResponseText(data, targetStyle) {
  if (targetStyle === 'anthropic') return data.content?.[0]?.text || '';
  return data.choices?.[0]?.message?.content || data.response || data.content || '';
}

module.exports = {
  defaultOnlineBaseUrl,
  resolveTarget,
  resolveEndpoint,
  buildHeaders,
  buildBody,
  buildStreamBody,
  buildAnthropicSystem,
  extractResponseText,
  attachImages,
  resolveModelName,
  LM_STUDIO_NUM_CTX
};
