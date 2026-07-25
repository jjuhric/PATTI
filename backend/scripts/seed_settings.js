require('dotenv').config();
const { getDb } = require('../db');
const { encrypt } = require('../utils/crypto');
const bcrypt = require('bcryptjs');

function parseArgs(argv) {
  const args = {};
  argv.slice(2).forEach(arg => {
    if (arg.startsWith('--')) {
      const parts = arg.slice(2).split('=');
      const key = parts[0];
      const val = parts.slice(1).join('=');
      args[key] = val;
    }
  });
  return args;
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  const username = (args.username || 'admin').trim();
  const password = args.password || 'adminpassword';
  const deviceType = args.device_type || 'windows';
  const isMainHost = args.is_main_host === '1' || args.is_main_host === 'true' ? 1 : 0;
  
  const localUrl = args.local_url || process.env.LOCAL_LLM_URL || 'http://192.168.1.42:1234/v1';
  const localKey = args.local_key || process.env.LOCAL_LLM_KEY || null;
  const onlineProvider = args.online_provider || process.env.ONLINE_PROVIDER || 'gemini';
  const onlineKey = args.online_key || process.env.GEMINI_API_KEY || null;

  if (username.length === 0) {
    console.error('Error: Username cannot be empty.');
    process.exit(1);
    return;
  }
  if (password.length < 4) {
    console.error('Error: Password must be at least 4 characters long.');
    process.exit(1);
    return;
  }

  console.log(`Initializing SQLite database & seeding settings for user "${username}"...`);

  try {
    const db = await getDb();

    // Check if the user already exists
    const user = await db.get('SELECT id FROM users WHERE username = ?', [username]);
    
    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const name = args.name || null;
    const zipcode = args.zipcode || null;
    const weatherApiKey = args.weather_api_key || null;

    let userId;
    if (user) {
      userId = user.id;
      await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
      console.log(`User "${username}" (ID: ${userId}) updated successfully.`);
    } else {
      const res = await db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, passwordHash]);
      userId = res.lastID;
      console.log(`Created new user "${username}" (ID: ${userId}).`);
    }

    const encryptedWeatherKey = weatherApiKey ? encrypt(weatherApiKey) : null;
    if (name || zipcode || encryptedWeatherKey) {
      await db.run('UPDATE users SET name = COALESCE(?, name), zipcode = COALESCE(?, zipcode), weather_api_key = COALESCE(?, weather_api_key) WHERE id = ?', [name, zipcode, encryptedWeatherKey, userId]);
    }

    // Encrypt keys
    const encryptedLocalKey = localKey ? encrypt(localKey) : null;
    const encryptedOnlineKey = onlineKey ? encrypt(onlineKey) : null;

    // Determine default provider (Rule: always default to local LLM first unless explicitly changed in settings)
    const provider = 'local';
    
    let modelName = process.env.PREFERRED_LOCAL_MODEL || 'google/gemma-4-e4b';
    const path = require('path');
    const defaultWorkingDir = path.resolve(path.join(__dirname, '../..'));
    const workingDir = args.working_directory || process.env.WORKING_DIRECTORY || defaultWorkingDir;

    await db.run(`
      INSERT INTO user_settings (
        user_id, provider, model_name, local_key,
        local_url, local_api_style, online_key, online_provider,
        preferred_local_model, preferred_online_model, supervisor_model,
        device_type, is_main_host, working_directory
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        provider = excluded.provider,
        model_name = excluded.model_name,
        local_key = COALESCE(excluded.local_key, local_key),
        local_url = COALESCE(excluded.local_url, local_url),
        local_api_style = COALESCE(excluded.local_api_style, local_api_style),
        online_key = COALESCE(excluded.online_key, online_key),
        online_provider = COALESCE(excluded.online_provider, online_provider),
        preferred_local_model = COALESCE(excluded.preferred_local_model, preferred_local_model),
        preferred_online_model = COALESCE(excluded.preferred_online_model, preferred_online_model),
        supervisor_model = COALESCE(excluded.supervisor_model, supervisor_model),
        device_type = excluded.device_type,
        is_main_host = excluded.is_main_host,
        working_directory = COALESCE(excluded.working_directory, working_directory)
    `, [
      userId,
      provider,
      modelName,
      encryptedLocalKey,
      localUrl,
      args.local_api_style || 'openai',
      encryptedOnlineKey,
      onlineProvider,
      args.preferred_local_model || process.env.PREFERRED_LOCAL_MODEL || 'google/gemma-4-e4b',
      args.preferred_online_model || process.env.PREFERRED_ONLINE_MODEL || 'google/gemma-4-e4b',
      args.supervisor_model || process.env.SUPERVISOR_MODEL || 'google/gemma-4-e4b',
      deviceType,
      isMainHost,
      workingDir
    ]);

    console.log('User settings initialized and seeded successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Fatal: Failed to seed settings database:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
