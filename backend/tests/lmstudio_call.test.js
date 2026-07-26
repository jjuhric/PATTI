const axios = require('axios');
jest.mock('axios');

const { callLMStudio } = require('../utils/lmstudio');
const { cleanAgentResponse, processAgentTurn } = require('../ai');

describe('LM Studio Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('callLMStudio', () => {
    test('should successfully post messages and return content', async () => {
      const mockResponse = {
        data: {
          choices: [
            {
              message: {
                content: '{"thought": "test", "tool": "none"}'
              }
            }
          ]
        }
      };
      axios.post.mockResolvedValueOnce(mockResponse);

      const messages = [{ role: 'user', content: 'test prompt' }];
      const result = await callLMStudio(messages);

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:1234/v1/chat/completions',
        {
          model: 'qwen2.5-coder-7b-instruct',
          messages: messages,
          temperature: 0.1,
          top_p: 0.9,
          num_ctx: 32768,
          response_format: { type: 'json_object' }
        },
        {
          timeout: 120000
        }
      );
      expect(result).toBe('{"thought": "test", "tool": "none"}');
    });

    test('should throw error if axios post fails', async () => {
      axios.post.mockRejectedValueOnce(new Error('Network error'));
      await expect(callLMStudio([])).rejects.toThrow('Network error');
    });
  });

  describe('cleanAgentResponse', () => {
    test('should strip off think blocks', () => {
      const rawText = '<think>some internal thought</think>{"tool": "none"}';
      expect(cleanAgentResponse(rawText)).toBe('{"tool": "none"}');
    });

    test('should handle empty or null string', () => {
      expect(cleanAgentResponse('')).toBe('');
      expect(cleanAgentResponse(null)).toBe('');
    });

    test('should return rawText trim if no think tags', () => {
      const rawText = '{"tool": "none"}';
      expect(cleanAgentResponse(rawText)).toBe('{"tool": "none"}');
    });
  });

  describe('processAgentTurn', () => {
    test('should call callLMStudio, clean response and parse JSON', async () => {
      const mockResponse = {
        data: {
          choices: [
            {
              message: {
                content: '<think>thoughts</think>{"tool": "none"}'
              }
            }
          ]
        }
      };
      axios.post.mockResolvedValueOnce(mockResponse);

      const result = await processAgentTurn([{ role: 'user', content: 'hello' }]);
      expect(result).toEqual({ tool: 'none' });
    });

    test('should throw error if result is invalid JSON', async () => {
      const mockResponse = {
        data: {
          choices: [
            {
              message: {
                content: '<think>thoughts</think>invalid-json'
              }
            }
          ]
        }
      };
      axios.post.mockResolvedValueOnce(mockResponse);

      await expect(processAgentTurn([])).rejects.toThrow(
        'Model emitted an invalid tool orchestration structure.'
      );
    });
  });
});
