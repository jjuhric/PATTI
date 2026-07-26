const { runWorkerAgent } = require('../utils/agents');

let mockAgentsGenerateContent = jest.fn();

jest.mock('@google/generative-ai', () => {
  return {
    GoogleGenerativeAI: jest.fn().mockImplementation(() => {
      return {
        getGenerativeModel: jest.fn().mockImplementation(() => {
          return {
            generateContent: mockAgentsGenerateContent
          };
        })
      };
    })
  };
});

// Mock all tools to avoid hitting actual APIs
jest.mock('../tools/weather_tool', () => ({ handleWeatherTool: jest.fn(() => 'weather-ok') }));
jest.mock('../tools/host_machine_tool', () => ({ handleHostMachineTool: jest.fn(() => 'host-ok') }));
jest.mock('../tools/coder_tools', () => ({ handleCoderTool: jest.fn(() => 'coder-ok') }));
jest.mock('../tools/calendar_tool', () => ({ handleCalendarTool: jest.fn(() => 'calendar-ok') }));
jest.mock('../tools/web_search_tool', () => ({ handleWebSearchTool: jest.fn(() => 'search-ok') }));
jest.mock('../tools/google_news_tool', () => ({ handleGoogleNewsTool: jest.fn(() => 'news-ok') }));
jest.mock('../tools/memory_tool', () => ({ handleMemoryTool: jest.fn(() => 'memory-ok') }));
jest.mock('../tools/vault_tool', () => ({ handleVaultTool: jest.fn(() => 'vault-ok') }));

const originalFetch = global.fetch;

describe('Agents Coverage Extender Tests', () => {
  let mockRunAgentTurn;

  beforeEach(() => {
    // We mock runAgentTurn by temporarily overriding it in the module cache or matching the LLM call
    mockRunAgentTurn = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('runWorkerAgent should route tool actions correctly', async () => {
    const settings = {
      provider: 'openai',
      onlineKey: 'fake-key',
      modelName: 'gpt-4'
    };

    // We can spy on runAgentTurn inside the required file, but since it is not exported,
    // we can mock the global fetch to return decisions!
    const decisions = [
      { tool: 'weather', action: 'get_forecast' },
      { tool: 'host_machine', action: 'get_specifications' },
      { tool: 'read_file', action: 'read' },
      { tool: 'calendar', action: 'list' },
      { tool: 'search_web', action: 'query' },
      { tool: 'google_news', action: 'query' },
      { tool: 'memory', action: 'recall' },
      { tool: 'query_vault', action: 'query' },
      { tool: 'delegate_to_remote_node', params: { nodeId: 1, command: 'status' } },
      { tool: 'unknown_tool', action: 'query' },
      { tool: 'none' } // Stop the loop
    ];

    let decisionIdx = 0;
    global.fetch = jest.fn().mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/bridge/execute')) {
        return {
          ok: true,
          json: async () => ({ success: true, status: 'online' })
        };
      }
      const decision = decisions[decisionIdx++];
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify(decision)
            }
          }]
        })
      };
    });

    const result = await runWorkerAgent('weather_expert', settings, 'What is the weather?', {}, 1);
    expect(result).toBeDefined();

    // Call again to hit the rest of the tools (maxTurns = 5 per call)
    const result2 = await runWorkerAgent('weather_expert', settings, 'What is the weather?', {}, 1);
    expect(result2).toBeDefined();
  });

  test('runAgentTurn with anthropic style headers and response parsing', async () => {
    const settings = {
      provider: 'online',
      onlineProvider: 'anthropic',
      onlineKey: 'sk-ant-123',
      onlineUrl: 'https://api.anthropic.com/v1',
      model_name: 'claude-3-opus'
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ tool: 'none', thought: 'no tool' }) } }],
        content: [{ text: JSON.stringify({ tool: 'none', thought: 'no tool' }) }],
        usage: { input_tokens: 5, output_tokens: 15 }
      })
    });

    const { runAgentLoop } = require('../ai');
    const result = await runAgentLoop({
      userMessage: 'Hello',
      db: {},
      userId: 1,
      provider: 'online',
      onlineProvider: 'anthropic',
      onlineKey: 'sk-ant-123',
      onlineUrl: 'https://api.anthropic.com/v1',
      modelName: 'claude-3-opus',
      onThought: jest.fn(),
      onContent: jest.fn(),
      onToolCall: jest.fn()
    });
    expect(result).toBeUndefined();
  });

  test('runAgentTurn failure handler covers LLM error throws', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error'
    });

    const { runAgentLoop } = require('../ai');
    await expect(runAgentLoop({
      userMessage: 'Hello',
      db: {},
      userId: 1,
      provider: 'online',
      onlineProvider: 'openai',
      onlineKey: 'sk-123',
      modelName: 'gpt-4',
      onThought: jest.fn(),
      onContent: jest.fn(),
      onToolCall: jest.fn()
    })).rejects.toThrow('LLM API error');
  });

  test('runAgentLoop database queries catch failure blocks', async () => {
    const { runAgentLoop } = require('../ai');
    const mockDb = {
      all: jest.fn().mockRejectedValue(new Error('DB Query failure')),
      get: jest.fn().mockRejectedValue(new Error('DB Get failure')),
      run: jest.fn().mockRejectedValue(new Error('DB Run failure'))
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name) => name === 'content-type' ? 'application/json' : null
      },
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ tool: 'none', thought: 'error fallback test' }) } }]
      })
    });

    await runAgentLoop({
      db: mockDb,
      userId: 1,
      provider: 'local',
      localBaseUrl: 'http://localhost:1234/v1',
      localApiKey: 'key',
      localApiStyle: 'openai',
      userMessage: 'test message',
      history: [],
      onThought: jest.fn(),
      onContent: jest.fn(),
      onToolCall: jest.fn(),
      isAborted: () => false,
      forceMemoryAgent: true
    });
    
    expect(mockDb.all).toHaveBeenCalled();
    expect(mockDb.get).toHaveBeenCalled();
  });

  test('runWorkerAgent query_vault tool routing', async () => {
    const settings = { provider: 'openai', modelName: 'gpt-4' };
    let calls = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({ choices: [{ message: { content: JSON.stringify({ tool: 'query_vault', action: 'query', params: { query: 'test' } }) } }] })
        };
      }
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ choices: [{ message: { content: 'Final response.' } }] })
      };
    });

    const result = await runWorkerAgent('document_vault', settings, 'Query vault', {}, 1);
    expect(result).toBeDefined();
  });

  test('runWorkerAgent unknown tool routing fallback', async () => {
    const settings = { provider: 'openai', modelName: 'gpt-4' };
    let calls = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({ choices: [{ message: { content: JSON.stringify({ tool: 'unknown_tool', action: 'query' }) } }] })
        };
      }
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ choices: [{ message: { content: 'Final response.' } }] })
      };
    });

    const result = await runWorkerAgent('supervisor', settings, 'Query unknown', {}, 1);
    expect(result).toBeDefined();
  });

  test('runAgentLoop should route supervisor tool decisions correctly', async () => {
    const mockDb = {
      all: jest.fn().mockResolvedValue([]),
      get: jest.fn().mockResolvedValue({ name: 'Jeffery', zipcode: '32421', country: 'US', temp_unit: 'imperial' }),
      run: jest.fn().mockRejectedValue(new Error('DB run failed'))
    };

    const decisions = [
      { tool: 'weather', action: 'get_forecast', params: { zipcode: '32421' } },
      { tool: 'host_machine', action: 'get_specifications' },
      { tool: 'delegate_to_remote_node', params: { nodeId: 1, command: 'status' } },
      { tool: 'search_web', action: 'query' },
      { tool: 'google_news', action: 'query' },
      { tool: 'time', action: 'get_current_time' },
      { tool: 'none', thought: 'all done' }
    ];

    let idx = 0;
    global.fetch = jest.fn().mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/bridge/execute')) {
        return { ok: true, json: async () => ({ success: true }) };
      }
      const decision = decisions[idx++];
      // Once the supervisor's decision list is exhausted, this is the final responder
      // call - it must return real, non-empty content or callLocalLLMStream now treats
      // it as a failed generation.
      const content = decision !== undefined
        ? JSON.stringify(decision)
        : 'All done.';
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          choices: [{ message: { content } }]
        })
      };
    });

    const { runAgentLoop } = require('../ai');
    await runAgentLoop({
      userMessage: 'Test supervisor tools',
      db: mockDb,
      userId: 1,
      provider: 'online',
      onlineProvider: 'openai',
      onlineKey: 'key',
      modelName: 'gpt-4',
      onThought: jest.fn(),
      onContent: jest.fn(),
      onToolCall: jest.fn()
    });

    expect(global.fetch).toHaveBeenCalled();
  });

  test('runAgentLoop additional edge paths (URL parsing throw, core memories, subagent name fallbacks)', async () => {
    const mockDb = {
      all: jest.fn().mockImplementation((query) => {
        if (query.includes('LIKE')) {
          // Return a core identity memory row
          return Promise.resolve([{ id: 1, content: 'My name is Jeffery', level: 'core' }]);
        }
        return Promise.resolve([]);
      }),
      get: jest.fn().mockResolvedValue({ name: 'Jeffery', zipcode: '32421', country: 'US', temp_unit: 'imperial' }),
      run: jest.fn().mockRejectedValue(new Error('DB run failed'))
    };

    // 1. URL parser throw branch test by passing an invalid local url 'not_valid_url'
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ tool: 'none', thought: 'url fail test' }) } }],
        usage: { total_tokens: 25 }
      })
    });

    const { runAgentLoop } = require('../ai');
    
    await runAgentLoop({
      userMessage: 'test',
      db: mockDb,
      userId: 1,
      provider: 'local',
      localBaseUrl: 'invalid-url-no-protocol',
      localApiKey: 'key',
      localApiStyle: 'openai',
      onThought: jest.fn(),
      onContent: jest.fn(),
      onToolCall: jest.fn()
    });

    // 2. Subagent name mapping branches test: memory_agent and document_vault
    const decisions = [
      { tool: 'delegate_to_agent', params: { agent: 'memory_agent', task: 'remember something' } },
      { tool: 'delegate_to_agent', params: { agent: 'document_vault', query: 'search docs' } },
      { tool: 'none' }
    ];
    let idx = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(decisions[idx++]) } }]
        })
      };
    });

    await runAgentLoop({
      userMessage: 'test subagents',
      db: mockDb,
      userId: 1,
      provider: 'local',
      localBaseUrl: 'http://localhost:1234/v1',
      localApiKey: 'key',
      localApiStyle: 'openai',
      onThought: jest.fn(),
      onContent: jest.fn(),
      onToolCall: jest.fn()
    });

    expect(mockDb.all).toHaveBeenCalled();
  });

  test('runWorkerAgent abortSignal and non-ok LLM response handling', async () => {
    const controller = new AbortController();
    controller.abort();
    const settings = {
      provider: 'local',
      localBaseUrl: 'http://localhost:1234/v1',
      localApiKey: 'key',
      localApiStyle: 'openai',
      model_name: 'test-model',
      abortSignal: controller.signal
    };

    global.fetch = jest.fn().mockImplementation(async () => {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          choices: [{ message: { content: '{"status":"success","summary":"","data":{}}' } }]
        })
      };
    });

    const res = await runWorkerAgent('weather_expert', settings, 'Test abort', {}, 1);
    expect(res).toBe('{"status":"success","summary":"","data":{}}');

    const badSettings = {
      provider: 'local',
      localBaseUrl: 'http://localhost:1234/v1',
      localApiKey: 'key',
      localApiStyle: 'openai',
      model_name: 'test-model'
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable'
    });

    await expect(runWorkerAgent('weather_expert', badSettings, 'Test fail', {}, 1)).rejects.toThrow('LLM Error: 503');
  });

  test('runWorkerAgent new options: status streaming, command approval, prompt interception', async () => {
    const onIntermediateStatusUpdate = jest.fn();
    const onStatusUpdate = jest.fn();
    const onCommandApprovalRequired = jest.fn().mockResolvedValue(true);
    const onPromptHumanInterception = jest.fn().mockResolvedValue('user context info');

    const settings = {
      provider: 'openai',
      model_name: 'gpt-4',
      onIntermediateStatusUpdate,
      onStatusUpdate,
      onCommandApprovalRequired,
      onPromptHumanInterception
    };

    let fetchCalls = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      fetchCalls++;
      if (fetchCalls === 1) {
        // Mutation action to trigger onCommandApprovalRequired
        return {
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({
            choices: [{ message: { content: JSON.stringify({ tool: 'write_file', action: 'write', params: { filePath: 't.txt', content: 'test' } }) } }]
          })
        };
      }
      if (fetchCalls === 2) {
        // Return output with INPUT_REQUIRED_FROM_USER to trigger onPromptHumanInterception
        return {
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({
            choices: [{ message: { content: JSON.stringify({ tool: 'weather', action: 'get', params: { zipcode: '123' } }) } }]
          })
        };
      }
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ tool: 'none' }) } }]
        })
      };
    });

    const mockCoder = require('../tools/coder_tools');
    mockCoder.handleCoderTool.mockResolvedValueOnce('INPUT_REQUIRED_FROM_USER: What is the city?');

    const result = await runWorkerAgent('coder', settings, 'Write file', {}, 1);
    expect(result).toBeDefined();
    expect(onIntermediateStatusUpdate).toHaveBeenCalled();
    expect(onStatusUpdate).toHaveBeenCalled();
    expect(onCommandApprovalRequired).toHaveBeenCalled();
    expect(onPromptHumanInterception).toHaveBeenCalled();
  });

  test('runWorkerAgent mutation action rejected path', async () => {
    const onCommandApprovalRequired = jest.fn().mockResolvedValue(false);
    const settings = {
      provider: 'openai',
      model_name: 'gpt-4',
      onCommandApprovalRequired
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ tool: 'write_file', action: 'write', params: { filePath: 't.txt', content: 'test' } }) } }]
      })
    });

    const result = await runWorkerAgent('coder', settings, 'Write file', {}, 1);
    expect(result).toContain('Pipeline Interrupted');
    expect(onCommandApprovalRequired).toHaveBeenCalled();
  });

  test('runWorkerAgent and runAgentResponse with gemini provider', async () => {
    const settings = {
      provider: 'gemini',
      geminiKey: 'fake-key',
      model_name: 'gemini-2.0-flash',
      db: { run: jest.fn().mockResolvedValue({ lastID: 1 }) },
      userId: 1
    };

    mockAgentsGenerateContent
      // First call inside runWorkerAgent -> runAgentTurn
      .mockResolvedValueOnce({
        response: {
          text: () => JSON.stringify({ tool: 'none' }),
          usageMetadata: { totalTokenCount: 150 }
        }
      })
      // Second call inside runWorkerAgent -> runAgentResponse
      .mockResolvedValueOnce({
        response: {
          text: () => 'This is the final response summary',
          usageMetadata: { totalTokenCount: 200 }
        }
      });

    const result = await runWorkerAgent('weather_expert', settings, 'What is the weather?', {}, 1);
    expect(result).toBe('{"status":"success","summary":"This is the final response summary","data":{}}');
    expect(mockAgentsGenerateContent).toHaveBeenCalledTimes(2);
  });
});
