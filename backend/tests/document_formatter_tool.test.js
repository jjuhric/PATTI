const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { Document, Packer, Paragraph } = require('docx');
const PDFDocument = require('pdfkit');

jest.mock('pptxgenjs', () => {
  return jest.fn().mockImplementation(() => ({
    addSlide: () => ({ addText: () => {} }),
    write: async () => Buffer.from('fake-pptx-bytes')
  }));
});

// pdf-parse v2 uses pdfjs-dist internally, which relies on a dynamic import() Jest's CJS
// transform can't resolve without --experimental-vm-modules - confirmed working correctly
// under plain Node (see manual verification), same category of issue as the pptxgenjs mock
// above. This mock isolates document_formatter_tool.js's own extraction logic from that
// unrelated Jest/library environment incompatibility.
jest.mock('pdf-parse', () => ({
  PDFParse: jest.fn().mockImplementation(() => ({
    getText: async () => ({ text: 'Mocked PDF fixture text content.' }),
    destroy: async () => {}
  }))
}));

const { handleDocumentFormatterTool } = require('../tools/document_formatter_tool');

function llmResponse(markdown) {
  return { ok: true, json: async () => ({ choices: [{ message: { content: markdown } }] }) };
}

function fetchRouter({ llmMarkdown, imageBuffer }) {
  return jest.fn(async (url) => {
    if (typeof url === 'string' && (url.includes('commons.wikimedia.org') || url.includes('upload.wikimedia.org'))) {
      if (url.includes('list=search')) {
        return { ok: true, json: async () => ({ query: { search: [{ title: 'File:Test.jpg' }] } }) };
      }
      if (url.includes('prop=imageinfo')) {
        return {
          ok: true,
          json: async () => ({
            query: {
              pages: {
                1: {
                  imageinfo: [{
                    url: 'https://upload.wikimedia.org/test.jpg',
                    descriptionurl: 'https://commons.wikimedia.org/wiki/File:Test.jpg',
                    extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, Artist: { value: 'Jane Doe' } }
                  }]
                }
              }
            }
          })
        };
      }
      // Raw image binary download
      const buf = imageBuffer || Buffer.from('fake-image-bytes');
      return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    }
    // LLM chat completion call
    return llmResponse(llmMarkdown);
  });
}

async function buildFixtureDocx(filepath) {
  const doc = new Document({
    sections: [{ children: [new Paragraph('Fixture heading'), new Paragraph('Some body text about testing.')] }]
  });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(filepath, buffer);
}

function buildFixturePdf(filepath) {
  return new Promise((resolve) => {
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);
    doc.text('Fixture PDF content for extraction testing.');
    doc.end();
    stream.on('finish', resolve);
  });
}

describe('handleDocumentFormatterTool', () => {
  let db;
  let userId;
  let chatA;
  let chatB;
  let fixtureDir;
  const generatedDir = path.join(process.cwd(), 'generated_documents');

  beforeAll(async () => {
    db = await open({ filename: ':memory:', driver: sqlite3.Database });
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await db.exec(schemaSql);

    const userRes = await db.run("INSERT INTO users (username, password_hash) VALUES ('formatteruser', 'hashed')");
    userId = userRes.lastID;
    await db.run(
      `INSERT INTO user_settings (user_id, provider, model_name, local_url, local_api_style) VALUES (?, 'local', 'test-model', 'http://localhost:1234/v1', 'openai')`,
      [userId]
    );

    const chatARes = await db.run('INSERT INTO chats (user_id, title) VALUES (?, ?)', [userId, 'Chat A']);
    chatA = chatARes.lastID;
    const chatBRes = await db.run('INSERT INTO chats (user_id, title) VALUES (?, ?)', [userId, 'Chat B']);
    chatB = chatBRes.lastID;

    fixtureDir = path.join(process.cwd(), 'test_fixtures_formatter');
    fs.mkdirSync(fixtureDir, { recursive: true });
  });

  afterAll(async () => {
    await db.close();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    if (fs.existsSync(generatedDir)) fs.rmSync(generatedDir, { recursive: true, force: true });
  });

  afterEach(() => {
    delete global.fetch;
  });

  async function insertAttachment({ chatId, filename, content, mimeType }) {
    const storedPath = path.join(fixtureDir, `${Date.now()}_${filename}`);
    fs.writeFileSync(storedPath, content);
    const result = await db.run(
      `INSERT INTO message_attachments (chat_id, user_id, kind, original_filename, stored_path, mime_type)
       VALUES (?, ?, 'document', ?, ?, ?)`,
      [chatId, userId, filename, storedPath, mimeType]
    );
    return { id: result.lastID, storedPath };
  }

  test('returns an error string when the db is unavailable', async () => {
    const output = await handleDocumentFormatterTool(null, userId, 'format_document', {});
    expect(output).toMatch(/^Error:/);
  });

  test('returns an error for an unknown action', async () => {
    const output = await handleDocumentFormatterTool(db, userId, 'bogus_action', {});
    expect(output).toMatch(/^Error: Unknown Document Formatter action/);
  });

  test('reports a clear error when no document has been uploaded at all', async () => {
    const freshUser = await db.run("INSERT INTO users (username, password_hash) VALUES ('nodocsuser', 'hashed')");
    const output = await handleDocumentFormatterTool(db, freshUser.lastID, 'format_document', {});
    expect(output).toMatch(/No uploaded document found/);
  });

  test('reformats a plain text attachment resolved via explicit attachmentId and never touches the original file', async () => {
    const { id, storedPath } = await insertAttachment({
      chatId: chatA,
      filename: 'notes.txt',
      content: 'Some raw notes.\n```\ncode without a language\n```',
      mimeType: 'text/plain'
    });
    const originalBytes = fs.readFileSync(storedPath);
    const originalMtime = fs.statSync(storedPath).mtimeMs;

    global.fetch = fetchRouter({ llmMarkdown: '## Notes\n\nCleaned up content.\n\n```text\ncode without a language\n```' });

    const output = await handleDocumentFormatterTool(db, userId, 'format_document', { attachmentId: id });

    expect(output).toContain('Reformatted "notes.txt"');
    expect(output).toContain('.md');
    expect(fs.readFileSync(storedPath).equals(originalBytes)).toBe(true);
    expect(fs.statSync(storedPath).mtimeMs).toBe(originalMtime);

    const row = await db.get('SELECT * FROM generated_documents WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);
    expect(row.filename).toContain('notes_formatted');
    expect(fs.existsSync(row.filepath)).toBe(true);
    expect(fs.readFileSync(row.filepath, 'utf8')).toContain('Cleaned up content.');
  });

  test('resolves to the most recent document in the CURRENT chat when no attachmentId is given, ignoring a newer upload in a different chat', async () => {
    await insertAttachment({ chatId: chatA, filename: 'chatA-doc.txt', content: 'Chat A content.', mimeType: 'text/plain' });
    // Uploaded to chat B AFTER the chat A one, so a naive "most recent for this user" query would pick this instead.
    await insertAttachment({ chatId: chatB, filename: 'chatB-doc.txt', content: 'Chat B content.', mimeType: 'text/plain' });

    global.fetch = fetchRouter({ llmMarkdown: '# Reformatted\n\nDone.' });

    const output = await handleDocumentFormatterTool(db, userId, 'format_document', {}, chatA);
    expect(output).toContain('Reformatted "chatA-doc.txt"');
  });

  test('falls back to the most recent document for the user when no chatId is available', async () => {
    await insertAttachment({ chatId: chatB, filename: 'latest-overall.txt', content: 'Latest content overall.', mimeType: 'text/plain' });

    global.fetch = fetchRouter({ llmMarkdown: '# Reformatted\n\nDone.' });

    const output = await handleDocumentFormatterTool(db, userId, 'format_document', {});
    expect(output).toContain('Reformatted "latest-overall.txt"');
  });

  test('returns an error for an explicit attachmentId that does not exist', async () => {
    const output = await handleDocumentFormatterTool(db, userId, 'format_document', { attachmentId: 999999 });
    expect(output).toMatch(/^Error: No document found with attachment ID/);
  });

  test('extracts and reformats a real DOCX attachment via mammoth + turndown', async () => {
    const storedPath = path.join(fixtureDir, `${Date.now()}_fixture.docx`);
    await buildFixtureDocx(storedPath);
    const result = await db.run(
      `INSERT INTO message_attachments (chat_id, user_id, kind, original_filename, stored_path, mime_type)
       VALUES (?, ?, 'document', 'report.docx', ?, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')`,
      [chatA, userId, storedPath]
    );

    global.fetch = fetchRouter({ llmMarkdown: '# Report\n\nReformatted DOCX content.' });

    const output = await handleDocumentFormatterTool(db, userId, 'format_document', { attachmentId: result.lastID });
    expect(output).toContain('Reformatted "report.docx"');

    const row = await db.get('SELECT * FROM generated_documents WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);
    expect(row.doc_type).toBe('docx');
    expect(fs.existsSync(row.filepath)).toBe(true);
  });

  test('extracts and reformats a real PDF attachment via pdf-parse', async () => {
    const storedPath = path.join(fixtureDir, `${Date.now()}_fixture.pdf`);
    await buildFixturePdf(storedPath);
    const result = await db.run(
      `INSERT INTO message_attachments (chat_id, user_id, kind, original_filename, stored_path, mime_type)
       VALUES (?, ?, 'document', 'scan.pdf', ?, 'application/pdf')`,
      [chatA, userId, storedPath]
    );

    global.fetch = fetchRouter({ llmMarkdown: '# Scan\n\nReformatted PDF content.' });

    const output = await handleDocumentFormatterTool(db, userId, 'format_document', { attachmentId: result.lastID });
    expect(output).toContain('Reformatted "scan.pdf"');

    const row = await db.get('SELECT * FROM generated_documents WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);
    expect(row.doc_type).toBe('pdf');
    expect(fs.existsSync(row.filepath)).toBe(true);
  });

  test('resolves an image placeholder into a real embedded image and never leaves the raw placeholder in the output', async () => {
    const { id } = await insertAttachment({
      chatId: chatA,
      filename: 'illustrated.txt',
      content: 'Some content that could use a picture.',
      mimeType: 'text/plain'
    });

    const pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    );
    global.fetch = fetchRouter({
      llmMarkdown: '# Illustrated\n\nHere is the content.\n\n![A relevant picture](SEARCH: relevant topic)\n\nMore text.',
      imageBuffer: pngBuffer
    });

    const output = await handleDocumentFormatterTool(db, userId, 'format_document', { attachmentId: id });
    expect(output).toContain('Reformatted "illustrated.txt"');

    const row = await db.get('SELECT * FROM generated_documents WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);
    const content = fs.readFileSync(row.filepath, 'utf8');
    expect(content).not.toContain('SEARCH:');
    expect(content).toContain('Jane Doe');
  });

  test('rejects a document that is too large for a single reformat pass without calling the LLM', async () => {
    const { id } = await insertAttachment({
      chatId: chatA,
      filename: 'huge.txt',
      content: 'x'.repeat(70000),
      mimeType: 'text/plain'
    });

    global.fetch = jest.fn(async () => { throw new Error('fetch should not have been called'); });

    const output = await handleDocumentFormatterTool(db, userId, 'format_document', { attachmentId: id });
    expect(output).toMatch(/too large/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
