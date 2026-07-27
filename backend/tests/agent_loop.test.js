const { runAgentLoop } = require('../ai');

// The whole point of the fast-path is that it never touches the LLM - so fail the test loudly
// if anything reaches fetch, rather than silently mocking a response that would mask a
// regression back to the full pipeline.
global.fetch = jest.fn(() => {
  throw new Error('fetch should not be called for a simple acknowledgment message');
});

function makeDb() {
  const messages = [];
  return {
    messages,
    run: jest.fn(async (sql, params) => {
      if (sql.includes('INSERT INTO messages')) {
        messages.push({ chatId: params[0], role: params[1], content: params[2] });
      }
      return { lastID: messages.length };
    }),
    get: jest.fn(async () => null),
    all: jest.fn(async () => [])
  };
}

const baseArgs = {
  userId: 1,
  chatId: 42,
  provider: 'local',
  modelName: 'test-model',
  history: [],
  localBaseUrl: 'http://localhost:1234/v1',
  localApiKey: 'lm-studio',
  localApiStyle: 'lm-studio',
  onToolCall: jest.fn(),
  onAgentStatus: jest.fn(),
  onCommandApprovalRequired: jest.fn()
};

describe('runAgentLoop - simple acknowledgment fast-path', () => {
  beforeEach(() => {
    global.fetch.mockClear();
  });

  test('responds directly to pure gratitude without calling the LLM', async () => {
    const db = makeDb();
    const thoughts = [];
    const contents = [];

    await runAgentLoop({
      ...baseArgs,
      db,
      userMessage: 'That was a great response. thank you.',
      onThought: (t) => thoughts.push(t),
      onContent: (c) => contents.push(c)
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(contents).toHaveLength(1);
    expect(contents[0]).toMatch(/thank|welcome|glad/i);
    expect(thoughts.join('')).toContain('[Simple Acknowledgment Intercept]');
  });

  test('saves the canned response to the database', async () => {
    const db = makeDb();
    await runAgentLoop({
      ...baseArgs,
      db,
      userMessage: 'thanks!',
      onThought: jest.fn(),
      onContent: jest.fn()
    });

    expect(db.messages).toHaveLength(1);
    expect(db.messages[0]).toMatchObject({ chatId: 42, role: 'assistant' });
  });

  test('does not fast-path a message with a real request alongside the gratitude', async () => {
    const db = makeDb();
    // No LLM mock response configured beyond the default fetch-throws mock, so this just
    // proves the fast-path was NOT taken (fetch does get reached and fail, rather than the
    // request short-circuiting to a canned reply) - it does not need to succeed, only to prove
    // it reached the real pipeline. callLocalLLMStream wraps the underlying fetch error before
    // it propagates, hence asserting on that wrapper message rather than the raw one.
    await expect(
      runAgentLoop({
        ...baseArgs,
        db,
        userMessage: 'thanks, can you also check the weather',
        onThought: jest.fn(),
        onContent: jest.fn()
      })
    ).rejects.toThrow('Local LLM Connection Lost');
    expect(global.fetch).toHaveBeenCalled();
  });
});
