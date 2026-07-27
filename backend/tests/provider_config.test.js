const {
  defaultOnlineBaseUrl,
  resolveTarget,
  resolveEndpoint,
  buildHeaders,
  buildBody,
  buildStreamBody,
  extractResponseText,
  resolveModelName,
  LM_STUDIO_NUM_CTX
} = require('../llm/provider_config');

describe('defaultOnlineBaseUrl', () => {
  test('anthropic gets its own base URL', () => {
    expect(defaultOnlineBaseUrl('anthropic')).toBe('https://api.anthropic.com');
  });
  test('everything else defaults to the OpenAI base URL', () => {
    expect(defaultOnlineBaseUrl('openai')).toBe('https://api.openai.com/v1');
    expect(defaultOnlineBaseUrl('gemini')).toBe('https://api.openai.com/v1');
    expect(defaultOnlineBaseUrl(undefined)).toBe('https://api.openai.com/v1');
  });
});

describe('resolveTarget', () => {
  test('local provider uses local settings', () => {
    const target = resolveTarget({
      provider: 'local',
      localBaseUrl: 'http://192.168.1.5:1234/v1',
      localApiKey: 'lm-studio',
      localApiStyle: 'lm-studio'
    });
    expect(target).toEqual({ targetUrl: 'http://192.168.1.5:1234/v1', targetKey: 'lm-studio', targetStyle: 'lm-studio' });
  });

  test('local provider falls back to LOCAL_LLM_URL env then a hardcoded default', () => {
    const original = process.env.LOCAL_LLM_URL;
    delete process.env.LOCAL_LLM_URL;
    expect(resolveTarget({ provider: 'local' }).targetUrl).toBe('http://localhost:1234/v1');
    process.env.LOCAL_LLM_URL = 'http://envhost:1234/v1';
    expect(resolveTarget({ provider: 'local' }).targetUrl).toBe('http://envhost:1234/v1');
    if (original === undefined) delete process.env.LOCAL_LLM_URL; else process.env.LOCAL_LLM_URL = original;
  });

  test('local provider defaults apiStyle to openai', () => {
    expect(resolveTarget({ provider: 'local', localBaseUrl: 'http://x:1234/v1' }).targetStyle).toBe('openai');
  });

  test('online provider uses online settings and provider-specific default URL', () => {
    const target = resolveTarget({
      provider: 'online',
      onlineKey: 'sk-abc',
      onlineProvider: 'anthropic'
    });
    expect(target).toEqual({ targetUrl: 'https://api.anthropic.com', targetKey: 'sk-abc', targetStyle: 'anthropic' });
  });

  test('online provider prefers an explicit onlineUrl override', () => {
    const target = resolveTarget({ provider: 'online', onlineUrl: 'https://custom.proxy/v1', onlineProvider: 'openai' });
    expect(target.targetUrl).toBe('https://custom.proxy/v1');
  });
});

describe('resolveEndpoint', () => {
  test.each([
    ['lm-studio', 'http://localhost:1234/v1', 'http://localhost:1234/v1/chat/completions'],
    ['anthropic', 'https://api.anthropic.com', 'https://api.anthropic.com/v1/messages'],
    ['local-gemini', 'http://localhost:8080', 'http://localhost:8080/api/v1/chat'],
    ['openai', 'https://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions']
  ])('%s style resolves to the correct path', (style, url, expected) => {
    expect(resolveEndpoint(url, style)).toBe(expected);
  });

  test('falls back to raw-string concatenation when the URL is unparseable', () => {
    expect(resolveEndpoint('not-a-valid-url', 'openai')).toBe('not-a-valid-url/chat/completions');
    expect(resolveEndpoint('not-a-valid-url', 'local-gemini')).toBe('not-a-valid-url/api/v1/chat');
  });

  test('strips a trailing slash before appending the path', () => {
    expect(resolveEndpoint('http://localhost:1234/v1/', 'openai')).toBe('http://localhost:1234/v1/chat/completions');
  });
});

describe('buildHeaders', () => {
  test('omits Authorization when the key is falsy', () => {
    expect(buildHeaders('', 'openai')).toEqual({ 'Content-Type': 'application/json' });
    expect(buildHeaders(undefined, 'openai')).toEqual({ 'Content-Type': 'application/json' });
  });

  test('omits Authorization for the lm-studio placeholder key', () => {
    expect(buildHeaders('lm-studio', 'lm-studio')).toEqual({ 'Content-Type': 'application/json' });
  });

  test('anthropic style sends x-api-key and anthropic-version, not Authorization', () => {
    const headers = buildHeaders('sk-ant-123', 'anthropic');
    expect(headers['x-api-key']).toBe('sk-ant-123');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['Authorization']).toBeUndefined();
  });

  test.each(['openai', 'lm-studio', 'local-gemini'])('%s style sends a Bearer Authorization header', (style) => {
    expect(buildHeaders('sk-real-key', style)['Authorization']).toBe('Bearer sk-real-key');
  });
});

describe('buildBody', () => {
  const base = { targetStyle: 'openai', provider: 'local', modelName: 'test-model', systemText: 'sys', userText: 'user msg' };

  test('openai/lm-studio style produces a standard messages array', () => {
    const body = buildBody(base);
    expect(body.model).toBe('test-model');
    expect(body.messages).toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: 'user msg' }]);
  });

  test('lm-studio style always sets num_ctx to the shared constant', () => {
    const body = buildBody({ ...base, targetStyle: 'lm-studio' });
    expect(body.num_ctx).toBe(LM_STUDIO_NUM_CTX);
    expect(LM_STUDIO_NUM_CTX).toBe(32768);
  });

  test('openai style (non-lm-studio) does not set num_ctx', () => {
    expect(buildBody(base).num_ctx).toBeUndefined();
  });

  test('local provider omits max_tokens even when maxTokensOnline is given', () => {
    const body = buildBody({ ...base, provider: 'local', maxTokensOnline: 4096 });
    expect(body.max_tokens).toBeUndefined();
  });

  test('online provider sets max_tokens from maxTokensOnline', () => {
    const body = buildBody({ ...base, provider: 'online', maxTokensOnline: 4096 });
    expect(body.max_tokens).toBe(4096);
  });

  test('jsonMode adds response_format, omitted by default', () => {
    expect(buildBody(base).response_format).toBeUndefined();
    expect(buildBody({ ...base, jsonMode: true }).response_format).toEqual({ type: 'json_object' });
  });

  test('temperature is passed through only when provided', () => {
    expect(buildBody(base).temperature).toBeUndefined();
    expect(buildBody({ ...base, temperature: 0.1 }).temperature).toBe(0.1);
  });

  test('anthropic style puts systemText in "system" and userText as the sole user message', () => {
    const body = buildBody({ ...base, targetStyle: 'anthropic', provider: 'online', maxTokensOnline: 1024 });
    expect(body.system).toBe('sys');
    expect(body.messages).toEqual([{ role: 'user', content: 'user msg' }]);
    expect(body.max_tokens).toBe(1024);
    // Anthropic requests never carry OpenAI-shaped fields.
    expect(body.response_format).toBeUndefined();
    expect(body.num_ctx).toBeUndefined();
  });

  test('anthropic style omits max_tokens for a local provider (matches the openai/lm-studio path)', () => {
    const body = buildBody({ ...base, targetStyle: 'anthropic', provider: 'local', maxTokensOnline: 1024 });
    expect(body.max_tokens).toBeUndefined();
  });

  test('local-gemini style uses system_prompt/input, not a messages array', () => {
    const body = buildBody({ ...base, targetStyle: 'local-gemini' });
    expect(body).toEqual({ model: 'test-model', system_prompt: 'sys', input: 'user msg' });
  });

  test('images are attached as image_url parts for openai/lm-studio style', () => {
    const body = buildBody({ ...base, images: ['data:image/png;base64,AAAA'] });
    expect(Array.isArray(body.messages[1].content)).toBe(true);
    expect(body.messages[1].content[0]).toEqual({ type: 'text', text: 'user msg' });
    expect(body.messages[1].content[1].image_url.url).toBe('data:image/jpeg;base64,AAAA');
  });

  test('no images means user content stays a plain string', () => {
    expect(buildBody(base).messages[1].content).toBe('user msg');
  });

  test('substitutes the real configured model for the qwen placeholder', () => {
    const original = process.env.OPENAI_API_MODEL;
    process.env.OPENAI_API_MODEL = 'my-real-model';
    expect(buildBody({ ...base, modelName: 'qwen2.5-coder-7b-instruct' }).model).toBe('my-real-model');
    if (original === undefined) delete process.env.OPENAI_API_MODEL; else process.env.OPENAI_API_MODEL = original;
  });
});

describe('buildStreamBody', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' }
  ];

  test('openai/lm-studio style passes messages through with sampling defaults', () => {
    const body = buildStreamBody({ targetStyle: 'openai', modelName: 'm', messages });
    expect(body.messages).toBe(messages);
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.7);
    expect(body.frequency_penalty).toBe(0.3);
    expect(body.presence_penalty).toBe(0.1);
  });

  test('sampling params are overridable', () => {
    const body = buildStreamBody({ targetStyle: 'openai', modelName: 'm', messages, temperature: 0.2, frequencyPenalty: 0, presencePenalty: 0 });
    expect(body.temperature).toBe(0.2);
    expect(body.frequency_penalty).toBe(0);
    expect(body.presence_penalty).toBe(0);
  });

  test('lm-studio style sets num_ctx', () => {
    expect(buildStreamBody({ targetStyle: 'lm-studio', modelName: 'm', messages }).num_ctx).toBe(LM_STUDIO_NUM_CTX);
  });

  test('anthropic style splits out the system message and drops the system role from messages', () => {
    const body = buildStreamBody({ targetStyle: 'anthropic', modelName: 'm', messages });
    expect(body.system).toBe('sys');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);
    expect(body.stream).toBe(true);
  });

  test('anthropic style omits "system" entirely when there is no system message', () => {
    const body = buildStreamBody({ targetStyle: 'anthropic', modelName: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(body.system).toBeUndefined();
  });

  test('local-gemini style flattens history into a single conversation string', () => {
    const body = buildStreamBody({ targetStyle: 'local-gemini', modelName: 'm', messages });
    expect(body.system_prompt).toBe('sys');
    expect(body.input).toBe('User: hi\nAssistant: hello');
  });
});

describe('extractResponseText', () => {
  test('anthropic style reads content[0].text', () => {
    expect(extractResponseText({ content: [{ text: 'hi there' }] }, 'anthropic')).toBe('hi there');
  });
  test('anthropic style with no content returns empty string, not a throw', () => {
    expect(extractResponseText({}, 'anthropic')).toBe('');
  });
  test('openai-shaped response reads choices[0].message.content', () => {
    expect(extractResponseText({ choices: [{ message: { content: 'hi' } }] }, 'openai')).toBe('hi');
  });
  test('falls back to a bare "response" or "content" field for non-standard local servers', () => {
    expect(extractResponseText({ response: 'via response field' }, 'lm-studio')).toBe('via response field');
    expect(extractResponseText({ content: 'via content field' }, 'lm-studio')).toBe('via content field');
  });
});

describe('resolveModelName', () => {
  test('passes through any real model name unchanged', () => {
    expect(resolveModelName('gpt-4o')).toBe('gpt-4o');
  });
  test('substitutes the qwen placeholder with OPENAI_API_MODEL or its own default', () => {
    const original = process.env.OPENAI_API_MODEL;
    delete process.env.OPENAI_API_MODEL;
    expect(resolveModelName('qwen2.5-coder-7b-instruct')).toBe('qwen2.5-coder-7b-instruct');
    process.env.OPENAI_API_MODEL = 'custom-model';
    expect(resolveModelName('qwen2.5-coder-7b-instruct')).toBe('custom-model');
    if (original === undefined) delete process.env.OPENAI_API_MODEL; else process.env.OPENAI_API_MODEL = original;
  });
});
