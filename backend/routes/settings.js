const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authenticateToken } = require('../middleware/auth');

// Google's model catalog mixes real chat models in with image (Imagen,
// "nano-banana"), video (Veo), music (Lyria), TTS, embedding, and narrow
// agent-preview models (robotics, computer-use, deep-research) that all
// happen to expose generateContent too. Rather than blacklist each new
// non-chat family Google ships, only allow names that match the actual
// chat-model naming shape: gemini-<version>-(flash|pro)[-lite][-latest|-preview],
// or the version-less gemini-(flash|pro)[-lite]-latest aliases.
const USABLE_GEMINI_PATTERN = /^gemini-(\d+(\.\d+)?-(flash|pro)(-lite)?(-latest|-preview)?|(flash|pro)(-lite)?-latest)$/;

function isUsableGeminiModel(name) {
  if (!USABLE_GEMINI_PATTERN.test(name)) return false;
  if (name.startsWith('gemini-1.0')) return false; // deprecated generation
  return true;
}

// Anthropic's /v1/models endpoint is all text/chat models (no image, audio,
// or embedding families mixed in like Gemini/OpenAI have), so the only thing
// worth filtering out is the retired pre-Claude-3 legacy line.
function isUsableAnthropicModel(id) {
  return !/^claude-(1|2|instant)/.test(id);
}

// Anthropic doesn't share OpenAI's base URL, so give it its own default.
function defaultOnlineBaseUrl(provider) {
  return provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
}

// Provider-aware env var fallback: lets a user configure a key purely via
// environment variables (e.g. on first boot) without touching Settings UI.
function envKeyForProvider(provider) {
  if (provider === 'anthropic') return process.env.ANTHROPIC_API_KEY || '';
  if (provider === 'openai') return process.env.OPENAI_API_KEY || '';
  return process.env.GEMINI_API_KEY || '';
}

function resolveLlmModelsUrl(baseUrl, apiStyle = 'openai') {
  let url = (baseUrl || '').trim();
  if (!url) return '';
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `http://${url}`;
  }
  url = url.replace(/\/$/, '');

  if (apiStyle === 'lm-studio') {
    const cleanUrl = url.replace(/\/v1$/, '');
    return `${cleanUrl}/api/v1/models`;
  }

  return `${url}/models`;
}

router.get('/', authenticateToken, async (req, res) => {
  try {
    const db = await getDb();
    let settings = await db.get('SELECT * FROM user_settings WHERE user_id = ?', [req.user.id]);
    if (!settings) {
      await db.run('INSERT INTO user_settings (user_id) VALUES (?)', [req.user.id]);
      settings = await db.get('SELECT * FROM user_settings WHERE user_id = ?', [req.user.id]);
    }

    const { decrypt } = require('../utils/crypto');
    const maskKey = (key) => {
      if (!key) return '';
      const dec = decrypt(key);
      if (dec.length <= 8) return '••••••••';
      return dec.substring(0, 4) + '••••••••' + dec.substring(dec.length - 4);
    };

    const envOnlineKey = envKeyForProvider(settings.online_provider || 'gemini');
    const decOnlineKey = settings.online_key ? decrypt(settings.online_key) : envOnlineKey;
    const isSetupComplete = !!(
      (settings.local_url && settings.local_url.startsWith('http')) ||
      process.env.LOCAL_LLM_URL ||
      (decOnlineKey && decOnlineKey.length > 5)
    );

    const path = require('path');
    const defaultWorkingDir = path.resolve(path.join(__dirname, '../..'));
    const responseSettings = {
      ...settings,
      gemini_key: settings.gemini_key ? maskKey(settings.gemini_key) : (process.env.GEMINI_API_KEY ? maskKey(process.env.GEMINI_API_KEY) : ''),
      local_key: settings.local_key ? maskKey(settings.local_key) : (process.env.LOCAL_LLM_KEY ? maskKey(process.env.LOCAL_LLM_KEY) : ''),
      online_key: settings.online_key ? maskKey(settings.online_key) : (envOnlineKey ? maskKey(envOnlineKey) : ''),
      local_url: settings.local_url || process.env.LOCAL_LLM_URL || 'http://192.168.1.42:1234/v1',
      preferred_local_model: settings.preferred_local_model || process.env.PREFERRED_LOCAL_MODEL || 'google/gemma-4-e4b',
      preferred_online_model: settings.preferred_online_model || process.env.PREFERRED_ONLINE_MODEL || 'gemini-2.0-flash',
      supervisor_model: settings.supervisor_model || process.env.SUPERVISOR_MODEL || 'google/gemma-4-e4b',
      working_directory: settings.working_directory || process.env.WORKING_DIRECTORY || defaultWorkingDir,
      is_setup_complete: isSetupComplete
    };

    res.json(responseSettings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/', authenticateToken, async (req, res) => {
  const { provider, model_name, gemini_key, local_key, local_url, local_api_style, online_url, online_key, online_provider, preferred_local_model, preferred_online_model, supervisor_model, device_type, is_main_host, working_directory, google_home_enabled, google_home_ip, google_home_name } = req.body;
  try {
    const db = await getDb();
    const { encrypt, decrypt } = require('../utils/crypto');

    const existing = await db.get('SELECT * FROM user_settings WHERE user_id = ?', [req.user.id]) || {};
    const isMasked = (val) => val && val.includes('••');

    const finalGemini = isMasked(gemini_key) ? existing.gemini_key : (gemini_key ? encrypt(gemini_key) : null);
    const finalLocal = isMasked(local_key) ? existing.local_key : (local_key ? encrypt(local_key) : null);
    const finalOnline = isMasked(online_key) ? existing.online_key : (online_key ? encrypt(online_key) : null);

    const resolvedLocalKey = isMasked(local_key) ? decrypt(existing.local_key) : local_key;
    const resolvedUrl = local_url || 'http://192.168.1.42:1234/v1';
    const resolvedStyle = local_api_style || 'openai';

    const path = require('path');
    const defaultWorkingDir = path.resolve(path.join(__dirname, '../..'));
    const resolvedWorkingDir = working_directory || existing.working_directory || process.env.WORKING_DIRECTORY || defaultWorkingDir;

    let finalProvider = provider || 'local';
    let finalModelName = model_name || 'google/gemma-4-e4b';
    let finalPreferredLocal = preferred_local_model || 'google/gemma-4-e4b';
    let finalSupervisorModel = supervisor_model || 'google/gemma-4-e4b';

    await db.run(
      `INSERT INTO user_settings (
         user_id, provider, model_name, gemini_key, local_key,
         local_url, local_api_style, online_url, online_key, online_provider,
         preferred_local_model, preferred_online_model, supervisor_model, device_type, is_main_host, working_directory,
         google_home_enabled, google_home_ip, google_home_name
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         provider = excluded.provider,
         model_name = excluded.model_name,
         gemini_key = excluded.gemini_key,
         local_key = excluded.local_key,
         local_url = COALESCE(excluded.local_url, local_url),
         local_api_style = COALESCE(excluded.local_api_style, local_api_style),
         online_url = COALESCE(excluded.online_url, online_url),
         online_key = excluded.online_key,
         online_provider = COALESCE(excluded.online_provider, online_provider),
         preferred_local_model = COALESCE(excluded.preferred_local_model, preferred_local_model),
         preferred_online_model = COALESCE(excluded.preferred_online_model, preferred_online_model),
         supervisor_model = COALESCE(excluded.supervisor_model, supervisor_model),
         device_type = COALESCE(excluded.device_type, device_type),
         is_main_host = COALESCE(excluded.is_main_host, is_main_host),
         working_directory = COALESCE(excluded.working_directory, working_directory),
         google_home_enabled = excluded.google_home_enabled,
         google_home_ip = excluded.google_home_ip,
         google_home_name = excluded.google_home_name`,
      [
        req.user.id, finalProvider, finalModelName, finalGemini, finalLocal,
        resolvedUrl, resolvedStyle, online_url, finalOnline, online_provider || 'gemini',
        finalPreferredLocal, preferred_online_model || 'gemini-2.0-flash', finalSupervisorModel,
        device_type || 'windows', (is_main_host === 1 || is_main_host === '1' || is_main_host === true || is_main_host === 'true') ? 1 : 0, resolvedWorkingDir,
        (google_home_enabled === 1 || google_home_enabled === '1' || google_home_enabled === true || google_home_enabled === 'true') ? 1 : 0,
        google_home_ip || null, google_home_name || null
      ]
    );
    res.json({ success: true, message: 'Settings updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scan local network for Google Nest/Home speakers using node-dns-sd
router.get('/google-home/scan', authenticateToken, async (req, res) => {
  try {
    const mDnsSd = require('node-dns-sd');
    mDnsSd.discover({
      name: '_googlecast._tcp.local',
      timeout: 3
    }).then((device_list) => {
      const devices = device_list.map(device => {
        const cleanName = device.fqdn ? device.fqdn.replace('._googlecast._tcp.local', '') : 'Google Home';
        return {
          name: device.modelName ? `${device.modelName} (${cleanName})` : cleanName,
          ip: device.address
        };
      });
      res.json(devices);
    }).catch((err) => {
      res.status(500).json({ error: err.message || err });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/local-models', authenticateToken, async (req, res) => {
  try {
    const db = await getDb();
    const settings = await db.get('SELECT local_url, local_key, local_api_style FROM user_settings WHERE user_id = ?', [req.user.id]);
    const { decrypt } = require('../utils/crypto');

    const queryUrl = req.query.localUrl;
    const isMasked = (val) => val && val.includes('•');
    const queryKey = isMasked(req.query.localApiKey) ? undefined : req.query.localApiKey;
    const queryStyle = req.query.localApiStyle;

    const localUrl = queryUrl || settings?.local_url || process.env.LOCAL_LLM_URL || 'http://192.168.1.42:1234/v1';

    let localApiKey = '';
    if (queryKey !== undefined && queryKey !== null) {
      localApiKey = queryKey;
    } else {
      localApiKey = settings?.local_key ? decrypt(settings.local_key) : '';
    }
    localApiKey = localApiKey || process.env.LOCAL_LLM_KEY || '';

    const localApiStyle = queryStyle || settings?.local_api_style || 'openai';

    const authHeader = localApiKey && localApiKey !== 'lm-studio' ? { 'Authorization': `Bearer ${localApiKey}` } : {};

    const endpoint = resolveLlmModelsUrl(localUrl, localApiStyle);

    const response = await fetch(endpoint, {
      headers: { ...authHeader, 'Accept': 'application/json' }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.statusText}`);
    }

    const data = await response.json();
    const models = data.data ? data.data.map(m => m.id) : [];
    res.json(models);
  } catch (err) {
    console.error('Failed to fetch local models:', err.message);
    const fallbackModels = [
      process.env.PREFERRED_LOCAL_MODEL || 'google/gemma-4-e4b',
      'google/gemma-4-e4b'
    ];
    res.json([...new Set(fallbackModels)]);
  }
});

router.get('/online-models', authenticateToken, async (req, res) => {
  try {
    const db = await getDb();
    const settings = await db.get('SELECT online_url, online_key, online_provider FROM user_settings WHERE user_id = ?', [req.user.id]);
    const provider = settings?.online_provider || 'gemini';
    const url = settings?.online_url;

    const { decrypt } = require('../utils/crypto');
    const key = decrypt(settings?.online_key) || envKeyForProvider(provider);

    if (!key) {
      return res.json(getDefaultOnlineModels(provider));
    }

    if (provider === 'anthropic') {
      const response = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      });
      if (!response.ok) throw new Error(`Anthropic API error: ${response.statusText}`);
      const data = await response.json();
      const models = data.data
        ? data.data.map(m => m.id).filter(isUsableAnthropicModel)
        : [];
      return res.json(models.length > 0 ? models : getDefaultOnlineModels('anthropic'));
    } else if (provider === 'gemini') {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
      if (!response.ok) throw new Error(`Gemini API error: ${response.statusText}`);
      const data = await response.json();
      const models = data.models
        ? data.models
          .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
          .map(m => m.name.replace(/^models\//, ''))
          .filter(isUsableGeminiModel)
        : [];
      return res.json(models.length > 0 ? models : getDefaultOnlineModels('gemini'));
    } else if (provider === 'openai') {
      const endpoint = resolveLlmModelsUrl(url || defaultOnlineBaseUrl('openai'));
      const response = await fetch(endpoint, {
        headers: { 'Authorization': `Bearer ${key}` }
      });
      if (!response.ok) throw new Error(`OpenAI API error: ${response.statusText}`);
      const data = await response.json();
      const models = data.data ? data.data.map(m => m.id) : [];
      return res.json(models.length > 0 ? models : getDefaultOnlineModels('openai'));
    } else if (provider === 'custom' && url) {
      const endpoint = resolveLlmModelsUrl(url);
      const response = await fetch(endpoint, {
        headers: { 'Authorization': `Bearer ${key}` }
      });
      if (!response.ok) throw new Error(`Custom API error: ${response.statusText}`);
      const data = await response.json();
      const models = data.data ? data.data.map(m => m.id) : [];
      return res.json(models);
    } else {
      return res.json(getDefaultOnlineModels(provider));
    }
  } catch (err) {
    console.error('Failed to fetch online models:', err.message);
    const db = await getDb().catch(() => null);
    let provider = 'gemini';
    if (db) {
      const settings = await db.get('SELECT online_provider FROM user_settings WHERE user_id = ?', [req.user.id]);
      provider = settings?.online_provider || 'gemini';
    }
    res.json(getDefaultOnlineModels(provider));
  }
});

function getDefaultOnlineModels(provider) {
  if (provider === 'gemini') {
    return ['gemini-2.0-flash', 'gemini-1.5-pro'];
  } else if (provider === 'openai') {
    return ['gpt-4o', 'gpt-4o-mini', 'o1-mini'];
  } else if (provider === 'anthropic') {
    return ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'];
  }
  return [];
}

router.post('/test-connection', authenticateToken, async (req, res) => {
  const { provider, localUrl, localApiKey, onlineKey, onlineProvider, onlineUrl } = req.body;
  try {
    if (provider === 'local') {
      const url = localUrl || 'http://192.168.1.42:1234/v1';
      const fetchUrl = resolveLlmModelsUrl(url);
      const headers = {};
      if (localApiKey && !localApiKey.includes('••')) {
        headers['Authorization'] = `Bearer ${localApiKey}`;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      const testRes = await fetch(fetchUrl, { headers, signal: controller.signal });
      clearTimeout(timeoutId);

      if (testRes.ok) {
        return res.json({ success: true, message: 'Local connection successful' });
      } else {
        return res.status(400).json({ error: `Connection failed with status ${testRes.status}` });
      }
    } else {
      const activeProvider = onlineProvider || 'gemini';
      if (activeProvider === 'gemini') {
        const key = onlineKey;
        if (!key) return res.status(400).json({ error: 'API key is required' });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);

        const testRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (testRes.ok) {
          return res.json({ success: true, message: 'Gemini connection successful' });
        } else {
          return res.status(400).json({ error: `Gemini verification failed with status ${testRes.status}` });
        }
      } else if (activeProvider === 'anthropic') {
        const key = onlineKey;
        if (!key) return res.status(400).json({ error: 'API key is required' });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);

        const testRes = await fetch('https://api.anthropic.com/v1/models', {
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (testRes.ok) {
          return res.json({ success: true, message: 'Anthropic connection successful' });
        } else {
          return res.status(400).json({ error: `Anthropic verification failed with status ${testRes.status}` });
        }
      } else {
        const baseUrl = onlineUrl || defaultOnlineBaseUrl(activeProvider);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);

        const testRes = await fetch(resolveLlmModelsUrl(baseUrl), {
          headers: { 'Authorization': `Bearer ${onlineKey}` },
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (testRes.ok) {
          return res.json({ success: true, message: `${activeProvider} connection successful` });
        } else {
          return res.status(400).json({ error: `API verification failed with status ${testRes.status}` });
        }
      }
    }
  } catch (err) {
    res.status(500).json({ error: `Connection failed: ${err.message}` });
  }
});

module.exports = router;
