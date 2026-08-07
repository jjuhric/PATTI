const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const { authenticateToken, authenticateTokenOrCookie } = require('../middleware/auth');
const { getDb } = require('../db');
const os = require('os');
const path = require('path');
const fs = require('fs');

function getLatestLogFile() {
  const baseDir = path.join(os.homedir(), '.lmstudio', 'server-logs');
  if (!fs.existsSync(baseDir)) return null;
  try {
    const months = fs.readdirSync(baseDir)
      .filter(f => fs.statSync(path.join(baseDir, f)).isDirectory())
      .sort();
    if (months.length === 0) return null;
    const latestMonthDir = path.join(baseDir, months[months.length - 1]);
    const files = fs.readdirSync(latestMonthDir)
      .filter(f => f.endsWith('.log'))
      .map(f => ({
        name: f,
        path: path.join(latestMonthDir, f),
        mtime: fs.statSync(path.join(latestMonthDir, f)).mtime
      }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? files[0].path : null;
  } catch (err) {
    console.error('[LM Studio Logs] Error locating latest log file:', err);
    return null;
  }
}

function parseLogLine(line) {
  // Format 1: [2026-07-06 07:54:56][INFO][model-name] message
  // Format 2: [2026-07-06 07:54:56][DEBUG] message
  const mainRegex = /^\[([\d\-\s\:]+)\]\[([A-Z]+)\](?:\[([^\]]+)\])?\s+(.*)$/;
  const match = line.match(mainRegex);
  if (match) {
    const timestamp = match[1];
    const level = match[2].toLowerCase();
    const source = match[3] ? 'model' : 'server';
    const sourceDetail = match[3] || 'server';
    const message = match[4];
    return {
      timestamp,
      level,
      source,
      message: sourceDetail !== 'server' ? `[${sourceDetail}] ${message}` : message
    };
  }

  // Format 3: raw timing or slot output (e.g. 1.14.163.823 I slot launch_slot_: ...)
  const timingRegex = /^([\d\.]+)\s+([A-Z])\s+([^\s]+)\s+(.*)$/;
  const timingMatch = line.match(timingRegex);
  if (timingMatch) {
    const levelChar = timingMatch[2];
    const level = levelChar === 'E' ? 'error' : levelChar === 'W' ? 'warning' : 'info';
    const source = timingMatch[3];
    const message = timingMatch[4];
    return {
      level,
      source: 'server',
      message: `[${source}] ${message}`
    };
  }

  return null;
}

// SEC-5: EventSource can't attach a custom Authorization header - see authenticateTokenOrCookie.
router.get('/log-stream', authenticateTokenOrCookie, async (req, res) => {
  try {
    const db = await getDb();
    const settings = await db.get('SELECT is_main_host FROM user_settings WHERE user_id = ?', [req.user.id]);
    
    if (!settings || settings.is_main_host !== 1) {
      return res.status(403).json({ error: 'Only the main host is authorized to stream logs.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const latestLogFile = process.env.NODE_ENV === 'test' ? null : getLatestLogFile();
    if (latestLogFile) {
      console.log(`[LM Studio Logs] Tailing file: ${latestLogFile}`);
      
      // Read initial historical logs (last 50 lines)
      try {
        const fileContent = fs.readFileSync(latestLogFile, 'utf8');
        const lines = fileContent.split('\n').filter(l => l.trim());
        const tailLines = lines.slice(-50);
        for (const line of tailLines) {
          const parsed = parseLogLine(line);
          res.write(`data: ${JSON.stringify({ type: 'log', message: line, parsed })}\n\n`);
        }
      } catch (err) {
        console.error('[LM Studio Logs] Error reading initial logs:', err);
      }

      // Tail file changes
      let currentSize = fs.statSync(latestLogFile).size;
      let activeFile = latestLogFile;

      const checkInterval = setInterval(() => {
        try {
          const checkFile = getLatestLogFile();
          if (checkFile && checkFile !== activeFile) {
            console.log(`[LM Studio Logs] Log file rolled over to: ${checkFile}`);
            activeFile = checkFile;
            currentSize = 0;
          }

          const stats = fs.statSync(activeFile);
          if (stats.size > currentSize) {
            const stream = fs.createReadStream(activeFile, {
              start: currentSize,
              end: stats.size - 1,
              encoding: 'utf8'
            });

            let chunk = '';
            stream.on('data', (data) => {
              chunk += data;
            });

            stream.on('end', () => {
              const lines = chunk.split('\n');
              for (const line of lines) {
                if (line.trim()) {
                  const parsed = parseLogLine(line);
                  res.write(`data: ${JSON.stringify({ type: 'log', message: line, parsed })}\n\n`);
                }
              }
            });

            currentSize = stats.size;
          }
        } catch (err) {
          console.error('[LM Studio Logs] Error checking file stats:', err);
        }
      }, 500);

      req.on('close', () => {
        console.log('[LM Studio Logs] Client disconnected. Stopping file tail.');
        clearInterval(checkInterval);
      });

    } else {
      // Fallback: Spawn lms log stream CLI
      console.log('[LM Studio Logs] Fallback: Starting lms log stream process...');
      const child = spawn('lms', ['log', 'stream', '--json'], { shell: true });

      child.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            let parsed = null;
            try {
              parsed = JSON.parse(line);
            } catch (e) {}
            res.write(`data: ${JSON.stringify({ type: 'log', message: line.trim(), parsed })}\n\n`);
          }
        }
      });

      child.stderr.on('data', (data) => {
        res.write(`data: ${JSON.stringify({ type: 'stderr', message: data.toString().trim() })}\n\n`);
      });

      child.on('error', (err) => {
        console.error('[LM Studio Logs] Spawn error:', err);
        res.write(`data: ${JSON.stringify({ type: 'error', message: `Failed to spawn lms CLI: ${err.message}.` })}\n\n`);
      });

      child.on('close', (code) => {
        console.log(`[LM Studio Logs] lms process closed with code ${code}`);
        res.write(`data: ${JSON.stringify({ type: 'error', message: `LM Studio log stream disconnected` })}\n\n`);
        res.end();
      });

      req.on('close', () => {
        console.log('[LM Studio Logs] Client disconnected. Killing lms process.');
        child.kill('SIGINT');
      });
    }

  } catch (err) {
    console.error('[LM Studio Logs] Router error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

router.post('/clear-logs', authenticateToken, async (req, res) => {
  try {
    const db = await getDb();
    const settings = await db.get('SELECT is_main_host FROM user_settings WHERE user_id = ?', [req.user.id]);
    
    if (!settings || settings.is_main_host !== 1) {
      return res.status(403).json({ error: 'Only the main host is authorized to clear logs.' });
    }

    const latestLogFile = process.env.NODE_ENV === 'test' ? 'test.log' : getLatestLogFile();
    if (latestLogFile && (process.env.NODE_ENV === 'test' || fs.existsSync(latestLogFile))) {
      if (process.env.NODE_ENV !== 'test') {
        fs.writeFileSync(latestLogFile, '', 'utf8');
      }
      console.log(`[LM Studio Logs] Truncated log file: ${latestLogFile}`);
      return res.json({ success: true, message: 'Log file cleared successfully.' });
    } else {
      return res.status(404).json({ error: 'Active log file not found to clear.' });
    }
  } catch (err) {
    console.error('[LM Studio Logs] Error clearing logs:', err);
    res.status(500).json({ error: `Failed to clear logs: ${err.message}` });
  }
});

router.post('/eject-model', authenticateToken, async (req, res) => {
  try {
    const db = await getDb();
    const settings = await db.get('SELECT is_main_host FROM user_settings WHERE user_id = ?', [req.user.id]);
    
    if (!settings || settings.is_main_host !== 1) {
      return res.status(403).json({ error: 'Only the main host is authorized to eject models.' });
    }

    const { decrypt } = require('../utils/crypto');
    const userSettings = await db.get('SELECT * FROM user_settings WHERE user_id = ?', [req.user.id]);
    const decryptedLocalKey = decrypt(userSettings.local_key);
    const localBaseUrl = userSettings.local_url || 'http://192.168.1.42:1234/v1';
    const localApiKey = decryptedLocalKey || '';

    const { listLocalModels, unloadLocalModel } = require('../utils/lmstudio');
    const availableModels = await listLocalModels(localBaseUrl, localApiKey);
    const loadedModelObj = availableModels.find(m => m.isLoaded);
    
    if (loadedModelObj && loadedModelObj.instanceId) {
      console.log(`[Model Ejection] Ejecting active local model instance: ${loadedModelObj.instanceId}`);
      await unloadLocalModel(localBaseUrl, localApiKey, loadedModelObj.instanceId);
      return res.json({ success: true, message: `Model '${loadedModelObj.id}' ejected successfully.` });
    } else {
      return res.status(404).json({ error: 'No active loaded model found to eject.' });
    }
  } catch (err) {
    console.error('[LM Studio Logs] Error ejecting model:', err);
    res.status(500).json({ error: `Failed to eject model: ${err.message}` });
  }
});

module.exports = router;
