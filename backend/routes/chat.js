const express = require('express');
const router = express.Router();
const fs = require('fs');
const { getDb } = require('../db');
const { generateGreetingAndSave } = require('../ai');
const { authenticateToken } = require('../middleware/auth');
const { checkQuota } = require('../middleware/quotaMiddleware');
const { getEmbedding } = require('../utils/embeddings');
const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

let idleUnloadTimer = null;

// How long the system must sit idle before loaded models are freed. Two minutes was aggressive
// enough that normal conversational pauses unloaded the model, and the next message then paid
// for a cold reload mid-request - which is what produced "Local LLM returned an empty response
// after retrying" on an otherwise healthy setup. Fifteen minutes still reclaims VRAM when you
// walk away without punishing you for thinking for a minute.
const IDLE_UNLOAD_MS = Number(process.env.IDLE_UNLOAD_MS) || 15 * 60 * 1000;

function resetIdleUnloadTimer() {
  if (idleUnloadTimer) {
    clearTimeout(idleUnloadTimer);
    idleUnloadTimer = null;
  }
}

function startIdleUnloadTimer() {
  resetIdleUnloadTimer();
  idleUnloadTimer = setTimeout(async () => {
    try {
      const aiQueue = require('../services/ai_queue');
      // If there is active agent operations, postpone
      if ((global.activeAgentOps && global.activeAgentOps > 0) || aiQueue.isProcessing) {
        logger.info('[Idle Model Unloader] Agent processing is active. Postponing unload.');
        startIdleUnloadTimer(); // reschedule
        return;
      }

      logger.info(`[Idle Model Unloader] System idle for ${Math.round(IDLE_UNLOAD_MS / 60000)} minutes. Unloading all loaded models...`);
      const { getDb } = require('../db');
      const db = await getDb();
      const userSettings = await db.get('SELECT * FROM user_settings WHERE user_id = 1');
      if (!userSettings || userSettings.provider !== 'local') return;

      const { decrypt } = require('../utils/crypto');
      const decryptedLocalKey = decrypt(userSettings.local_key);
      const localBaseUrl = userSettings.local_url || 'http://192.168.1.42:1234/v1';
      const localApiKey = decryptedLocalKey || '';

      const { listLocalModels, unloadLocalModel } = require('../utils/lmstudio');
      const availableModels = await listLocalModels(localBaseUrl, localApiKey);
      let unloadedAny = false;
      for (const m of availableModels) {
        if (m.isLoaded && m.instanceId) {
          logger.info(`[Idle Model Unloader] Unloading model instance: ${m.instanceId} (${m.id})`);
          try {
            await unloadLocalModel(localBaseUrl, localApiKey, m.instanceId);
            unloadedAny = true;
          } catch (unloadErr) {
            // A 404 here means the model was already unloaded (e.g. by LM Studio's own
            // idle timeout) between listing and unloading - not a real failure.
            if (unloadErr.message && unloadErr.message.includes('404')) {
              logger.info(`[Idle Model Unloader] Model instance ${m.instanceId} was already unloaded.`);
            } else {
              logger.error(`[Idle Model Unloader] Failed to unload model instance ${m.instanceId}:`, unloadErr);
            }
          }
        }
      }
      if (unloadedAny) {
        const { broadcastAlert } = require('./alerts');
        broadcastAlert({ type: 'streaming_status', isStreaming: false });
        broadcastAlert({ type: 'agent_status', agent: null, status: 'idle' });
      }
    } catch (err) {
      logger.error('[Idle Model Unloader] Error during idle unload:', err);
    }
  }, IDLE_UNLOAD_MS);
}

const streamLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // Limit each IP to 10 streaming completions per minute
  message: { error: 'Too many stream requests from this IP, please try again after a minute.' },
  standardHeaders: true,
  legacyHeaders: false
});

router.get('/chats', authenticateToken, async (req, res) => {
  try {
    const db = await getDb();
    const chats = await db.all('SELECT * FROM chats WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
    res.json(chats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/chats', authenticateToken, async (req, res) => {
  const { title } = req.body;
  try {
    const db = await getDb();
    const result = await db.run('INSERT INTO chats (user_id, title) VALUES (?, ?)', [req.user.id, title || 'New Chat']);
    const chatId = result.lastID;
    
    await generateGreetingAndSave(db, req.user.id, chatId);
    
    res.json({ success: true, chatId, id: chatId, title: title || 'New Chat' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/chats/:id', authenticateToken, async (req, res) => {
  try {
    const db = await getDb();
    await db.run('DELETE FROM chats WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/chats/:id', authenticateToken, async (req, res) => {
  const { title } = req.body;
  if (!title || title.trim() === '') return res.status(400).json({ error: 'Title is required.' });
  try {
    const db = await getDb();
    await db.run('UPDATE chats SET title = ? WHERE id = ? AND user_id = ?', [title.trim(), req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/chats/:id/messages', authenticateToken, async (req, res) => {
  try {
    const db = await getDb();
    // Validate chat ownership
    const chat = await db.get('SELECT id FROM chats WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!chat) return res.status(404).json({ error: 'Chat not found.' });

    const messages = await db.all('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC', [req.params.id]);

    if (messages.length > 0) {
      const messageIds = messages.map(m => m.id);
      const placeholders = messageIds.map(() => '?').join(',');
      const attachments = await db.all(
        `SELECT id, message_id, kind, original_filename, mime_type FROM message_attachments WHERE message_id IN (${placeholders})`,
        messageIds
      );
      const attachmentsByMessage = new Map();
      for (const att of attachments) {
        if (!attachmentsByMessage.has(att.message_id)) attachmentsByMessage.set(att.message_id, []);
        attachmentsByMessage.get(att.message_id).push({
          id: att.id,
          kind: att.kind,
          filename: att.original_filename,
          mimeType: att.mime_type
        });
      }
      for (const msg of messages) {
        msg.attachments = attachmentsByMessage.get(msg.id) || [];
      }
    }

    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lets the frontend grey out the send button proactively when this is a PATTI client and
// the host is currently busy. Always resolves (never rejects) so a flaky/unreachable host
// just means the button doesn't grey out in advance - the actual request will still get a
// clear HOST_BUSY rejection through the normal /chat/stream path either way. No-op on a
// host/node install (always reports not busy) so the frontend can poll this unconditionally.
router.get('/chat/llm-status', authenticateToken, async (req, res) => {
  if (process.env.PATTI_ROLE !== 'client') {
    return res.json({ busy: false, busyBy: null });
  }
  try {
    const endpoint = `${(process.env.HOST_BRIDGE_URL || '').replace(/\/$/, '')}/api/bridge/llm-status`;
    const hostRes = await fetch(endpoint, {
      headers: { 'Authorization': `Bearer ${process.env.HOST_BRIDGE_SECRET}` }
    });
    if (!hostRes.ok) return res.json({ busy: false, busyBy: null });
    const data = await hostRes.json();
    res.json(data);
  } catch (err) {
    res.json({ busy: false, busyBy: null });
  }
});

// Agent SSE Stream endpoint
router.post('/chat/stream', authenticateToken, streamLimiter, checkQuota, async (req, res) => {
  resetIdleUnloadTimer();
  if (global.activeTab && global.activeTab !== 'chat') {
    return res.status(403).json({ error: 'Chat is disabled while on another tab.' });
  }

  const { chatId, message, attachmentIds } = req.body;
  if (!chatId || !message) return res.status(400).json({ error: 'chatId and message are required.' });

  const db = await getDb();

  // Validate chat ownership
  const chat = await db.get('SELECT id FROM chats WHERE id = ? AND user_id = ?', [chatId, req.user.id]);
  if (!chat) return res.status(404).json({ error: 'Chat not found.' });

  // Resolve any pending attachments (images/documents) attached to this turn
  let images = [];
  let pendingAttachments = [];
  let finalMessage = message;
  if (Array.isArray(attachmentIds) && attachmentIds.length > 0) {
    const placeholders = attachmentIds.map(() => '?').join(',');
    pendingAttachments = await db.all(
      `SELECT * FROM message_attachments WHERE id IN (${placeholders}) AND chat_id = ? AND user_id = ? AND message_id IS NULL`,
      [...attachmentIds, chatId, req.user.id]
    );

    for (const att of pendingAttachments) {
      if (att.kind === 'image') {
        try {
          const buffer = fs.readFileSync(att.stored_path);
          images.push(`data:${att.mime_type};base64,${buffer.toString('base64')}`);
        } catch (fileErr) {
          logger.error(`Failed to read image attachment ${att.id}:`, fileErr);
        }
      } else if (att.kind === 'document' && att.extracted_text) {
        finalMessage += `\n\n[Attached document: ${att.original_filename}]\n${att.extracted_text}`;
      }
    }
  }

  // Get user settings
  let settings = await db.get('SELECT * FROM user_settings WHERE user_id = ?', [req.user.id]);
  if (!settings) {
    settings = { provider: 'local', model_name: 'google/gemma-4-e4b' };
  }

  // Get chat history
  const dbHistory = await db.all(
    'SELECT role, content FROM messages WHERE chat_id = ? ORDER BY created_at ASC LIMIT 20',
    [chatId]
  );

  // Format for AI client loop: filter out empty messages and merge consecutive roles
  const history = [];
  for (const msg of dbHistory) {
    const content = msg.content ? msg.content.trim() : '';
    if (!content) continue;

    if (history.length > 0 && history[history.length - 1].role === msg.role) {
      history[history.length - 1].content += "\n" + content;
    } else {
      history.push({ role: msg.role, content });
    }
  }

  let completed = false;

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const streamAbortController = new AbortController();
  req.on('close', async () => {
    streamAbortController.abort();
    clearInterval(heartbeat);

    // Broadcast end of streaming status to Standalone Monitor
    try {
      const { broadcastAlert } = require('./alerts');
      broadcastAlert({ type: 'streaming_status', isStreaming: false });
      broadcastAlert({ type: 'agent_status', agent: null, status: 'idle' });
    } catch (e) {}

    if (!completed) {
      completed = true;
      try {
        let finalContent = accumulatedContent.trim();
        if (finalContent) {
          finalContent += " \n\nInteraction stopped by user.";
        } else {
          finalContent = "Interaction stopped by user.";
        }

        const { extractThoughts } = require('../utils/helpers');
        const parsed = extractThoughts(finalContent, accumulatedThoughts);
        finalContent = parsed.content;
        finalThoughts = parsed.thoughts;

        await db.run(
          'INSERT INTO messages (chat_id, role, content, thoughts) VALUES (?, ?, ?, ?)',
          [chatId, 'assistant', finalContent, finalThoughts]
        );
      } catch (dbErr) {
        console.error('Failed to save aborted assistant message:', dbErr);
      }
    }

    // If provider is local, do not automatically eject model on abort (only swap if a different model is chosen)
    startIdleUnloadTimer();
  });

  let accumulatedThoughts = '';
  let accumulatedContent = '';

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Keep-alive heartbeat interval
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

    let finalContent = '';
    let finalThoughts = '';

    try {
      // Process user feedback on previous turn (if any)
      try {
        const { handleUserFeedback } = require('../services/feedback_learning');
        await handleUserFeedback(db, req.user.id, chatId, message);
      } catch (fbErr) {
        console.error('Feedback learning handler failed:', fbErr);
      }

      // Save user message to database
      const userMsgResult = await db.run(
        'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)',
        [chatId, 'user', finalMessage]
      );

      if (pendingAttachments.length > 0) {
        const attPlaceholders = pendingAttachments.map(() => '?').join(',');
        await db.run(
          `UPDATE message_attachments SET message_id = ? WHERE id IN (${attPlaceholders})`,
          [userMsgResult.lastID, ...pendingAttachments.map(a => a.id)]
        );
      }

      let interruptedMessage = null;

      if (process.env.PATTI_ROLE === 'client') {
        // This device has no LLM of its own - relay the generation through the host,
        // which arbitrates access via its own ai_queue (host always wins - see
        // ai_queue.js). Chat history/settings/DB stay entirely local to this device;
        // the host only lends the LLM for this one turn.
        const { relayChatStreamFromHost } = require('../services/bridge_chat_relay');
        await relayChatStreamFromHost({
          hostBridgeUrl: process.env.HOST_BRIDGE_URL,
          hostBridgeSecret: process.env.HOST_BRIDGE_SECRET,
          message: finalMessage,
          images,
          history,
          onThought: (thoughtChunk) => {
            accumulatedThoughts += thoughtChunk;
            sendEvent('thought', thoughtChunk);
          },
          onContent: (contentChunk) => {
            accumulatedContent += contentChunk;
            sendEvent('content', contentChunk);
          },
          onToolCall: (toolCall) => sendEvent('tool', toolCall),
          onAgentStatus: (statusData) => sendEvent('agent_status', statusData),
          onModelUsed: (model) => sendEvent('model_used', { model }),
          onCommandApprovalRequired: ({ commandId, command, safety_analysis }) => {
            sendEvent('command_approval_required', { commandId, command, safety_analysis });
          },
          onInterrupted: (message) => {
            interruptedMessage = message;
            sendEvent('interrupted', { message });
          },
          abortController: streamAbortController
        });
      } else {
        const { runChatStream } = require('../services/chat_stream_handler');
        await runChatStream({
          db,
          userId: req.user.id,
          chatId,
          message: finalMessage,
          images,
          history,
          settings,
          onThought: (thoughtChunk) => {
            accumulatedThoughts += thoughtChunk;
            sendEvent('thought', thoughtChunk);
          },
          onSystemNotice: (text) => sendEvent('thought', text),
          onContent: (contentChunk) => {
            accumulatedContent += contentChunk;
            sendEvent('content', contentChunk);
          },
          onToolCall: (toolCall) => sendEvent('tool', toolCall),
          onAgentStatus: (statusData) => sendEvent('agent_status', statusData),
          onModelUsed: (model) => sendEvent('model_used', { model }),
          onCommandApprovalRequired: ({ commandId, command, safety_analysis }) => {
            sendEvent('command_approval_required', { commandId, command, safety_analysis });
          },
          abortController: streamAbortController,
          origin: 'host',
          nodeId: 'chat-ui',
          taskName: 'User Chat Request'
        });
      }

      if (interruptedMessage && !accumulatedContent.trim()) {
        accumulatedContent = `⚠️ ${interruptedMessage}`;
      }

      // Save assistant response to database
      const { extractThoughts } = require('../utils/helpers');
      const parsed = extractThoughts(accumulatedContent, accumulatedThoughts);
      finalContent = parsed.content;
      finalThoughts = parsed.thoughts;

      await db.run(
        'INSERT INTO messages (chat_id, role, content, thoughts) VALUES (?, ?, ?, ?)',
        [chatId, 'assistant', finalContent, finalThoughts]
      );

      completed = true;

    const userSettings = await db.get('SELECT * FROM user_settings WHERE user_id = ?', [req.user.id]) || {};
    const chatMemContent = `User asked: "${finalMessage.trim()}"\nAssistant replied: "${finalContent.trim()}"`;
    const chatMemEmbedding = await getEmbedding(chatMemContent, userSettings);

    // Save Q&A to short-term memory vault for 24 hours
    const expires24h = new Date();
    expires24h.setDate(expires24h.getDate() + 1);
    await db.run(
      'INSERT INTO memories (user_id, content, level, expires_at, embedding) VALUES (?, ?, ?, ?, ?)',
      [
        req.user.id,
        chatMemContent,
        'short-term',
        expires24h.toISOString(),
        chatMemEmbedding ? JSON.stringify(chatMemEmbedding) : null
      ]
    );

    sendEvent('agent_status', { agent: null, status: 'idle' });
    sendEvent('done', { success: true });


    } catch (err) {
      logger.error('Stream processing error in chat route:', err);
      const errMsg = err.message || "Local LLM Connection Lost. The model may have run out of memory. Please lower context length.";
      if (!res.headersSent) {
        res.status(500).json({ error: errMsg });
      } else {
        sendEvent('error', { message: errMsg });
      }
  } finally {
    clearInterval(heartbeat);
    // Broadcast end of streaming status to Standalone Monitor
    try {
      const { broadcastAlert } = require('./alerts');
      broadcastAlert({ type: 'streaming_status', isStreaming: false });
      broadcastAlert({ type: 'agent_status', agent: null, status: 'idle' });
    } catch (e) {}
    res.end();
    startIdleUnloadTimer();
  }
});

router.post('/chat/approve-command', authenticateToken, (req, res) => {
  const { commandId, approved, command, password } = req.body;
  if (!commandId) return res.status(400).json({ error: 'commandId is required.' });
  
  const { resolveCommand } = require('../utils/commandApproval');
  const success = resolveCommand(commandId, approved, command, password);
  if (success) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Command not found or already resolved.' });
  }
});

module.exports = router;
