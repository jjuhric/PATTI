const { encrypt, decrypt } = require('../utils/crypto');

describe('Crypto Utility Tests', () => {
  test('encrypt and decrypt should restore original text', () => {
    const originalText = 'my-secret-key-123';
    const encrypted = encrypt(originalText);
    expect(encrypted).not.toBe(originalText);
    expect(encrypted.split(':').length).toBe(3);

    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(originalText);
  });

  test('decrypt should return original text if not encrypted (split length !== 3)', () => {
    const rawText = 'unencrypted_string';
    const decrypted = decrypt(rawText);
    expect(decrypted).toBe(rawText);
  });

  test('decrypt should return original text on empty value', () => {
    expect(decrypt('')).toBe('');
    expect(decrypt(null)).toBe(null);
    expect(decrypt(undefined)).toBe(undefined);
  });

  test('encrypt should return original on empty value', () => {
    expect(encrypt('')).toBe('');
    expect(encrypt(null)).toBe(null);
    expect(encrypt(undefined)).toBe(undefined);
  });

  test('decrypt should catch errors and return original text', () => {
    // Malformed hex that would fail to parse/decrypt
    const invalidCipher = '1234:5678:90ab';
    const decrypted = decrypt(invalidCipher);
    expect(decrypted).toBe(invalidCipher);
  });

  test('DB_ENCRYPTION_SALT changes the derived key - old ciphertext no longer decrypts under a new salt (SEC-9)', () => {
    const originalSalt = process.env.DB_ENCRYPTION_SALT;
    try {
      delete process.env.DB_ENCRYPTION_SALT;
      jest.resetModules();
      const defaultSaltCrypto = require('../utils/crypto');
      const encryptedUnderDefaultSalt = defaultSaltCrypto.encrypt('rotate-me');

      process.env.DB_ENCRYPTION_SALT = 'a-different-random-salt';
      jest.resetModules();
      const customSaltCrypto = require('../utils/crypto');

      // Same plaintext, different salt -> different ciphertext.
      expect(customSaltCrypto.encrypt('rotate-me')).not.toBe(encryptedUnderDefaultSalt);
      // Ciphertext produced under the old (default) salt does not decrypt correctly once the
      // salt changes - this is exactly why rotating it requires the migration script, not a
      // bare env var flip.
      expect(customSaltCrypto.decrypt(encryptedUnderDefaultSalt)).not.toBe('rotate-me');
    } finally {
      if (originalSalt === undefined) delete process.env.DB_ENCRYPTION_SALT;
      else process.env.DB_ENCRYPTION_SALT = originalSalt;
      jest.resetModules();
    }
  });
});
