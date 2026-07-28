const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');

let dbConnection = null;

async function getDb() {
  if (dbConnection) return dbConnection;

  const dbPath = process.env.DB_PATH || path.join(__dirname, 'database.db');
  
  // Ensure database directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Load schema
  try {
    dbConnection = await open({
      filename: dbPath,
      driver: sqlite3.Database
    });

    // Enable foreign keys
    await dbConnection.run('PRAGMA foreign_keys = ON');

    // Enable WAL (Write-Ahead Logging) mode and busy timeout for concurrent request handling
    await dbConnection.run('PRAGMA journal_mode = WAL');
    await dbConnection.run('PRAGMA busy_timeout = 5000');

    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await dbConnection.exec(schemaSql);

    // Check if the 'email' column exists in 'users' table, and add it if missing (for legacy databases)
    const columns = await dbConnection.all('PRAGMA table_info(users)');
    const hasEmail = columns.some(col => col.name === 'email');
    if (!hasEmail) {
      await dbConnection.run('ALTER TABLE users ADD COLUMN email TEXT');
    }
    if (!columns.some(col => col.name === 'name')) {
      await dbConnection.run('ALTER TABLE users ADD COLUMN name TEXT');
    }
    if (!columns.some(col => col.name === 'zipcode')) {
      await dbConnection.run('ALTER TABLE users ADD COLUMN zipcode TEXT');
    }
    if (!columns.some(col => col.name === 'temp_unit')) {
      await dbConnection.run("ALTER TABLE users ADD COLUMN temp_unit TEXT DEFAULT 'imperial'");
    }
    if (!columns.some(col => col.name === 'weather_api_key')) {
      await dbConnection.run('ALTER TABLE users ADD COLUMN weather_api_key TEXT');
    }
    if (!columns.some(col => col.name === 'country')) {
      await dbConnection.run("ALTER TABLE users ADD COLUMN country TEXT DEFAULT 'US'");
    }
    if (!columns.some(col => col.name === 'last_briefing_at')) {
      await dbConnection.run("ALTER TABLE users ADD COLUMN last_briefing_at DATETIME");
    }
    if (!columns.some(col => col.name === 'briefing_hour')) {
      await dbConnection.run("ALTER TABLE users ADD COLUMN briefing_hour INTEGER DEFAULT 7");
    }
    if (!columns.some(col => col.name === 'dob')) {
      await dbConnection.run("ALTER TABLE users ADD COLUMN dob TEXT");
    }
    if (!columns.some(col => col.name === 'gender')) {
      await dbConnection.run("ALTER TABLE users ADD COLUMN gender TEXT");
    }
    if (!columns.some(col => col.name === 'political_leaning')) {
      await dbConnection.run("ALTER TABLE users ADD COLUMN political_leaning TEXT DEFAULT 'Undecided'");
    }
    if (!columns.some(col => col.name === 'interests')) {
      await dbConnection.run("ALTER TABLE users ADD COLUMN interests TEXT DEFAULT '[]'");
    }
    if (!columns.some(col => col.name === 'favorite_teams')) {
      await dbConnection.run("ALTER TABLE users ADD COLUMN favorite_teams TEXT DEFAULT '[]'");
    }
    if (!columns.some(col => col.name === 'timezone')) {
      await dbConnection.run("ALTER TABLE users ADD COLUMN timezone TEXT DEFAULT 'America/Chicago'");
    }
    if (!columns.some(col => col.name === 'is_admin')) {
      await dbConnection.run('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0');
    }

    // Migrate user_settings to add local_key column if missing
    const settingsColumns = await dbConnection.all('PRAGMA table_info(user_settings)');
    const hasLocalKey = settingsColumns.some(col => col.name === 'local_key');
    if (!hasLocalKey) {
      await dbConnection.run('ALTER TABLE user_settings ADD COLUMN local_key TEXT');
    }
    
    if (!settingsColumns.some(col => col.name === 'local_url')) {
      await dbConnection.run("ALTER TABLE user_settings ADD COLUMN local_url TEXT DEFAULT 'http://192.168.1.42:1234/v1'");
    }
    if (!settingsColumns.some(col => col.name === 'local_api_style')) {
      await dbConnection.run("ALTER TABLE user_settings ADD COLUMN local_api_style TEXT DEFAULT 'openai'");
    }
    if (!settingsColumns.some(col => col.name === 'online_url')) {
      await dbConnection.run("ALTER TABLE user_settings ADD COLUMN online_url TEXT");
    }
    if (!settingsColumns.some(col => col.name === 'online_key')) {
      await dbConnection.run("ALTER TABLE user_settings ADD COLUMN online_key TEXT");
    }
    if (!settingsColumns.some(col => col.name === 'online_provider')) {
      await dbConnection.run("ALTER TABLE user_settings ADD COLUMN online_provider TEXT DEFAULT 'gemini'");
    }
    if (!settingsColumns.some(col => col.name === 'preferred_local_model')) {
      await dbConnection.run("ALTER TABLE user_settings ADD COLUMN preferred_local_model TEXT");
    }
    if (!settingsColumns.some(col => col.name === 'preferred_online_model')) {
      await dbConnection.run("ALTER TABLE user_settings ADD COLUMN preferred_online_model TEXT");
    }
    if (!settingsColumns.some(col => col.name === 'supervisor_model')) {
      await dbConnection.run("ALTER TABLE user_settings ADD COLUMN supervisor_model TEXT");
    }
    if (!settingsColumns.some(col => col.name === 'device_type')) {
      await dbConnection.run("ALTER TABLE user_settings ADD COLUMN device_type TEXT DEFAULT 'windows'");
    }
    if (!settingsColumns.some(col => col.name === 'is_main_host')) {
      await dbConnection.run("ALTER TABLE user_settings ADD COLUMN is_main_host INTEGER DEFAULT 0");
    }
    if (!settingsColumns.some(col => col.name === 'working_directory')) {
      await dbConnection.run("ALTER TABLE user_settings ADD COLUMN working_directory TEXT");
    }
    if (!settingsColumns.some(col => col.name === 'token_quota')) {
      await dbConnection.run("ALTER TABLE user_settings ADD COLUMN token_quota INTEGER DEFAULT 1000000");
    }
    if (!settingsColumns.some(col => col.name === 'google_home_enabled')) {
      await dbConnection.run("ALTER TABLE user_settings ADD COLUMN google_home_enabled INTEGER DEFAULT 0");
    }
    if (!settingsColumns.some(col => col.name === 'google_home_ip')) {
      await dbConnection.run("ALTER TABLE user_settings ADD COLUMN google_home_ip TEXT");
    }
    if (!settingsColumns.some(col => col.name === 'google_home_name')) {
      await dbConnection.run("ALTER TABLE user_settings ADD COLUMN google_home_name TEXT");
    }
    if (!settingsColumns.some(col => col.name === 'voice_mode')) {
      await dbConnection.run("ALTER TABLE user_settings ADD COLUMN voice_mode INTEGER DEFAULT 0");
    }

    // Migrate memories to add embedding column if missing
    const memoriesColumns = await dbConnection.all('PRAGMA table_info(memories)');
    const hasEmbedding = memoriesColumns.some(col => col.name === 'embedding');
    if (!hasEmbedding) {
      await dbConnection.run('ALTER TABLE memories ADD COLUMN embedding TEXT');
    }
    const hasAgentName = memoriesColumns.some(col => col.name === 'agent_name');
    if (!hasAgentName) {
      await dbConnection.run('ALTER TABLE memories ADD COLUMN agent_name TEXT');
    }

    // Migrate network_nodes to add new columns if missing
    const nodeColumns = await dbConnection.all('PRAGMA table_info(network_nodes)');
    if (!nodeColumns.some(col => col.name === 'mqtt_topic')) {
      await dbConnection.run('ALTER TABLE network_nodes ADD COLUMN mqtt_topic TEXT');
    }
    if (!nodeColumns.some(col => col.name === 'capabilities')) {
      await dbConnection.run("ALTER TABLE network_nodes ADD COLUMN capabilities JSON DEFAULT '[]'");
    }
    if (!nodeColumns.some(col => col.name === 'os_type')) {
      await dbConnection.run('ALTER TABLE network_nodes ADD COLUMN os_type TEXT');
    }
    if (!nodeColumns.some(col => col.name === 'arch')) {
      await dbConnection.run('ALTER TABLE network_nodes ADD COLUMN arch TEXT');
    }
    if (!nodeColumns.some(col => col.name === 'node_version')) {
      await dbConnection.run('ALTER TABLE network_nodes ADD COLUMN node_version TEXT');
    }
    if (!nodeColumns.some(col => col.name === 'ssh_username')) {
      await dbConnection.run('ALTER TABLE network_nodes ADD COLUMN ssh_username TEXT');
    }
    if (!nodeColumns.some(col => col.name === 'ssh_password')) {
      await dbConnection.run('ALTER TABLE network_nodes ADD COLUMN ssh_password TEXT');
    }
    if (!nodeColumns.some(col => col.name === 'ssh_key')) {
      await dbConnection.run('ALTER TABLE network_nodes ADD COLUMN ssh_key TEXT');
    }
    if (!nodeColumns.some(col => col.name === 'node_role')) {
      await dbConnection.run("ALTER TABLE network_nodes ADD COLUMN node_role TEXT DEFAULT 'node'");
    }
    // Only one network_nodes row may ever be the PATTI client - enforced at the DB level
    // via a partial unique index (idempotent for both fresh and legacy databases).
    await dbConnection.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_single_patti_client ON network_nodes(node_role) WHERE node_role = 'patti_client'");

    // Auto-migrate deprecated gemini-1.5-flash entries to gemini-2.0-flash
    await dbConnection.run("UPDATE user_settings SET model_name = 'gemini-2.0-flash' WHERE model_name = 'gemini-1.5-flash'");
    await dbConnection.run("UPDATE user_settings SET preferred_online_model = 'gemini-2.0-flash' WHERE preferred_online_model = 'gemini-1.5-flash'");

    // Migration for token_usage table
    await dbConnection.run(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        model_name TEXT NOT NULL,
        provider_type TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Migration for shown_articles table (Sports Agent)
    await dbConnection.run(`
      CREATE TABLE IF NOT EXISTS shown_articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        article_link TEXT NOT NULL,
        title TEXT NOT NULL,
        seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, article_link)
      )
    `);

    // Seed default custom personality and skills if empty
    try {
      const personalityCountRow = await dbConnection.get('SELECT COUNT(*) as count FROM custom_personalities');
      if (personalityCountRow && personalityCountRow.count === 0) {
        await dbConnection.run(`
          INSERT INTO custom_personalities (name, description, system_prompt, is_active)
          VALUES (?, ?, ?, ?)
        `, [
          'Friendly Secretary',
          'A bubbly, warm, polite, and well-organized secretary persona.',
          'You are a friendly, secretary-like assistant. Speak articulately and politely, break down problems into individual tasks, and check with the user before proceeding.',
          1
        ]);
      }

      const skillCountRow = await dbConnection.get('SELECT COUNT(*) as count FROM custom_skills');
      if (skillCountRow && skillCountRow.count === 0) {
        await dbConnection.run(`
          INSERT INTO custom_skills (name, description, instructions, is_active)
          VALUES (?, ?, ?, ?)
        `, [
          'Smart Home Helper',
          'Standard rules for smart home Google Home operations.',
          'Delegate all smart home commands like turn on/off lights or TVs to the system_specialist agent.',
          1
        ]);
      }
    } catch (e) {
      console.error('Failed to seed default custom personalities/skills:', e);
    }

    // Create query optimization indexes
    await dbConnection.run('CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id, created_at)');
    await dbConnection.run('CREATE INDEX IF NOT EXISTS idx_memories_user_expires ON memories(user_id, expires_at)');
    await dbConnection.run('CREATE INDEX IF NOT EXISTS idx_token_usage_user_created ON token_usage(user_id, created_at)');
    await dbConnection.run('CREATE INDEX IF NOT EXISTS idx_shown_articles_user ON shown_articles(user_id, seen_at)');

    logger.info('Database initialized successfully.');
  } catch (error) {
    logger.error(`Error initializing database: ${error.message}`);
    if (dbConnection) {
      try {
        await dbConnection.close();
      } catch (closeErr) {}
      dbConnection = null;
    }
    throw error;
  }

  return dbConnection;
}

async function closeDb() {
  if (dbConnection) {
    try {
      await dbConnection.close();
    } catch (err) {}
    dbConnection = null;
  }
}

module.exports = { getDb, closeDb };
