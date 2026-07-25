const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { getDb } = require('../db');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB
});

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function sanitizeFilename(name) {
  return (name || 'file').replace(/[^a-zA-Z0-9_.\-]/g, '_');
}

function containsBinaryData(buffer) {
  const sampleLength = Math.min(buffer.length, 8000);
  for (let i = 0; i < sampleLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

// Formats that are unambiguously not something PATTI can read as a document, regardless
// of what their raw bytes happen to look like (e.g. a tiny/empty test archive with no
// binary-looking content) - checked before falling back to content-sniffing below.
function isKnownUnsupportedMimetype(mimetype) {
  if (mimetype.startsWith('video/') || mimetype.startsWith('audio/')) return true;
  const blocked = [
    'application/zip', 'application/x-zip-compressed', 'application/x-rar-compressed',
    'application/x-7z-compressed', 'application/x-tar', 'application/gzip',
    'application/x-msdownload', 'application/x-executable', 'application/vnd.microsoft.portable-executable'
  ];
  return blocked.includes(mimetype);
}

// Upload and process an image or document attachment for a chat message
router.post('/upload', authenticateToken, upload.single('file'), async (req, res) => {
  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId is required.' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  try {
    const db = await getDb();
    const chat = await db.get('SELECT id FROM chats WHERE id = ? AND user_id = ?', [chatId, req.user.id]);
    if (!chat) return res.status(404).json({ error: 'Chat not found.' });

    const { buffer, mimetype, originalname, size } = req.file;

    let kind = null;
    let extractedText = null;

    if (mimetype.startsWith('image/')) {
      kind = 'image';
    } else if (mimetype === 'application/pdf') {
      kind = 'document';
      try {
        // pdf-parse v2 replaced the old default-function-export API with a PDFParse class.
        const { PDFParse } = require('pdf-parse');
        const parser = new PDFParse({ data: buffer });
        try {
          const parsed = await parser.getText();
          extractedText = parsed.text;
        } finally {
          await parser.destroy();
        }
      } catch (parseErr) {
        logger.error('Failed to parse PDF attachment:', parseErr);
        return res.status(400).json({ error: 'Could not read this PDF file.' });
      }
    } else if (mimetype === DOCX_MIME) {
      kind = 'document';
      try {
        const mammoth = require('mammoth');
        const parsed = await mammoth.extractRawText({ buffer });
        extractedText = parsed.value;
      } catch (parseErr) {
        logger.error('Failed to parse DOCX attachment:', parseErr);
        return res.status(400).json({ error: 'Could not read this Word document.' });
      }
    } else if (mimetype === 'text/plain' || mimetype === 'text/markdown') {
      kind = 'document';
      extractedText = buffer.toString('utf8');
    } else if (isKnownUnsupportedMimetype(mimetype)) {
      return res.status(400).json({ error: `Unsupported file type: ${mimetype}` });
    } else if (!containsBinaryData(buffer)) {
      // Browsers report an inconsistent (or generic/blank) mimetype for many plain-text
      // formats - .log, .csv, .json, .yaml, etc. Rather than whitelist every extension,
      // fall back to treating anything that doesn't look like binary data as a text
      // document; a NUL byte in the first few KB is a reliable "this is binary" signal
      // that virtually no real text file ever produces.
      kind = 'document';
      extractedText = buffer.toString('utf8');
    } else {
      return res.status(400).json({ error: `Unsupported file type: ${mimetype}` });
    }

    const userDir = path.join(process.cwd(), 'chat_attachments', String(req.user.id));
    fs.mkdirSync(userDir, { recursive: true });
    const storedPath = path.join(userDir, `${Date.now()}_${sanitizeFilename(originalname)}`);
    fs.writeFileSync(storedPath, buffer);

    const result = await db.run(
      `INSERT INTO message_attachments (chat_id, user_id, kind, original_filename, stored_path, mime_type, extracted_text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [chatId, req.user.id, kind, originalname, storedPath, mimetype, extractedText]
    );

    res.json({
      id: result.lastID,
      kind,
      filename: originalname,
      mimeType: mimetype,
      size,
      extractedPreview: extractedText ? extractedText.slice(0, 300) : undefined
    });
  } catch (err) {
    logger.error('Attachment upload failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Serve the raw stored file (used for image thumbnails/previews)
router.get('/:id/file', authenticateToken, async (req, res) => {
  try {
    const db = await getDb();
    const attachment = await db.get(
      'SELECT stored_path, mime_type, original_filename FROM message_attachments WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!attachment || !fs.existsSync(attachment.stored_path)) {
      return res.status(404).json({ error: 'Attachment not found.' });
    }
    res.setHeader('Content-Type', attachment.mime_type);
    res.sendFile(path.resolve(attachment.stored_path));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a pending attachment before it's attached to a sent message
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const db = await getDb();
    const attachment = await db.get(
      'SELECT stored_path FROM message_attachments WHERE id = ? AND user_id = ? AND message_id IS NULL',
      [req.params.id, req.user.id]
    );
    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found or already sent.' });
    }

    try {
      if (fs.existsSync(attachment.stored_path)) {
        fs.unlinkSync(attachment.stored_path);
      }
    } catch (fsErr) {
      logger.warn(`Could not delete attachment file from disk: ${attachment.stored_path}`, fsErr.message);
    }

    await db.run('DELETE FROM message_attachments WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
