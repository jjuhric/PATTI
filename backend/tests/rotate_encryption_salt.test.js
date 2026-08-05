const { deriveKey, encryptWithKey, decryptWithKey } = require('../scripts/rotate_encryption_salt');

describe('rotate_encryption_salt.js - pure crypto helpers', () => {
  test('encryptWithKey/decryptWithKey round-trip under the same key', () => {
    const key = deriveKey('a-secret', 'a-salt');
    const ciphertext = encryptWithKey(key, 'hello world');
    expect(ciphertext.split(':').length).toBe(3);
    expect(decryptWithKey(key, ciphertext)).toBe('hello world');
  });

  test('a different salt derives a different key', () => {
    const keyA = deriveKey('a-secret', 'salt');
    const keyB = deriveKey('a-secret', 'a-different-salt');
    expect(keyA.equals(keyB)).toBe(false);
  });

  test('decryptWithKey returns null for a value that is not 3-part ciphertext', () => {
    expect(decryptWithKey(deriveKey('s', 'salt'), 'plain-unencrypted-value')).toBeNull();
  });
});

describe('rotate_encryption_salt.js - main() migration flow', () => {
  let mockDb;
  let originalExit;
  let originalEnv;

  beforeEach(() => {
    jest.resetModules();
    mockDb = { all: jest.fn(), run: jest.fn() };
    jest.doMock('../db', () => ({ getDb: jest.fn(() => Promise.resolve(mockDb)) }));
    originalExit = process.exit;
    process.exit = jest.fn();
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.exit = originalExit;
    process.env = originalEnv;
    jest.dontMock('../db');
  });

  test('aborts with no DB writes if DB_ENCRYPTION_SECRET is missing', async () => {
    delete process.env.DB_ENCRYPTION_SECRET;
    process.env.DB_ENCRYPTION_SALT_NEW = 'new-salt';
    const { main } = require('../scripts/rotate_encryption_salt');
    await main();
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(mockDb.all).not.toHaveBeenCalled();
  });

  test('aborts with no DB writes if DB_ENCRYPTION_SALT_NEW is missing', async () => {
    process.env.DB_ENCRYPTION_SECRET = 'a-secret';
    delete process.env.DB_ENCRYPTION_SALT_NEW;
    const { main } = require('../scripts/rotate_encryption_salt');
    await main();
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(mockDb.all).not.toHaveBeenCalled();
  });

  test('aborts if the new salt matches the salt already in use', async () => {
    process.env.DB_ENCRYPTION_SECRET = 'a-secret';
    process.env.DB_ENCRYPTION_SALT = 'same-salt';
    process.env.DB_ENCRYPTION_SALT_NEW = 'same-salt';
    const { main } = require('../scripts/rotate_encryption_salt');
    await main();
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(mockDb.all).not.toHaveBeenCalled();
  });

  test('re-encrypts encrypted columns under the new salt and leaves plaintext/empty values alone', async () => {
    process.env.DB_ENCRYPTION_SECRET = 'a-secret';
    delete process.env.DB_ENCRYPTION_SALT; // legacy default 'salt'
    process.env.DB_ENCRYPTION_SALT_NEW = 'brand-new-salt';

    const { deriveKey: derive, encryptWithKey: encWith } = require('../scripts/rotate_encryption_salt');
    const oldKey = derive('a-secret', 'salt');
    const encryptedUnderOldSalt = encWith(oldKey, 'my-api-key-123');

    mockDb.all.mockImplementation(async (sql) => {
      if (sql.includes('FROM users')) {
        return [{ id: 1, weather_api_key: encryptedUnderOldSalt }];
      }
      if (sql.includes('FROM user_settings')) {
        return [{ id: 1, gemini_key: null, local_key: 'not-actually-encrypted', online_key: null }];
      }
      if (sql.includes('FROM network_nodes')) {
        return [];
      }
      return [];
    });

    const { main } = require('../scripts/rotate_encryption_salt');
    await main();

    // One real re-encrypt (users.weather_api_key); local_key is left alone since it isn't
    // recognized ciphertext, and null columns are skipped entirely.
    expect(mockDb.run).toHaveBeenCalledTimes(1);
    const [sql, params] = mockDb.run.mock.calls[0];
    expect(sql).toContain('UPDATE users SET weather_api_key = ? WHERE id = ?');
    expect(params[1]).toBe(1);

    const newKey = derive('a-secret', 'brand-new-salt');
    const { decryptWithKey: decWith } = require('../scripts/rotate_encryption_salt');
    expect(decWith(newKey, params[0])).toBe('my-api-key-123');

    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
