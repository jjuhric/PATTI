const logger = require('../utils/logger');
const { buildHeaders, resolveEndpoint, buildStreamBody, extractResponseText } = require('./provider_config');
const { ThinkTagFilter, stripThinkTags } = require('./think_filter');
const { estimateTokens, logTokenUsage } = require('../utils/tokenAccounting');

// A cold model load in LM Studio can take longer than a minute before a single token is
// emitted, so a 60s ceiling aborted perfectly healthy requests that merely had to wait for the
// model to come back after an idle unload.
const LOCAL_LLM_TIMEOUT_MS = Number(process.env.LOCAL_LLM_TIMEOUT_MS) || 180000;

// Retrying instantly re-hits a model that is still loading and burns the retry for nothing.
// Waiting first is what makes the retry actually worth having. Disabled under test so the
// suite doesn't sit through real delays.
const RETRY_BACKOFF_MS = process.env.NODE_ENV === 'test'
  ? 0
  : (Number(process.env.LLM_RETRY_BACKOFF_MS) || 5000);

const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/**
 * Streams a chat completion from a local (or online, non-Gemini) LLM server, supporting the
 * openai, lm-studio, anthropic, and local-gemini API styles. Retries once (by default) on a
 * fetch failure, a non-2xx response, or an empty response - each of those is either transient
 * network flakiness or the local model still finishing a cold load, and both recover with a
 * short wait, per LLM_RETRY_BACKOFF_MS.
 */
async function callLocalLLMStream(baseUrl, apiKey, modelName, messages, apiStyle, onChunk, abortSignal, db, userId, provider, retriesLeft = 1) {
  const localStyle = apiStyle || 'openai';
  const headers = buildHeaders(apiKey, localStyle);
  const endpoint = resolveEndpoint(baseUrl, localStyle);
  const body = buildStreamBody({ targetStyle: localStyle, modelName, messages });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LOCAL_LLM_TIMEOUT_MS);

  if (abortSignal) {
    abortSignal.addEventListener('abort', () => controller.abort());
  }

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (fetchErr) {
    clearTimeout(timeoutId);
    if (retriesLeft > 0 && !abortSignal?.aborted) {
      logger.warn(`Local LLM fetch exception, retrying in ${RETRY_BACKOFF_MS}ms (${retriesLeft} attempt(s) left): ${fetchErr.message}`);
      await sleep(RETRY_BACKOFF_MS);
      return callLocalLLMStream(baseUrl, apiKey, modelName, messages, apiStyle, onChunk, abortSignal, db, userId, provider, retriesLeft - 1);
    }
    logger.error('Local LLM fetch exception in callLocalLLMStream:', fetchErr);
    throw new Error("Local LLM Connection Lost. The model may have run out of memory. Please lower context length.");
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
    const errText = await response.text();
    logger.error(`Local LLM response not ok: ${response.status} - ${errText}`);
    if (retriesLeft > 0 && !abortSignal?.aborted) {
      logger.warn(`Local LLM returned an error response, retrying in ${RETRY_BACKOFF_MS}ms (${retriesLeft} attempt(s) left): ${response.status} - ${errText}`);
      await sleep(RETRY_BACKOFF_MS);
      return callLocalLLMStream(baseUrl, apiKey, modelName, messages, apiStyle, onChunk, abortSignal, db, userId, provider, retriesLeft - 1);
    }
    throw new Error(`LLM API error: ${response.status} - ${errText}`);
  }

  let fullResponseText = '';

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    let data;
    if (typeof response.text === 'function') {
      const rawText = await response.text();
      try {
        data = JSON.parse(rawText);
      } catch (parseErr) {
        if (rawText.includes('Unexpected endpoint or method')) {
          throw new Error("LM Studio Local Server is not running. Please open LM Studio, navigate to the Local Server tab, and click the 'Start Server' button.");
        }
        throw new Error(`Invalid JSON response from local LLM: ${rawText.substring(0, 150)}`);
      }
    } else {
      data = await response.json();
    }
    const rawContent = extractResponseText(data, localStyle);
    // Strip <think>/<|channel>thought reasoning blocks before anything reaches the user - a
    // response that turns out to be pure reasoning with no visible answer is treated the same
    // as a genuinely empty response (retry) rather than being shown to the user as-is.
    const visibleContent = rawContent ? stripThinkTags(rawContent) : rawContent;

    if (!visibleContent || !visibleContent.trim()) {
      if (retriesLeft > 0 && !abortSignal?.aborted) {
        logger.warn(`Local LLM returned an empty response, retrying in ${RETRY_BACKOFF_MS}ms (${retriesLeft} attempt(s) left).`);
        await sleep(RETRY_BACKOFF_MS);
        return callLocalLLMStream(baseUrl, apiKey, modelName, messages, apiStyle, onChunk, abortSignal, db, userId, provider, retriesLeft - 1);
      }
      throw new Error("Local LLM returned an empty response after retrying. The model or GPU backend may have failed mid-generation (possible GPU/driver instability) - please check LM Studio.");
    }

    onChunk(visibleContent);
    fullResponseText += rawContent;

    // Save token usage
    let tokenCount = 0;
    if (data.usage && data.usage.total_tokens) {
      tokenCount = data.usage.total_tokens;
    } else if (data.usage && data.usage.input_tokens && data.usage.output_tokens) {
      tokenCount = data.usage.input_tokens + data.usage.output_tokens;
    } else {
      const promptText = JSON.stringify(messages);
      tokenCount = estimateTokens(promptText + fullResponseText);
    }
    await logTokenUsage(db, userId, modelName || 'unknown', provider === 'local' ? 'local' : 'online', tokenCount, 'non-stream local LLM');
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const thinkFilter = new ThinkTagFilter(onChunk);

  try {
    while (true) {
      if (abortSignal?.aborted) {
        await reader.cancel();
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const cleaned = line.trim();
        if (!cleaned || cleaned === 'data: [DONE]') continue;
        if (cleaned.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(cleaned.substring(6));
            // Support both OpenAI format and Anthropic format chunk parsing
            const text = parsed.choices?.[0]?.delta?.content || parsed.delta?.text || parsed.response || parsed.content;
            if (text) {
              thinkFilter.feed(text);
              fullResponseText += text;
            }
          } catch (e) {
            // ignore malformed lines
          }
        }
      }
    }
  } catch (streamErr) {
    console.error('LM Studio stream interrupted:', streamErr);
    if (!fullResponseText.trim() && retriesLeft > 0 && !abortSignal?.aborted) {
      logger.warn(`Local LLM stream interrupted before any content was received, retrying in ${RETRY_BACKOFF_MS}ms (${retriesLeft} attempt(s) left): ${streamErr.message}`);
      await sleep(RETRY_BACKOFF_MS);
      return callLocalLLMStream(baseUrl, apiKey, modelName, messages, apiStyle, onChunk, abortSignal, db, userId, provider, retriesLeft - 1);
    }
    throw new Error("Local LLM Connection Lost. The model may have run out of memory. Please lower context length.");
  }

  thinkFilter.end();

  // A stream that was pure reasoning (everything inside <think> tags, nothing after) has raw
  // text but nothing the user ever saw - treat it the same as a genuinely empty response.
  if (!fullResponseText.trim() || !thinkFilter.hasVisibleContent) {
    if (retriesLeft > 0 && !abortSignal?.aborted) {
      logger.warn(`Local LLM stream completed with no content, retrying in ${RETRY_BACKOFF_MS}ms (${retriesLeft} attempt(s) left).`);
      await sleep(RETRY_BACKOFF_MS);
      return callLocalLLMStream(baseUrl, apiKey, modelName, messages, apiStyle, onChunk, abortSignal, db, userId, provider, retriesLeft - 1);
    }
    throw new Error("Local LLM returned an empty response after retrying. The model or GPU backend may have failed mid-generation (possible GPU/driver instability) - please check LM Studio.");
  }

  // Estimate and log streaming tokens
  const promptText = JSON.stringify(messages);
  const tokenCount = estimateTokens(promptText + fullResponseText);
  await logTokenUsage(db, userId, modelName || 'unknown', provider === 'local' ? 'local' : 'online', tokenCount, 'streaming local LLM');
}

module.exports = { callLocalLLMStream, LOCAL_LLM_TIMEOUT_MS, RETRY_BACKOFF_MS };
