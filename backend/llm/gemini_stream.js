const { GoogleGenerativeAI } = require('@google/generative-ai');
const { ThinkTagFilter } = require('./think_filter');
const { estimateTokens, logTokenUsage } = require('../utils/tokenAccounting');

/**
 * Streams a chat completion from Gemini. Unlike callLocalLLMStream, Gemini's SDK handles
 * retries/backoff internally, so this stays a single attempt.
 */
async function callGeminiStream(apiKey, modelName, systemInstruction, history, userMessage, onChunk, abortSignal, db, userId, provider) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName || 'gemini-2.0-flash',
    systemInstruction: systemInstruction
  });

  const contents = [];
  for (const msg of history) {
    contents.push({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    });
  }
  contents.push({
    role: 'user',
    parts: [{ text: userMessage }]
  });

  const result = await model.generateContentStream({ contents }, { signal: abortSignal });
  let fullResponseText = '';
  const thinkFilter = new ThinkTagFilter(onChunk);
  for await (const chunk of result.stream) {
    if (abortSignal?.aborted) break;
    const text = chunk.text();
    if (text) {
      thinkFilter.feed(text);
      fullResponseText += text;
    }
  }
  thinkFilter.end();

  // Record token usage
  let tokenCount = 0;
  try {
    const response = await result.response;
    if (response.usageMetadata && response.usageMetadata.totalTokenCount) {
      tokenCount = response.usageMetadata.totalTokenCount;
    }
  } catch (err) {
    console.error('Failed to get Gemini stream usage metadata:', err);
  }

  if (tokenCount === 0) {
    // Estimate fallback
    const promptText = systemInstruction + JSON.stringify(contents);
    tokenCount = estimateTokens(promptText + fullResponseText);
  }

  await logTokenUsage(db, userId, modelName || 'gemini-2.0-flash', provider === 'local' ? 'local' : 'online', tokenCount, 'Gemini stream');
}

module.exports = { callGeminiStream };
