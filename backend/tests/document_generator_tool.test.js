const fs = require('fs');
const path = require('path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { markdownToBlocks } = require('../utils/markdownToBlocks');

// pptxgenjs uses a dynamic import() internally for media-encoding node deps that
// Jest's CJS transform can't resolve without --experimental-vm-modules. Confirmed
// working correctly under plain Node (see manual verification) - this mock isolates
// our own tool logic (sanitization/DB insert/directive string) from that unrelated
// Jest/library environment incompatibility.
jest.mock('pptxgenjs', () => {
  return jest.fn().mockImplementation(() => ({
    addSlide: () => ({ addText: () => {} }),
    write: async () => Buffer.from('fake-pptx-bytes')
  }));
});

const { handleDocumentGeneratorTool } = require('../tools/document_generator_tool');

describe('markdownToBlocks', () => {
  test('parses headings, bullets, paragraphs, and inline links', () => {
    const blocks = markdownToBlocks(
      '# Title\n\nSome intro paragraph.\n\n- First point\n- Second point with a [link](https://example.com)\n\n## Section'
    );

    expect(blocks[0]).toEqual({ type: 'heading', level: 1, runs: [{ text: 'Title' }] });
    expect(blocks[1]).toEqual({ type: 'paragraph', runs: [{ text: 'Some intro paragraph.' }] });
    expect(blocks[2]).toEqual({ type: 'bullet', runs: [{ text: 'First point' }] });

    const linkedBullet = blocks[3];
    expect(linkedBullet.type).toBe('bullet');
    expect(linkedBullet.runs.some((r) => r.url === 'https://example.com' && r.text === 'link')).toBe(true);

    expect(blocks[4]).toEqual({ type: 'heading', level: 2, runs: [{ text: 'Section' }] });
  });

  test('returns an empty array for empty/whitespace-only input', () => {
    expect(markdownToBlocks('')).toEqual([]);
    expect(markdownToBlocks('   \n\n  ')).toEqual([]);
  });

  test('parses fenced code blocks as a distinct block, preserving internal lines verbatim', () => {
    const blocks = markdownToBlocks('## Example\n\n```cpp\nint x = 1;\nint y = 2;\n```\n\nAfter the code.');
    expect(blocks[0]).toEqual({ type: 'heading', level: 2, runs: [{ text: 'Example' }] });
    expect(blocks[1]).toEqual({ type: 'code', language: 'cpp', text: 'int x = 1;\nint y = 2;' });
    expect(blocks[2]).toEqual({ type: 'paragraph', runs: [{ text: 'After the code.' }] });
  });

  test('parses a pipe table into headers and rows', () => {
    const blocks = markdownToBlocks('| Type | Example |\n|---|---|\n| int | 1 |\n| float | 1.5 |');
    expect(blocks[0]).toEqual({
      type: 'table',
      headers: ['Type', 'Example'],
      rows: [['int', '1'], ['float', '1.5']]
    });
  });

  test('parses a standalone ![alt](path) line as an image block', () => {
    const blocks = markdownToBlocks('## Title\n\n![A cute cat](C:/temp/cat.png)\n\nAfter the image.');
    expect(blocks[1]).toEqual({ type: 'image', alt: 'A cute cat', src: 'C:/temp/cat.png' });
    expect(blocks[2]).toEqual({ type: 'paragraph', runs: [{ text: 'After the image.' }] });
  });

  test('parses inline **bold** and `code` spans into flagged runs', () => {
    const blocks = markdownToBlocks('This is **important** and this is `inline code`.');
    const runs = blocks[0].runs;
    expect(runs).toContainEqual({ text: 'important', bold: true });
    expect(runs).toContainEqual({ text: 'inline code', code: true });
  });

  test('folds heading levels deeper than 3 (####, #####) into level 3 instead of leaving them unrecognized', () => {
    const blocks = markdownToBlocks('#### Subsection\n\nBody text.');
    expect(blocks[0]).toEqual({ type: 'heading', level: 3, runs: [{ text: 'Subsection' }] });
  });

  test('detects a fenced code block even when the closing fence is not isolated on its own line', () => {
    // Real model output sometimes embeds a short fenced snippet mid-bullet rather than
    // putting the fence on its own line - a line-anchored fence regex misses this entirely.
    const blocks = markdownToBlocks("* Example: ```cpp\nchar grade = 'B';\n``` end of bullet");
    const codeBlock = blocks.find((b) => b.type === 'code');
    expect(codeBlock).toBeDefined();
    expect(codeBlock.text).toContain("char grade = 'B';");
  });
});

describe('handleDocumentGeneratorTool', () => {
  let db;
  let userId;
  const generatedDir = path.join(process.cwd(), 'generated_documents');

  beforeAll(async () => {
    db = await open({ filename: ':memory:', driver: sqlite3.Database });
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await db.exec(schemaSql);

    const result = await db.run("INSERT INTO users (username, password_hash) VALUES ('docgenuser', 'hashed')");
    userId = result.lastID;
  });

  afterAll(async () => {
    await db.close();
    if (fs.existsSync(generatedDir)) {
      fs.rmSync(generatedDir, { recursive: true, force: true });
    }
  });

  test('returns an error string when the db is unavailable', async () => {
    const output = await handleDocumentGeneratorTool(null, userId, 'generate_pdf', { filename: 'x.pdf', content: 'hi' });
    expect(output).toMatch(/^Error:/);
  });

  test('returns an error string when filename is missing', async () => {
    const output = await handleDocumentGeneratorTool(db, userId, 'generate_pdf', { content: 'hi' });
    expect(output).toMatch(/^Error: "filename"/);
  });

  test('returns an error string when content is missing for generate_pdf', async () => {
    const output = await handleDocumentGeneratorTool(db, userId, 'generate_pdf', { filename: 'plan.pdf' });
    expect(output).toMatch(/^Error: "content"/);
  });

  test('returns an error string for an unknown action', async () => {
    const output = await handleDocumentGeneratorTool(db, userId, 'generate_something', { filename: 'a.txt', content: 'hi' });
    expect(output).toMatch(/Unknown Document Generator action/);
  });

  test('generate_pdf writes a file, inserts a DB row, and returns a directive download link', async () => {
    const output = await handleDocumentGeneratorTool(db, userId, 'generate_pdf', {
      filename: '../../evil name?.pdf',
      title: 'AWS AI Practitioner Study Plan',
      content: '# Week 1\n\n- Learn the basics\n- Read the [AWS AI Practitioner guide](https://aws.amazon.com/certification/certified-ai-practitioner/)'
    });

    expect(output).toContain('Document generated successfully');
    expect(output).toMatch(/<a href="\/api\/documents\/\d+\/download\?token=[^"]+" target="_blank" rel="noopener noreferrer">/);

    const row = await db.get('SELECT * FROM generated_documents WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);
    expect(row).toBeDefined();
    expect(row.doc_type).toBe('pdf');
    // Path traversal characters and the '?' must be stripped from the stored filename
    expect(row.filename).not.toMatch(/[./\\?]{2,}|\.\./);
    expect(row.filename.endsWith('.pdf')).toBe(true);
    expect(fs.existsSync(row.filepath)).toBe(true);
    expect(row.file_size).toBeGreaterThan(0);
  });

  test('generate_pdf renders code blocks and tables without throwing', async () => {
    const output = await handleDocumentGeneratorTool(db, userId, 'generate_pdf', {
      filename: 'cpp-lesson.pdf',
      title: 'C++ Basics',
      content: '## Variables\n\n```cpp\nint x = 1;\n```\n\n| Type | Size |\n|---|---|\n| int | 4 bytes |'
    });

    expect(output).toContain('Document generated successfully');
    const row = await db.get('SELECT * FROM generated_documents WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);
    expect(fs.existsSync(row.filepath)).toBe(true);
    expect(row.file_size).toBeGreaterThan(0);
  });

  test('generate_docx renders code blocks and tables without throwing', async () => {
    const output = await handleDocumentGeneratorTool(db, userId, 'generate_docx', {
      filename: 'cpp-lesson.docx',
      title: 'C++ Basics',
      content: '## Variables\n\n```cpp\nint x = 1;\n```\n\n| Type | Size |\n|---|---|\n| int | 4 bytes |'
    });

    expect(output).toContain('Document generated successfully');
    const row = await db.get('SELECT * FROM generated_documents WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);
    expect(fs.existsSync(row.filepath)).toBe(true);
    expect(row.file_size).toBeGreaterThan(0);
  });

  describe('image blocks', () => {
    let imagePath;

    beforeAll(() => {
      const pngBuffer = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      );
      imagePath = path.join(process.cwd(), 'generated_documents', 'test-fixture.png');
      fs.mkdirSync(path.dirname(imagePath), { recursive: true });
      fs.writeFileSync(imagePath, pngBuffer);
    });

    afterAll(() => {
      if (fs.existsSync(imagePath)) fs.rmSync(imagePath);
    });

    test('generate_pdf renders a local image block without throwing', async () => {
      const output = await handleDocumentGeneratorTool(db, userId, 'generate_pdf', {
        filename: 'with-image.pdf',
        title: 'Illustrated',
        content: `## Section\n\nSome text.\n\n![A tiny test pixel](${imagePath})\n\nMore text after.`
      });

      expect(output).toContain('Document generated successfully');
      const row = await db.get('SELECT * FROM generated_documents WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);
      expect(fs.existsSync(row.filepath)).toBe(true);
      expect(row.file_size).toBeGreaterThan(0);
    });

    test('generate_docx renders a local image block without throwing', async () => {
      const output = await handleDocumentGeneratorTool(db, userId, 'generate_docx', {
        filename: 'with-image.docx',
        title: 'Illustrated',
        content: `## Section\n\nSome text.\n\n![A tiny test pixel](${imagePath})\n\nMore text after.`
      });

      expect(output).toContain('Document generated successfully');
      const row = await db.get('SELECT * FROM generated_documents WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);
      expect(fs.existsSync(row.filepath)).toBe(true);
      expect(row.file_size).toBeGreaterThan(0);
    });

    test('generate_pdf silently skips a missing image file rather than throwing', async () => {
      const output = await handleDocumentGeneratorTool(db, userId, 'generate_pdf', {
        filename: 'missing-image.pdf',
        title: 'Missing Image',
        content: `## Section\n\n![Does not exist](${path.join(process.cwd(), 'generated_documents', 'nope.png')})\n\nStill here.`
      });

      expect(output).toContain('Document generated successfully');
    });
  });

  describe('auto-polish on document creation', () => {
    let polishUserId;

    beforeAll(async () => {
      const result = await db.run("INSERT INTO users (username, password_hash) VALUES ('polishuser', 'hashed')");
      polishUserId = result.lastID;
      await db.run(
        `INSERT INTO user_settings (user_id, provider, model_name, local_url, local_api_style) VALUES (?, 'local', 'test-model', 'http://localhost:1234/v1', 'openai')`,
        [polishUserId]
      );
    });

    afterEach(() => {
      delete global.fetch;
    });

    test('runs content through an LLM polish pass by default when the user has LLM settings configured', async () => {
      global.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '# Polished Title\n\nThis was rewritten by the polish pass.' } }] })
      }));

      const output = await handleDocumentGeneratorTool(db, polishUserId, 'generate_pdf', {
        filename: 'rough-draft.pdf',
        title: 'Rough Draft',
        content: 'raw unpolished content'
      });

      expect(output).toContain('Document generated successfully');
      expect(global.fetch).toHaveBeenCalledTimes(1);

      const row = await db.get('SELECT * FROM generated_documents WHERE user_id = ? ORDER BY id DESC LIMIT 1', [polishUserId]);
      expect(fs.existsSync(row.filepath)).toBe(true);
    });

    test('skips the polish pass entirely when skipAutoPolish is set', async () => {
      global.fetch = jest.fn(async () => { throw new Error('fetch should not have been called'); });

      const output = await handleDocumentGeneratorTool(db, polishUserId, 'generate_pdf', {
        filename: 'already-polished.pdf',
        title: 'Already Polished',
        content: 'content that should pass through unchanged',
        skipAutoPolish: true
      });

      expect(output).toContain('Document generated successfully');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('falls back to the original content instead of failing when the polish pass errors', async () => {
      global.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' }));

      const output = await handleDocumentGeneratorTool(db, polishUserId, 'generate_pdf', {
        filename: 'polish-fails.pdf',
        title: 'Polish Fails',
        content: 'content that must still get rendered'
      });

      // 3 attempts inside generateText's own retry loop before giving up and falling back.
      expect(output).toContain('Document generated successfully');
    }, 15000);
  });

  test('generate_xlsx requires a non-empty sheets array', async () => {
    const output = await handleDocumentGeneratorTool(db, userId, 'generate_xlsx', { filename: 'plan.xlsx' });
    expect(output).toMatch(/^Error: "sheets"/);
  });

  test('generate_xlsx builds a workbook and saves it', async () => {
    const output = await handleDocumentGeneratorTool(db, userId, 'generate_xlsx', {
      filename: 'schedule.xlsx',
      sheets: [{ name: 'Week 1', headers: ['Day', 'Topic'], rows: [['Mon', 'IAM Basics']] }]
    });

    expect(output).toContain('Document generated successfully');
    const row = await db.get("SELECT * FROM generated_documents WHERE doc_type = 'xlsx' AND user_id = ? ORDER BY id DESC LIMIT 1", [userId]);
    expect(row).toBeDefined();
    expect(fs.existsSync(row.filepath)).toBe(true);
  });

  test('generate_pptx requires a non-empty slides array', async () => {
    const output = await handleDocumentGeneratorTool(db, userId, 'generate_pptx', { filename: 'deck.pptx' });
    expect(output).toMatch(/^Error: "slides"/);
  });

  test('generate_pptx builds a deck and saves it', async () => {
    const output = await handleDocumentGeneratorTool(db, userId, 'generate_pptx', {
      filename: 'overview.pptx',
      title: 'AWS AI Practitioner Overview',
      slides: [{ title: 'Week 1', bullets: ['IAM basics', 'Shared responsibility model'] }]
    });

    expect(output).toContain('Document generated successfully');
    const row = await db.get("SELECT * FROM generated_documents WHERE doc_type = 'pptx' AND user_id = ? ORDER BY id DESC LIMIT 1", [userId]);
    expect(row).toBeDefined();
    expect(fs.existsSync(row.filepath)).toBe(true);
  });
});
