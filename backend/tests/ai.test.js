const { runAgentLoop, generateGreetingAndSave } = require('../ai');

// Mock SQLite db.js
let mockTestDb = null;
jest.mock('../db', () => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const fs = require('fs');
  const path = require('path');

  return {
    getDb: async () => {
      if (mockTestDb) return mockTestDb;
      mockTestDb = await open({
        filename: ':memory:',
        driver: sqlite3.Database
      });
      const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
      await mockTestDb.exec(schemaSql);
      return mockTestDb;
    }
  };
});

// Mock Google Generative AI SDK
const mockGenerateContent = jest.fn();
const mockGenerateContentStream = jest.fn();
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockImplementation(() => ({
      generateContent: mockGenerateContent,
      generateContentStream: mockGenerateContentStream
    }))
  }))
}));

// Route global fetch mock calls dynamically by URL matching
let routerDecisions = [];
let routerCallIndex = 0;
let forceRouterFormatError = false;
let forceResponderError = false;

global.fetch = jest.fn().mockImplementation((url, options) => {
  const urlStr = String(url || '');

  // 1. Router or Responder LLM Endpoint Matches
  if (urlStr.includes('/chat/completions') || urlStr.includes('/v1/messages') || urlStr.includes('/api/v1/chat') || urlStr.includes('1234')) {
    const isStreaming = options && options.body && JSON.parse(options.body).stream === true;
    const isRouter = !isStreaming;
    
    if (isRouter) {
      if (forceRouterFormatError) {
        forceRouterFormatError = false; // clear flag for retry
        return Promise.resolve({
          ok: false,
          status: 400,
          text: async () => 'response_format not supported',
          headers: { get: () => 'text/plain' }
        });
      }
      
      const decision = routerDecisions[routerCallIndex++] || {
        thought: 'No tool.',
        tool: 'none',
        action: '',
        params: {}
      };
      
      const isAnthropic = urlStr.includes('/v1/messages');
      return Promise.resolve({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => {
          if (isAnthropic) {
            return {
              content: [{ text: typeof decision === 'string' ? decision : JSON.stringify(decision) }]
            };
          }
          return {
            choices: [{
              message: {
                content: typeof decision === 'string' ? decision : JSON.stringify(decision)
              }
            }]
          };
        }
      });
    } else {
      // Responder Stream/JSON response
      if (forceResponderError) {
        return Promise.resolve({
          ok: false,
          status: 503,
          text: async () => 'Service Unavailable',
          headers: { get: () => 'text/plain' }
        });
      }

      const isAnthropic = urlStr.includes('/v1/messages');
      if (isAnthropic) {
        return Promise.resolve({
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({
            content: [{ text: 'Anthropic responder output.' }]
          })
        });
      }

      // Standard OpenAI event stream
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi responder output."}}]}\n\ndata: [DONE]\n'));
          controller.close();
        }
      });

      return Promise.resolve({
        ok: true,
        headers: {
          get: (h) => h === 'content-type' ? 'text/event-stream' : null
        },
        body: {
          getReader: () => mockStream.getReader()
        }
      });
    }
  }

  // 2. Weather Tool Coordinates
  if (urlStr.includes('geo/1.0/zip')) {
    return Promise.resolve({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ lat: 30.92, lon: -85.12, name: 'Calhoun County' })
    });
  }

  // 3. Weather Tool Details
  if (urlStr.includes('data/2.5/weather')) {
    return Promise.resolve({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        weather: [{ description: 'sunny' }],
        main: { temp: 70 },
        wind: { speed: 1 }
      })
    });
  }

  // 5. DuckDuckGo Search Scraper
  if (urlStr.includes('duckduckgo.com')) {
    return Promise.resolve({
      ok: true,
      headers: { get: () => 'text/html' },
      text: async () => '<html></html>'
    });
  }

  // 6. Google News RSS feed
  if (urlStr.includes('news.google.com')) {
    return Promise.resolve({
      ok: true,
      headers: { get: () => 'application/xml' },
      text: async () => '<rss></rss>'
    });
  }

  // Fail-safe crawler/page crawl output
  return Promise.resolve({
    ok: true,
    headers: { get: () => 'text/html' },
    json: async () => ({}),
    text: async () => '<html><body>Page text</body></html>'
  });
});

describe('Agent Loop & LLM Stream Unit Tests', () => {
  let db;
  let userId;

  beforeAll(async () => {
    const { open } = require('sqlite');
    const sqlite3 = require('sqlite3');
    const fs = require('fs');
    const path = require('path');

    db = await open({
      filename: ':memory:',
      driver: sqlite3.Database
    });
    mockTestDb = db;
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await db.exec(schemaSql);

    // Seed user with zipcode/country to ensure weather tool executes fetches
    const userRes = await db.run(`
      INSERT INTO users (username, password_hash, zipcode, country, temp_unit, weather_api_key) 
      VALUES ('aiuser', 'hashed', '32421', 'US', 'imperial', 'test_key')
    `);
    userId = userRes.lastID;
  });

  afterAll(async () => {
    if (db) {
      await db.close();
      mockTestDb = null;
    }
  });

  beforeEach(() => {
    routerDecisions = [];
    routerCallIndex = 0;
    forceRouterFormatError = false;
    forceResponderError = false;
    jest.clearAllMocks();
  });

  test('runAgentLoop - Local LLM style with retry on response_format failure', async () => {
    forceRouterFormatError = true;
    routerDecisions = [
      {
        thought: 'No tool needed.',
        tool: 'none',
        action: '',
        params: {}
      }
    ];

    const thoughts = [];
    const contents = [];

    await runAgentLoop({
      db,
      userId,
      provider: 'local',
      modelName: 'qwen3-8b',
      userMessage: 'Hello',
      history: [],
      localApiKey: 'test_key',
      onThought: (t) => thoughts.push(t),
      onContent: (c) => contents.push(c),
      onToolCall: jest.fn()
    });

    expect(contents.join('')).toBe('Hi responder output.');
  });

  test('runAgentLoop - threads uploaded images into the final responder message as multimodal content', async () => {
    routerDecisions = [
      {
        thought: 'No tool needed.',
        tool: 'none',
        action: '',
        params: {}
      }
    ];

    const testImage = 'data:image/png;base64,AAAABBBB';

    await runAgentLoop({
      db,
      userId,
      provider: 'local',
      modelName: 'google/gemma-4-e4b',
      userMessage: 'What is in this image?',
      images: [testImage],
      history: [],
      localApiKey: 'test_key',
      onThought: jest.fn(),
      onContent: jest.fn(),
      onToolCall: jest.fn()
    });

    const responderCall = global.fetch.mock.calls.find(([url, options]) => {
      const urlStr = String(url || '');
      const isChatEndpoint = urlStr.includes('/chat/completions') || urlStr.includes('1234');
      const isStreaming = options && options.body && JSON.parse(options.body).stream === true;
      return isChatEndpoint && isStreaming;
    });

    expect(responderCall).toBeDefined();
    const body = JSON.parse(responderCall[1].body);
    const userMsg = body.messages.find(m => m.role === 'user');

    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content[0]).toEqual({ type: 'text', text: 'What is in this image?' });
    expect(userMsg.content[1]).toEqual({ type: 'image_url', image_url: { url: testImage } });
  });

  test('runAgentLoop - Anthropic style provider path', async () => {
    routerDecisions = [
      {
        thought: 'Run weather tool.',
        tool: 'weather',
        action: 'current',
        params: { zipcode: '32421', country: 'US' }
      },
      {
        thought: 'Finish.',
        tool: 'none',
        action: '',
        params: {}
      }
    ];

    const contents = [];
    await runAgentLoop({
      db,
      userId,
      provider: 'online',
      modelName: 'claude-3-sonnet',
      userMessage: 'Weather please',
      history: [{ role: 'assistant', content: 'previous response' }],
      onlineUrl: 'https://api.anthropic.com',
      onlineProvider: 'anthropic',
      onlineKey: 'anthropic_key',
      onThought: jest.fn(),
      onContent: (c) => contents.push(c),
      onToolCall: jest.fn()
    });

    expect(contents.join('')).toBe('Anthropic responder output.');
  });

  test('runAgentLoop - router parser fallback on malformed response', async () => {
    routerDecisions = [
      'Malformed plain text response that fails JSON parsing'
    ];

    const contents = [];
    await runAgentLoop({
      db,
      userId,
      provider: 'local',
      modelName: 'gemma',
      userMessage: 'Query',
      history: [],
      onThought: jest.fn(),
      onContent: (c) => contents.push(c),
      onToolCall: jest.fn()
    });

    expect(contents.join('')).toBe('Hi responder output.');
  });

  test('runAgentLoop - executes multi-tool routing turns and markdown code blocks', async () => {
    routerDecisions = [
      '```json\n{\n  "thought": "I will check the time",\n  "tool": "time",\n  "action": "get_current_time",\n  "params": {}\n}\n```',
      {
        thought: 'I will check calendar',
        tool: 'calendar',
        action: 'list',
        params: { date: '2026-06-30' }
      },
      {
        thought: 'I will search web',
        tool: 'search_web',
        action: 'search',
        params: { query: 'Cowboys' }
      },
      {
        thought: 'I will check google news',
        tool: 'google_news',
        action: 'list',
        params: { query: 'Gemma' }
      },
      {
        thought: 'All done.',
        tool: 'none',
        action: '',
        params: {}
      }
    ];

    const contents = [];
    await runAgentLoop({
      db,
      userId,
      provider: 'local',
      modelName: 'gemma',
      userMessage: 'Time and calendar news',
      history: [],
      onThought: jest.fn(),
      onContent: (c) => contents.push(c),
      onToolCall: jest.fn()
    });

    expect(contents.join('')).toBe('Hi responder output.');
  });

  test('runAgentLoop - passes prior INPUT_REQUIRED_CHOICES turn to Communication Specialist so "Approve Tasks" isn\'t answered blind', async () => {
    // Regression test: the Communication Specialist's "Create Project Idea"
    // translation step used to always receive an empty history array in
    // non-test environments, so when the user replied "Approve Tasks" to a
    // prior clarification prompt, it had zero grounding for what was being
    // approved and fabricated an unrelated response instead. NODE_ENV is
    // flipped here specifically to exercise that production-only code path
    // (it's skipped entirely under NODE_ENV=test) and restored afterward.
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      routerDecisions = [
        {
          thought: 'User approved the previously proposed task breakdown.',
          tool: 'none',
          action: 'translate',
          params: { requested_action: 'sports', data_needed: 'Dallas Cowboys schedule' }
        },
        { thought: 'Nothing further to do.', tool: 'none', action: '', params: {} }
      ];

      const priorChoicesPayload = `INPUT_REQUIRED_CHOICES:${JSON.stringify({
        question: 'Would you like me to proceed with these tasks?\n1. Add a new skill.\n2. Fetch the ESPN schedule.',
        choices: ['Approve Tasks', 'Cancel']
      })}`;

      await runAgentLoop({
        db,
        userId,
        provider: 'local',
        modelName: 'gemma',
        supervisorModel: 'gemma',
        userMessage: 'Approve Tasks',
        history: [
          { role: 'user', content: 'Add a new skill for yourself to use to fetch the ESPN schedule.' },
          { role: 'assistant', content: priorChoicesPayload }
        ],
        onThought: jest.fn(),
        onContent: jest.fn(),
        onToolCall: jest.fn()
      });

      // The first non-streaming LLM call is the Communication Specialist's
      // translate-to-Project-Idea step - its request body must carry the
      // prior turn, not an empty history array.
      const firstCallBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      const promptText = JSON.stringify(firstCallBody);
      expect(promptText).toContain('INPUT_REQUIRED_CHOICES');
      expect(promptText).toContain('Add a new skill');
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  test('runAgentLoop - "general_knowledge_answer" from the Communication Specialist answers directly and skips the Supervisor entirely', async () => {
    // Guardrail against wasting a web search credit on stable, pre-2024 general knowledge
    // (e.g. "what natural remedies repel spiders safely?") that the LLM already knows - the
    // Communication Specialist should short-circuit straight to an answer instead of ever
    // handing off to the Supervisor/web_searcher pipeline. NODE_ENV is flipped to exercise the
    // production-only translation step, same as the "Approve Tasks" test above.
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const directAnswer = 'Great question! 🌸 Peppermint oil, vinegar, and diatomaceous earth are all natural, pet-safe spider deterrents.';
      routerDecisions = [
        {
          thought: 'Stable general knowledge, answering directly.',
          tool: 'none',
          action: 'translate',
          params: { requested_action: 'general_knowledge_answer', answer: directAnswer }
        },
        // Should never be consumed - proves the Supervisor turn never ran.
        { thought: 'Should not run.', tool: 'none', action: '', params: {} }
      ];

      const contents = [];
      await runAgentLoop({
        db,
        userId,
        provider: 'local',
        modelName: 'gemma',
        supervisorModel: 'gemma',
        userMessage: 'What natural remedies repel spiders while staying safe for pets?',
        history: [],
        onThought: jest.fn(),
        onContent: (c) => contents.push(c),
        onToolCall: jest.fn()
      });

      expect(contents.join('')).toBe(directAnswer);
      expect(routerCallIndex).toBe(1);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  test('callLocalLLMStream - handles custom URL patterns and endpoint failures', async () => {
    forceResponderError = true;
    routerDecisions = [
      {
        thought: 'Finish.',
        tool: 'none',
        action: '',
        params: {}
      }
    ];

    await expect(
      runAgentLoop({
        db,
        userId,
        provider: 'local',
        modelName: 'error-model',
        userMessage: 'Query',
        history: [],
        localApiKey: 'lm-studio',
        onThought: jest.fn(),
        onContent: jest.fn(),
        onToolCall: jest.fn()
      })
    ).rejects.toThrow('Service Unavailable');
  });

  test('runAgentLoop - aborts execution mid-loop if isAborted returns true', async () => {
    routerDecisions = [
      {
        thought: 'Run weather tool.',
        tool: 'weather',
        action: 'current',
        params: { zipcode: '32421', country: 'US' }
      }
    ];

    const thoughts = [];
    const contents = [];
    
    let callCount = 0;
    const isAborted = () => {
      callCount++;
      return callCount > 1;
    };

    await runAgentLoop({
      db,
      userId,
      provider: 'local',
      modelName: 'gemma',
      userMessage: 'Weather please',
      history: [],
      isAborted,
      onThought: (t) => thoughts.push(t),
      onContent: (c) => contents.push(c),
      onToolCall: jest.fn()
    });

    expect(thoughts.join('')).toContain("Stream aborted by user.");
    expect(contents.length).toBe(0);
  });

  test('runAgentLoop - filters out leading assistant messages (greeting) from history', async () => {
    routerDecisions = [
      {
        thought: 'No tool.',
        tool: 'none',
        action: '',
        params: {}
      }
    ];

    const thoughts = [];
    const contents = [];
    const history = [
      { role: 'assistant', content: 'Hello! I am your greeting assistant.' },
      { role: 'user', content: 'Actually I have a question.' },
      { role: 'assistant', content: 'Sure, what is it?' }
    ];

    await runAgentLoop({
      db,
      userId,
      provider: 'local',
      modelName: 'qwen3-8b',
      userMessage: 'What is the capital of France?',
      history,
      localApiKey: 'test_key',
      onThought: (t) => thoughts.push(t),
      onContent: (c) => contents.push(c),
      onToolCall: jest.fn()
    });

    const streamingCall = global.fetch.mock.calls.find(call => {
      if (!call[1] || !call[1].body) return false;
      try {
        const body = JSON.parse(call[1].body);
        return body.stream === true;
      } catch (e) {
        return false;
      }
    });

    expect(streamingCall).toBeDefined();
    const payload = JSON.parse(streamingCall[1].body);
    
    expect(payload.messages.length).toBe(4);
    expect(payload.messages[0].role).toBe('system');
    expect(payload.messages[1].role).toBe('user');
    expect(payload.messages[1].content).toBe('Actually I have a question.');
    expect(payload.messages[2].role).toBe('assistant');
    expect(payload.messages[2].content).toBe('Sure, what is it?');
    expect(payload.messages[3].role).toBe('user');
    expect(payload.messages[3].content).toBe('What is the capital of France?');
  });

  test('generateGreetingAndSave - successfully saves personalized greeting', async () => {
    const chatResult = await db.run("INSERT INTO chats (user_id, title) VALUES (?, ?)", [userId, 'Greeting Chat']);
    const chatId = chatResult.lastID;

    await generateGreetingAndSave(db, userId, chatId);

    const messages = await db.all("SELECT * FROM messages WHERE chat_id = ?", [chatId]);
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toContain("Hello!");
    expect(messages[0].content).toContain("Today is");
    expect(messages[0].content).toContain("What can I do for you next?");
  });

  test('generateGreetingAndSave - successfully saves greeting with name', async () => {
    const userRes = await db.run("INSERT INTO users (username, password_hash, name) VALUES ('nameduser', 'hashed', 'Alice')");
    const testUserId = userRes.lastID;

    const chatResult = await db.run("INSERT INTO chats (user_id, title) VALUES (?, ?)", [testUserId, 'Greeting Chat 2']);
    const chatId = chatResult.lastID;

    await generateGreetingAndSave(db, testUserId, chatId);

    const messages = await db.all("SELECT * FROM messages WHERE chat_id = ?", [chatId]);
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toContain("Hello Alice!");
    expect(messages[0].content).toContain("Today is");
    expect(messages[0].content).toContain("What can I do for you next?");
  });

  test('generateGreetingAndSave - handles database/user query failure gracefully', async () => {
    const mockDb = {
      get: jest.fn().mockRejectedValue(new Error("Query failed")),
      run: jest.fn().mockResolvedValue({})
    };

    await generateGreetingAndSave(mockDb, 9999, 9999);

    expect(mockDb.get).toHaveBeenCalled();
    expect(mockDb.run).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO messages'),
      expect.any(Array)
    );
  });

  test('generateGreetingAndSave - handles insert failure gracefully', async () => {
    const mockDb = {
      get: jest.fn().mockResolvedValue({ name: 'Bob' }),
      run: jest.fn().mockRejectedValue(new Error("Insert failed"))
    };

    await expect(generateGreetingAndSave(mockDb, 9999, 9999)).resolves.not.toThrow();
  });
});
