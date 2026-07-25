const { GoogleGenerativeAI } = require('@google/generative-ai');

const BLOCKED_MODEL_PATTERNS = ['embed', 'embedding', 'nomic-embed'];

function checkAndFallbackModel(candidate, preferredModel) {
  if (!candidate) return preferredModel || 'qwen2.5-coder-7b-instruct';
  const isBlocked = BLOCKED_MODEL_PATTERNS.some(pat => candidate.toLowerCase().includes(pat));
  return isBlocked ? (preferredModel || 'qwen2.5-coder-7b-instruct') : candidate;
}

async function selectBestModel(settings = {}, userMessage = '', history = []) {
  return checkAndFallbackModel(settings.modelName, 'qwen2.5-coder-7b-instruct');
}

module.exports = {
  selectBestModel
};
