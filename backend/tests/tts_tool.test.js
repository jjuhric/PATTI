const fs = require('fs');
const path = require('path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');

jest.mock('../utils/tts', () => ({ generateTTS: jest.fn().mockResolvedValue('/tts/fake.mp3') }));
jest.mock('../utils/tts_narration', () => ({ narrateForSpeech: jest.fn().mockResolvedValue('narrated text') }));

const { handleTtsTool } = require('../tools/tts_tool');
const { generateTTS } = require('../utils/tts');

describe('handleTtsTool', () => {
  let db;
  let userId;

  beforeAll(async () => {
    db = await open({ filename: ':memory:', driver: sqlite3.Database });
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await db.exec(schemaSql);

    const result = await db.run("INSERT INTO users (username, password_hash) VALUES ('ttsuser', 'hashed')");
    userId = result.lastID;
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(() => {
    generateTTS.mockClear();
  });

  test('returns an error string when "text" is missing', async () => {
    const output = await handleTtsTool(db, userId, 'speak', {});
    expect(output).toMatch(/^Error: "text" parameter is required\./);
  });

  test('returns an error string for an unknown action', async () => {
    const output = await handleTtsTool(db, userId, 'bogus_action', { text: 'hi' });
    expect(output).toMatch(/^Error: Unknown action/);
  });

  test('does not generate audio when the user has no settings row at all (Voice Mode never enabled)', async () => {
    const fresh = await db.run("INSERT INTO users (username, password_hash) VALUES ('novoiceuser', 'hashed')");
    const output = await handleTtsTool(db, fresh.lastID, 'speak', { text: 'hello there' });
    expect(output).toMatch(/Voice Mode is currently turned off/);
    expect(generateTTS).not.toHaveBeenCalled();
  });

  test('does not generate audio when voice_mode is explicitly 0', async () => {
    await db.run('INSERT INTO user_settings (user_id, voice_mode) VALUES (?, 0)', [userId]);
    const output = await handleTtsTool(db, userId, 'speak', { text: 'hello there' });
    expect(output).toMatch(/Voice Mode is currently turned off/);
    expect(generateTTS).not.toHaveBeenCalled();
  });

  test('generates audio when voice_mode is enabled', async () => {
    await db.run('UPDATE user_settings SET voice_mode = 1 WHERE user_id = ?', [userId]);
    const output = await handleTtsTool(db, userId, 'speak', { text: 'hello there' });
    expect(output).toMatch(/^Success: Speech generated successfully\./);
    expect(output).toContain('/tts/fake.mp3');
    expect(generateTTS).toHaveBeenCalledTimes(1);
  });
});
