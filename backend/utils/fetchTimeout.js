// Node's global fetch (undici) defaults to a 5-minute headers/body timeout, which is far too
// short for local LLM generation - a large tool result fed back into a worker agent's next
// turn, or a long course lesson, can legitimately take longer than that on local hardware.
// Without an explicit longer timeout, undici silently kills the connection at 5 minutes and
// the failure surfaces as a bare, unhelpful "fetch failed" with no indication it was a timeout.
const DEFAULT_LLM_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

/**
 * Builds an AbortSignal for an LLM completion fetch() call: a generous timeout (local
 * generation is allowed to take a long time) combined with any caller-provided abort signal
 * (e.g. user-initiated cancellation), so either can still stop the request.
 *
 * @param {AbortSignal} [existingSignal] An optional caller-provided signal (e.g. settings.abortSignal)
 * @param {number} [timeoutMs] Override the default 20-minute timeout
 * @returns {AbortSignal}
 */
function llmFetchSignal(existingSignal, timeoutMs = DEFAULT_LLM_TIMEOUT_MS) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return existingSignal ? AbortSignal.any([existingSignal, timeoutSignal]) : timeoutSignal;
}

module.exports = { llmFetchSignal, DEFAULT_LLM_TIMEOUT_MS };
