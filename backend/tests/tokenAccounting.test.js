const { estimateTokens, logTokenUsage } = require('../utils/tokenAccounting');

describe('tokenAccounting (ENH-1/ENH-2)', () => {
  describe('estimateTokens', () => {
    test('returns 0 for empty/null/undefined text', () => {
      expect(estimateTokens('')).toBe(0);
      expect(estimateTokens(null)).toBe(0);
      expect(estimateTokens(undefined)).toBe(0);
    });

    test('returns a real BPE token count, not a length/4 approximation', () => {
      // "Hello world, this is a test of the tokenizer." is 47 chars -> length/4 would give 12;
      // the real cl100k_base count is 11, proving this isn't just doing char-based math.
      const text = 'Hello world, this is a test of the tokenizer.';
      expect(estimateTokens(text)).toBe(11);
      expect(estimateTokens(text)).not.toBe(Math.ceil(text.length / 4));
    });

    test('counts JSON-shaped text (the common case for this system) reasonably', () => {
      const json = JSON.stringify({ thought: 'checking the weather', tool: 'weather', action: 'get', params: { zipcode: '32421' } });
      const count = estimateTokens(json);
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(json.length); // sanity: tokens should be fewer than characters
    });

    test('falls back to length/4 if tokenization throws', () => {
      jest.resetModules();
      jest.doMock('gpt-tokenizer', () => ({
        countTokens: () => { throw new Error('tokenizer exploded'); }
      }));
      const { estimateTokens: estimateWithBrokenTokenizer } = require('../utils/tokenAccounting');
      expect(estimateWithBrokenTokenizer('twelve characters')).toBe(Math.ceil('twelve characters'.length / 4));
      jest.dontMock('gpt-tokenizer');
    });
  });

  describe('logTokenUsage', () => {
    test('inserts a token_usage row with the given values', async () => {
      const db = { run: jest.fn().mockResolvedValue({ lastID: 1 }) };
      await logTokenUsage(db, 1, 'gemini-2.0-flash', 'online', 42);
      expect(db.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO token_usage'),
        [1, 'gemini-2.0-flash', 'online', 42]
      );
    });

    test('falls back to "unknown" for a missing model name', async () => {
      const db = { run: jest.fn().mockResolvedValue({ lastID: 1 }) };
      await logTokenUsage(db, 1, null, 'local', 10);
      expect(db.run).toHaveBeenCalledWith(expect.any(String), [1, 'unknown', 'local', 10]);
    });

    test('does nothing when db/userId are missing', async () => {
      const db = { run: jest.fn() };
      await logTokenUsage(null, 1, 'm', 'local', 10);
      await logTokenUsage(db, null, 'm', 'local', 10);
      expect(db.run).not.toHaveBeenCalled();
    });

    test('does not throw if the db write fails (fire-and-forget)', async () => {
      const db = { run: jest.fn().mockRejectedValue(new Error('db down')) };
      await expect(logTokenUsage(db, 1, 'm', 'local', 10, 'test context')).resolves.toBeUndefined();
    });
  });
});
