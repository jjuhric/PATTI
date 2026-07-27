const { callLocalLLMStream } = require('../llm/local_stream');

global.fetch = jest.fn();

const jsonResponse = (body, ok = true, status = 200) => ({
  ok,
  status,
  headers: { get: () => 'application/json' },
  text: async () => JSON.stringify(body)
});

const streamResponse = (chunks) => {
  let i = 0;
  return {
    ok: true,
    headers: { get: () => 'text/event-stream' },
    body: {
      getReader: () => ({
        read: async () => {
          if (i >= chunks.length) return { done: true, value: undefined };
          const value = new TextEncoder().encode(chunks[i]);
          i++;
          return { done: false, value };
        },
        cancel: async () => {}
      })
    }
  };
};

beforeEach(() => {
  global.fetch.mockReset();
});

describe('callLocalLLMStream - non-streaming JSON response', () => {
  test('delivers content to onChunk and returns', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'hello there' } }] }));
    const onChunk = jest.fn();
    await callLocalLLMStream('http://x:1234/v1', 'lm-studio', 'model', [{ role: 'user', content: 'hi' }], 'lm-studio', onChunk, null, null, null, 'local');
    expect(onChunk).toHaveBeenCalledWith('hello there');
  });

  test('retries once on an empty response, then succeeds', async () => {
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: '' } }] }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'recovered' } }] }));
    const onChunk = jest.fn();
    await callLocalLLMStream('http://x:1234/v1', 'lm-studio', 'model', [], 'lm-studio', onChunk, null, null, null, 'local', 1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(onChunk).toHaveBeenCalledWith('recovered');
  });

  test('throws the GPU/driver-instability error after retries are exhausted on an empty response', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: '' } }] }));
    await expect(
      callLocalLLMStream('http://x:1234/v1', 'lm-studio', 'model', [], 'lm-studio', jest.fn(), null, null, null, 'local', 0)
    ).rejects.toThrow(/GPU\/driver instability/);
  });

  test('retries on a fetch exception (e.g. connection refused during a cold model load)', async () => {
    global.fetch
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'up now' } }] }));
    const onChunk = jest.fn();
    await callLocalLLMStream('http://x:1234/v1', 'lm-studio', 'model', [], 'lm-studio', onChunk, null, null, null, 'local', 1);
    expect(onChunk).toHaveBeenCalledWith('up now');
  });

  test('retries on a non-2xx response', async () => {
    global.fetch
      .mockResolvedValueOnce(jsonResponse({}, false, 503))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok now' } }] }));
    const onChunk = jest.fn();
    await callLocalLLMStream('http://x:1234/v1', 'lm-studio', 'model', [], 'lm-studio', onChunk, null, null, null, 'local', 1);
    expect(onChunk).toHaveBeenCalledWith('ok now');
  });

  test('surfaces the underlying error once retries are exhausted', async () => {
    global.fetch.mockResolvedValue(jsonResponse({}, false, 503));
    await expect(
      callLocalLLMStream('http://x:1234/v1', 'lm-studio', 'model', [], 'lm-studio', jest.fn(), null, null, null, 'local', 0)
    ).rejects.toThrow(/LLM API error: 503/);
  });

  test('strips a <think> reasoning block from a non-streaming JSON response', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { content: '<think>internal reasoning</think>The weather is sunny.' } }]
    }));
    const onChunk = jest.fn();
    await callLocalLLMStream('http://x:1234/v1', 'lm-studio', 'model', [], 'lm-studio', onChunk, null, null, null, 'local');
    expect(onChunk).toHaveBeenCalledWith('The weather is sunny.');
  });

  test('gives a specific hint when LM Studio\'s server is not started', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () => 'Unexpected endpoint or method. (POST /v1/chat/completions)'
    });
    await expect(
      callLocalLLMStream('http://x:1234/v1', 'lm-studio', 'model', [], 'lm-studio', jest.fn(), null, null, null, 'local', 0)
    ).rejects.toThrow(/Start Server/);
  });
});

describe('callLocalLLMStream - streaming (text/event-stream) response', () => {
  test('parses SSE chunks and forwards text incrementally', async () => {
    global.fetch.mockResolvedValueOnce(streamResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
      'data: [DONE]\n'
    ]));
    const onChunk = jest.fn();
    await callLocalLLMStream('http://x:1234/v1', 'lm-studio', 'model', [], 'lm-studio', onChunk, null, null, null, 'local');
    expect(onChunk).toHaveBeenNthCalledWith(1, 'Hel');
    expect(onChunk).toHaveBeenNthCalledWith(2, 'lo');
  });

  test('ignores malformed SSE lines without throwing', async () => {
    global.fetch.mockResolvedValueOnce(streamResponse([
      'data: not-json\n',
      'data: {"choices":[{"delta":{"content":"still works"}}]}\n'
    ]));
    const onChunk = jest.fn();
    await callLocalLLMStream('http://x:1234/v1', 'lm-studio', 'model', [], 'lm-studio', onChunk, null, null, null, 'local');
    expect(onChunk).toHaveBeenCalledWith('still works');
  });

  test('throws when the stream completes with no content at all', async () => {
    global.fetch.mockResolvedValue(streamResponse(['data: [DONE]\n']));
    await expect(
      callLocalLLMStream('http://x:1234/v1', 'lm-studio', 'model', [], 'lm-studio', jest.fn(), null, null, null, 'local', 0)
    ).rejects.toThrow(/GPU\/driver instability/);
  });

  test('respects an already-aborted signal by stopping the read loop', async () => {
    const abortSignal = { aborted: true };
    global.fetch.mockResolvedValueOnce(streamResponse(['data: {"choices":[{"delta":{"content":"never seen"}}]}\n']));
    await expect(
      callLocalLLMStream('http://x:1234/v1', 'lm-studio', 'model', [], 'lm-studio', jest.fn(), abortSignal, null, null, 'local', 0)
    ).rejects.toThrow();
  });

  test('strips a <think> reasoning block out of the streamed output instead of leaking it to the user', async () => {
    global.fetch.mockResolvedValueOnce(streamResponse([
      'data: {"choices":[{"delta":{"content":"<think>the user wants "}}]}\n',
      'data: {"choices":[{"delta":{"content":"weather</think>It\'s sunny!"}}]}\n',
      'data: [DONE]\n'
    ]));
    const onChunk = jest.fn();
    await callLocalLLMStream('http://x:1234/v1', 'lm-studio', 'model', [], 'lm-studio', onChunk, null, null, null, 'local');
    expect(onChunk.mock.calls.map((c) => c[0]).join('')).toBe("It's sunny!");
    expect(onChunk.mock.calls.some((c) => c[0].includes('the user wants'))).toBe(false);
  });

  test('retries when the stream is pure reasoning with no visible answer', async () => {
    global.fetch
      .mockResolvedValueOnce(streamResponse([
        'data: {"choices":[{"delta":{"content":"<think>only reasoning, no answer</think>"}}]}\n',
        'data: [DONE]\n'
      ]))
      .mockResolvedValueOnce(streamResponse([
        'data: {"choices":[{"delta":{"content":"Real answer."}}]}\n',
        'data: [DONE]\n'
      ]));
    const onChunk = jest.fn();
    await callLocalLLMStream('http://x:1234/v1', 'lm-studio', 'model', [], 'lm-studio', onChunk, null, null, null, 'local', 1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(onChunk.mock.calls.map((c) => c[0]).join('')).toBe('Real answer.');
  });
});

describe('callLocalLLMStream - request shape', () => {
  test('builds the anthropic-style request correctly end to end', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ content: [{ text: 'from claude' }] }));
    const onChunk = jest.fn();
    await callLocalLLMStream(
      'https://api.anthropic.com',
      'sk-ant-key',
      'claude-3',
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      'anthropic',
      onChunk,
      null, null, null, 'online'
    );
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(options.headers['x-api-key']).toBe('sk-ant-key');
    const body = JSON.parse(options.body);
    expect(body.system).toBe('sys');
    expect(onChunk).toHaveBeenCalledWith('from claude');
  });
});
