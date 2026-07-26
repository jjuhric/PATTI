CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  email TEXT,
  name TEXT,
  zipcode TEXT,
  country TEXT DEFAULT 'US',
  temp_unit TEXT DEFAULT 'imperial',
  weather_api_key TEXT,
  last_briefing_at DATETIME,
  briefing_hour INTEGER DEFAULT 7,
  dob TEXT,
  gender TEXT,
  political_leaning TEXT DEFAULT 'Undecided',
  interests TEXT DEFAULT '[]',
  favorite_teams TEXT DEFAULT '[]',
  timezone TEXT DEFAULT 'America/Chicago',
  is_admin INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  role TEXT NOT NULL, -- 'user', 'assistant' (or 'model' / 'thought')
  content TEXT NOT NULL,
  thoughts TEXT, -- reasoning/steps
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  start_time TEXT NOT NULL, -- ISO-8601 string e.g. YYYY-MM-DD HH:MM
  end_time TEXT NOT NULL, -- ISO-8601 string
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER PRIMARY KEY,
  provider TEXT DEFAULT 'local', -- 'local' or 'gemini' (or 'openai', 'anthropic')
  model_name TEXT DEFAULT 'google/gemma-4-e4b',
  gemini_key TEXT, -- legacy, replaced by online_key
  local_key TEXT,
  local_url TEXT DEFAULT 'http://192.168.1.42:1234/v1',
  local_api_style TEXT DEFAULT 'openai', -- 'openai', 'lm-studio', 'anthropic'
  online_url TEXT,
  online_key TEXT,
  online_provider TEXT DEFAULT 'gemini', -- 'gemini', 'openai', 'anthropic', 'custom'
  preferred_local_model TEXT,
  preferred_online_model TEXT,
  supervisor_model TEXT,
  device_type TEXT DEFAULT 'windows',
  is_main_host INTEGER DEFAULT 0,
  working_directory TEXT,
  token_quota INTEGER DEFAULT 1000000,
  google_home_enabled INTEGER DEFAULT 0,
  google_home_ip TEXT,
  google_home_name TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS network_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  node_name TEXT NOT NULL,
  device_type TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  port INTEGER DEFAULT 3000,
  bridge_secret TEXT,
  last_seen DATETIME,
  is_online INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  mqtt_topic TEXT,
  capabilities JSON DEFAULT '[]',
  os_type TEXT,
  arch TEXT,
  node_version TEXT,
  ssh_username TEXT,
  ssh_password TEXT,
  ssh_key TEXT,
  node_role TEXT DEFAULT 'node', -- 'node' (lightweight sensor/actuator device) or 'patti_client' (full PATTI instance sharing the host's LLM)
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
-- Only one network_nodes row may ever be the PATTI client (host is not stored in this table).
-- The unique index is created in db.js, after the node_role migration runs, so it works for
-- both fresh installs and existing databases upgrading in place.


CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  level TEXT NOT NULL, -- 'short-term' or 'long-term'
  expires_at DATETIME, -- NULL for long-term, timestamp for short-term
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  embedding TEXT,
  agent_name TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS vault_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  filepath TEXT UNIQUE NOT NULL,
  file_size INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS vault_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding TEXT,
  FOREIGN KEY (document_id) REFERENCES vault_documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS installed_tools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL,
  target_agent TEXT NOT NULL,
  manifest TEXT NOT NULL,            -- store serialized JSON manifest
  installed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  status TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS agent_capabilities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  description TEXT NOT NULL,
  parameters TEXT,                   -- store serialized JSON schema
  added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(agent_name, tool_name)
);

CREATE TABLE IF NOT EXISTS dev_pipeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT UNIQUE NOT NULL,
  original_prompt TEXT NOT NULL,
  target_node TEXT,
  target_agent TEXT,
  tool_name TEXT,
  status TEXT DEFAULT 'pending',
  dev_agent_output TEXT,
  qa_agent_output TEXT,
  branch_name TEXT,
  pr_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  model_name TEXT NOT NULL,
  provider_type TEXT NOT NULL, -- 'local' or 'online'
  token_count INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shown_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  article_link TEXT NOT NULL,
  title TEXT NOT NULL,
  seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, article_link)
);

CREATE TABLE IF NOT EXISTS coding_language_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  language TEXT NOT NULL, -- 'rust', 'cpp', 'python', 'javascript'
  update_summary TEXT NOT NULL,
  breaking_changes TEXT, -- JSON array of strings
  query_date DATETIME DEFAULT CURRENT_TIMESTAMP,
  source_urls TEXT
);

CREATE TABLE IF NOT EXISTS custom_personalities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  system_prompt TEXT NOT NULL,
  is_active INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS custom_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  instructions TEXT NOT NULL,
  is_active INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS generated_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  filepath TEXT UNIQUE NOT NULL,
  doc_type TEXT NOT NULL, -- 'pdf' | 'docx' | 'xlsx' | 'pptx'
  file_size INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  message_id INTEGER, -- NULL until the chat message is actually sent/inserted
  kind TEXT NOT NULL, -- 'image' | 'document'
  original_filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  extracted_text TEXT, -- populated for documents only
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deep_research_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  topic TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'research', -- 'research' | 'study_guide'
  status TEXT NOT NULL DEFAULT 'running', -- 'running' | 'completed' | 'failed'
  report_path TEXT,
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS course_generation_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  topic TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'docx',
  status TEXT NOT NULL DEFAULT 'running', -- 'running' | 'completed' | 'failed'
  lesson_count INTEGER,
  completed_lessons INTEGER DEFAULT 0,
  output_path TEXT,
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);


