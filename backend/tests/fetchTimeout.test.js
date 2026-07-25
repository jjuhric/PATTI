const { llmFetchSignal, DEFAULT_LLM_TIMEOUT_MS } = require('../utils/fetchTimeout');

describe('llmFetchSignal', () => {
  test('returns a non-aborted AbortSignal when no existing signal is given', () => {
    const signal = llmFetchSignal();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  test('defaults to a generous timeout well beyond undici\'s 5-minute default', () => {
    expect(DEFAULT_LLM_TIMEOUT_MS).toBeGreaterThan(5 * 60 * 1000);
  });

  test('propagates abort from a caller-provided existing signal', () => {
    const controller = new AbortController();
    const signal = llmFetchSignal(controller.signal);
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  test('an already-aborted existing signal produces an already-aborted combined signal', () => {
    const controller = new AbortController();
    controller.abort();
    const signal = llmFetchSignal(controller.signal);
    expect(signal.aborted).toBe(true);
  });
});
