const fs = require('fs');
const path = require('path');
const { handleDocumentGeneratorTool } = require('./document_generator_tool');
const { resolveFromDirective } = require('./course_builder_tool');
const { buildSettingsForUser } = require('../utils/llm_text');
const { reformatMarkdown } = require('../utils/document_reformatter');
const logger = require('../utils/logger');

const MAX_INPUT_CHARS = 60000;
const DEFAULT_IMAGE_COUNT = 2;

/**
 * Handles the document_formatter tool: reads back an already-uploaded document (PDF/DOCX/
 * MD/TXT/LOG/other text), asks PATTI's own LLM to rewrite it as cleanly-structured Markdown
 * (proper headings, fenced code blocks, tables, optional illustrative images pulled from
 * Wikimedia Commons), and renders the result as a brand-new file via document_generator_tool -
 * the original upload is never modified or overwritten.
 *
 * @param {import('sqlite').Database} db SQLite DB instance
 * @param {number} userId The user's ID
 * @param {string} action 'format_document'
 * @param {object} params { attachmentId?: number, instructions?: string }
 * @param {number} [chatId] The chat this request came from, used to scope "the document I just
 *   uploaded" when no explicit attachmentId is given (the model never sees a real attachment
 *   ID today - chat.js concatenates extracted text directly into the prompt).
 * @returns {Promise<string>} Text result for the worker agent (directive success string, or "Error: ...")
 */
async function handleDocumentFormatterTool(db, userId, action, params = {}, chatId) {
  if (!db) {
    return 'Error: Database connection is not available.';
  }

  try {
    if (action !== 'format_document') {
      return `Error: Unknown Document Formatter action "${action}".`;
    }
    return await handleFormatDocument(db, userId, params, chatId);
  } catch (err) {
    logger.error('Document formatter tool error:', err);
    return `Error formatting document: ${err.message}`;
  }
}

async function handleFormatDocument(db, userId, params, chatId) {
  const attachment = await resolveAttachment(db, userId, params.attachmentId, chatId);
  if (!attachment) {
    return params.attachmentId
      ? `Error: No document found with attachment ID "${params.attachmentId}".`
      : 'Error: No uploaded document found to format. Please upload a document first.';
  }

  const rawContent = await extractContent(attachment.stored_path, attachment.original_filename);
  if (!rawContent || !rawContent.trim()) {
    return `Error: Could not extract any readable text from "${attachment.original_filename}".`;
  }
  if (rawContent.length > MAX_INPUT_CHARS) {
    return `Error: "${attachment.original_filename}" is too large (${rawContent.length.toLocaleString()} ` +
      'characters) for a single reformat pass in this version. Try a shorter document.';
  }

  const settings = await buildSettingsForUser(db, userId);
  const { markdown: finalMarkdown, cleanup } = await reformatMarkdown(settings, rawContent, {
    instructions: params.instructions,
    imageCount: DEFAULT_IMAGE_COUNT
  });

  try {
    const { filepath, downloadLine } = await renderFormattedDocument(db, userId, attachment.original_filename, finalMarkdown);

    return `Reformatted "${attachment.original_filename}" and saved it as a new file - your original ` +
      `upload was not modified.\n\n**File location on this machine:**\n\`${filepath}\`\n\n${downloadLine}`;
  } finally {
    cleanup();
  }
}

// Resolves which uploaded document to format. The model can't pass a real attachment ID today
// (chat.js concatenates extracted text straight into the prompt, never the numeric ID), so an
// explicit ID is only ever set when a caller/future UI supplies one directly - the common path
// is falling back to the most recent document upload, scoped to the current chat first (to
// avoid mixing up uploads across unrelated conversations) and to the user overall otherwise.
async function resolveAttachment(db, userId, attachmentId, chatId) {
  if (attachmentId) {
    return db.get(
      "SELECT * FROM message_attachments WHERE id = ? AND user_id = ? AND kind = 'document'",
      [attachmentId, userId]
    );
  }
  if (chatId) {
    const row = await db.get(
      "SELECT * FROM message_attachments WHERE chat_id = ? AND user_id = ? AND kind = 'document' ORDER BY id DESC LIMIT 1",
      [chatId, userId]
    );
    if (row) return row;
  }
  return db.get(
    "SELECT * FROM message_attachments WHERE user_id = ? AND kind = 'document' ORDER BY id DESC LIMIT 1",
    [userId]
  );
}

// Re-extracts the document's content directly from disk rather than reusing
// message_attachments.extracted_text - that column is populated at upload time using
// extractRawText (DOCX) or plain pdf-parse text, both of which discard structure that this
// reformatting pass specifically needs to see (or at least infer from HTML) to do its job well.
async function extractContent(storedPath, originalFilename) {
  const ext = path.extname(originalFilename).toLowerCase();
  try {
    if (ext === '.docx') {
      const mammoth = require('mammoth');
      const TurndownService = require('turndown');
      const { value: html } = await mammoth.convertToHtml({ path: storedPath });
      return new TurndownService().turndown(html);
    }
    if (ext === '.pdf') {
      // pdf-parse v2 replaced the old default-function-export API with a PDFParse class.
      const { PDFParse } = require('pdf-parse');
      const buffer = fs.readFileSync(storedPath);
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        return result.text;
      } finally {
        await parser.destroy();
      }
    }
    return fs.readFileSync(storedPath, 'utf8');
  } catch (err) {
    throw new Error(`Could not read "${originalFilename}": ${err.message}`);
  }
}

async function renderFormattedDocument(db, userId, originalFilename, markdown) {
  const ext = path.extname(originalFilename).toLowerCase();
  const baseName = path.basename(originalFilename, path.extname(originalFilename))
    .replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'document';
  const outputBaseName = `${baseName}_formatted`;

  if (ext === '.pdf' || ext === '.docx') {
    const generatorAction = ext === '.pdf' ? 'generate_pdf' : 'generate_docx';
    const resultText = await handleDocumentGeneratorTool(db, userId, generatorAction, {
      filename: outputBaseName,
      title: baseName,
      content: markdown,
      // This content has already been through reformatMarkdown() above - skip the
      // auto-polish pass document_generator_tool.js applies to everyone else's content,
      // to avoid a wasteful/redundant second LLM rewrite of already-polished output.
      skipAutoPolish: true
    });
    return resolveFromDirective(db, resultText);
  }

  // MD/TXT/LOG/other text sources have no native rich-formatting story of their own, so the
  // cleaned-up result is saved as plain Markdown - same convention course_builder_tool.js uses.
  const userDir = path.join(process.cwd(), 'generated_documents', String(userId));
  fs.mkdirSync(userDir, { recursive: true });
  const finalName = `${outputBaseName}.md`;
  const filepath = path.join(userDir, `${Date.now()}_${finalName}`);
  fs.writeFileSync(filepath, markdown, 'utf8');
  await db.run(
    'INSERT INTO generated_documents (user_id, filename, filepath, doc_type, file_size) VALUES (?, ?, ?, ?, ?)',
    [userId, finalName, filepath, 'md', Buffer.byteLength(markdown, 'utf8')]
  );
  return { filepath, downloadLine: "It's a plain Markdown file - open it in any text editor." };
}

module.exports = { handleDocumentFormatterTool };
