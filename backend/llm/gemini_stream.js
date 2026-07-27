const { GoogleGenerativeAI } = require('@google/generative-ai');

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
  for await (const chunk of result.stream) {
    if (abortSignal?.aborted) break;
    const text = chunk.text();
    if (text) {
      onChunk(text);
      fullResponseText += text;
    }
  }

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
    tokenCount = Math.ceil((promptText.length + fullResponseText.length) / 4);
  }

  if (db && typeof db.run === 'function' && userId) {
    const providerType = provider === 'local' ? 'local' : 'online';
    try {
      await db.run(
        'INSERT INTO token_usage (user_id, model_name, provider_type, token_count) VALUES (?, ?, ?, ?)',
        [userId, modelName || 'gemini-2.0-flash', providerType, tokenCount]
      );
    } catch (err) {
      console.error('Failed to log Gemini stream tokens:', err);
    }
  }
}

module.exports = { callGeminiStream };
