const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink, Table, TableRow, TableCell, WidthType, BorderStyle, ImageRun, AlignmentType } = require('docx');
const ExcelJS = require('exceljs');
const PptxGenJS = require('pptxgenjs');
const { imageSize } = require('image-size');
const { JWT_SECRET } = require('../middleware/auth');
const { markdownToBlocks } = require('../utils/markdownToBlocks');
const { buildSettingsForUser } = require('../utils/llm_text');
const { reformatMarkdown } = require('../utils/document_reformatter');

const HEADING_SIZES = { 1: 20, 2: 16, 3: 13 };
const DOCX_HEADING_LEVELS = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 };
const MIME_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

/**
 * Handles document generation tool calls from worker agents.
 *
 * @param {import('sqlite').Database} db SQLite DB instance
 * @param {number} userId The user's ID
 * @param {string} action 'generate_pdf' | 'generate_docx' | 'generate_xlsx' | 'generate_pptx'
 * @param {object} params Action-specific parameters
 * @returns {Promise<string>} Text result for the worker agent (directive success string, or "Error: ...")
 */
async function handleDocumentGeneratorTool(db, userId, action, params = {}) {
  if (!db) {
    return 'Error: Database connection is not available.';
  }

  try {
    const { filename, title } = params;
    if (!filename || typeof filename !== 'string' || !filename.trim()) {
      return 'Error: "filename" parameter is required.';
    }

    let buffer;
    let ext;

    if (action === 'generate_pdf' || action === 'generate_docx') {
      const { content, skipAutoPolish } = params;
      if (!content || typeof content !== 'string' || !content.trim()) {
        return 'Error: "content" parameter is required for this action.';
      }

      // Every PDF/DOCX PATTI creates gets one automatic "polish" pass - proper headings,
      // real code fences/tables, and a couple of illustrative images - unless the caller has
      // already done this itself (document_formatter_tool.js sets skipAutoPolish to avoid a
      // redundant second LLM rewrite of content it already polished). Never let a failure here
      // (no LLM configured, network hiccup, etc.) block document creation - fall back to the
      // caller's original content.
      let finalContent = content;
      let cleanupImages = null;
      if (!skipAutoPolish) {
        try {
          const settings = await buildSettingsForUser(db, userId);
          const polished = await reformatMarkdown(settings, content, { imageCount: 2 });
          finalContent = polished.markdown;
          cleanupImages = polished.cleanup;
        } catch (err) {
          console.error('Document generator auto-polish skipped (using original content):', err.message);
        }
      }

      try {
        const blocks = markdownToBlocks(finalContent);
        ext = action === 'generate_pdf' ? 'pdf' : 'docx';
        buffer = ext === 'pdf' ? await buildPdf(title || filename, blocks) : await buildDocx(title || filename, blocks);
      } finally {
        if (cleanupImages) cleanupImages();
      }
    } else if (action === 'generate_xlsx') {
      const { sheets } = params;
      if (!Array.isArray(sheets) || sheets.length === 0) {
        return 'Error: "sheets" parameter (array of { name, headers, rows }) is required for generate_xlsx.';
      }
      ext = 'xlsx';
      buffer = await buildXlsx(sheets);
    } else if (action === 'generate_pptx') {
      const { slides } = params;
      if (!Array.isArray(slides) || slides.length === 0) {
        return 'Error: "slides" parameter (array of { title, bullets }) is required for generate_pptx.';
      }
      ext = 'pptx';
      buffer = await buildPptx(title || filename, slides);
    } else {
      return `Error: Unknown Document Generator action "${action}".`;
    }

    const { docId, finalName } = await saveGeneratedDocument(db, userId, filename, ext, buffer);
    const dlToken = jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '1h' });
    const downloadUrl = `/api/documents/${docId}/download?token=${dlToken}`;

    return `Document generated successfully. You MUST include this exact download link, byte-for-byte, in your final response as an HTML anchor tag per your formatting rules: <a href="${downloadUrl}" target="_blank" rel="noopener noreferrer">Download ${finalName}</a>`;
  } catch (err) {
    console.error('Document generator tool error:', err);
    return `Error generating document: ${err.message}`;
  }
}

/**
 * Sanitizes the filename, writes the buffer to disk under a per-user
 * directory, and records the file in the generated_documents table.
 */
async function saveGeneratedDocument(db, userId, filename, ext, buffer) {
  const baseName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  const finalName = baseName.toLowerCase().endsWith(`.${ext}`) ? baseName : `${baseName}.${ext}`;

  const userDir = path.join(process.cwd(), 'generated_documents', String(userId));
  fs.mkdirSync(userDir, { recursive: true });

  const filepath = path.join(userDir, `${Date.now()}_${finalName}`);
  fs.writeFileSync(filepath, buffer);

  const result = await db.run(
    'INSERT INTO generated_documents (user_id, filename, filepath, doc_type, file_size) VALUES (?, ?, ?, ?, ?)',
    [userId, finalName, filepath, ext, buffer.length]
  );

  return { docId: result.lastID, finalName };
}

function buildPdf(title, blocks) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(22).text(title, { align: 'center' });
    doc.moveDown();
    doc.font('Helvetica').fontSize(11);

    renderBlocksToPdf(doc, blocks);

    doc.end();
  });
}

function renderBlocksToPdf(doc, blocks) {
  for (const block of blocks) {
    if (block.type === 'heading') {
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(HEADING_SIZES[block.level] || 14);
      renderPdfRuns(doc, block.runs);
      doc.font('Helvetica').fontSize(11);
    } else if (block.type === 'bullet') {
      doc.fontSize(11).text('•  ', { continued: true });
      renderPdfRuns(doc, block.runs);
    } else if (block.type === 'code') {
      renderPdfCodeBlock(doc, block);
    } else if (block.type === 'table') {
      renderPdfTable(doc, block);
    } else if (block.type === 'image') {
      renderPdfImage(doc, block);
    } else {
      doc.fontSize(11).moveDown(0.3);
      renderPdfRuns(doc, block.runs);
    }
  }
}

function renderPdfRuns(doc, runs) {
  runs.forEach((run, i) => {
    const opts = { continued: i < runs.length - 1 };
    if (run.url) {
      doc.fillColor('#1a73e8').text(run.text, { ...opts, link: run.url, underline: true }).fillColor('black');
    } else if (run.code) {
      doc.font('Courier').text(run.text, opts).font('Helvetica');
    } else if (run.bold) {
      doc.font('Helvetica-Bold').text(run.text, opts).font('Helvetica');
    } else {
      doc.text(run.text, opts);
    }
  });
}

function renderPdfCodeBlock(doc, block) {
  doc.moveDown(0.3);
  const fontSize = 9;
  const padding = 8;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const textWidth = usableWidth - padding * 2;
  const text = block.text || '';

  doc.font('Courier').fontSize(fontSize);
  const textHeight = doc.heightOfString(text, { width: textWidth });
  const boxHeight = textHeight + padding * 2;

  if (doc.y + boxHeight > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
  const x = doc.page.margins.left;
  const y = doc.y;
  doc.rect(x, y, usableWidth, boxHeight).fill('#f2f2f2');
  doc.fillColor('black').text(text, x + padding, y + padding, { width: textWidth, lineBreak: true });

  doc.x = doc.page.margins.left;
  doc.y = y + boxHeight;
  doc.font('Helvetica').fontSize(11);
  doc.moveDown(0.5);
}

function renderPdfImage(doc, block) {
  doc.moveDown(0.3);
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const maxHeight = 320;

  let buffer;
  try {
    buffer = fs.readFileSync(block.src);
  } catch (err) {
    return; // Missing/unreadable image file - skip it rather than fail the whole document.
  }

  let dims;
  try {
    dims = imageSize(buffer);
  } catch (err) {
    return; // Not a decodable image - skip it.
  }

  // Never upscale beyond the image's native size, only shrink to fit.
  const scale = Math.min(usableWidth / dims.width, maxHeight / dims.height, 1);
  const width = Math.round(dims.width * scale);
  const height = Math.round(dims.height * scale);

  if (doc.y + height + 20 > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
  const x = doc.page.margins.left + (usableWidth - width) / 2;
  const y = doc.y;
  doc.image(buffer, x, y, { width, height });
  doc.x = doc.page.margins.left;
  doc.y = y + height + 4;

  if (block.alt) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor('#555555')
      .text(block.alt, doc.page.margins.left, doc.y, { width: usableWidth, align: 'center' });
    doc.fillColor('black').font('Helvetica').fontSize(11);
  }
  doc.moveDown(0.5);
}

function renderPdfTable(doc, block) {
  doc.moveDown(0.3);
  const startX = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colCount = block.headers.length;
  const colWidth = usableWidth / colCount;
  const cellPadding = 5;
  const fontSize = 10;

  const drawRow = (cells, isHeader) => {
    doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
    const cellWidth = colWidth - cellPadding * 2;
    const rowHeight = Math.max(
      ...cells.map((cell) => doc.heightOfString(String(cell ?? ''), { width: cellWidth }))
    ) + cellPadding * 2;

    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
    }
    const y = doc.y;

    cells.forEach((cell, i) => {
      const x = startX + i * colWidth;
      doc.rect(x, y, colWidth, rowHeight).stroke('#cccccc');
      doc.text(String(cell ?? ''), x + cellPadding, y + cellPadding, { width: cellWidth });
    });

    doc.x = startX;
    doc.y = y + rowHeight;
  };

  drawRow(block.headers, true);
  block.rows.forEach((row) => drawRow(row, false));

  doc.font('Helvetica').fontSize(11);
  doc.moveDown(0.5);
}

async function buildDocx(title, blocks) {
  const children = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
    ...blocks.map((block) => {
      if (block.type === 'code') {
        // A raw \n inside a single TextRun does not render as a line break in docx - each
        // source line needs its own TextRun with an explicit `break`, or a multi-line
        // snippet collapses onto one unreadable line.
        const codeLines = block.text.split('\n');
        const runs = codeLines.map((codeLine, i) => new TextRun({
          text: codeLine,
          font: 'Courier New',
          break: i > 0 ? 1 : 0
        }));
        return new Paragraph({
          children: runs,
          shading: { fill: 'F2F2F2' },
          spacing: { after: 200 }
        });
      }
      if (block.type === 'table') {
        return buildDocxTable(block);
      }
      if (block.type === 'image') {
        return buildDocxImage(block);
      }

      const runs = block.runs.map((run) => {
        if (run.url) {
          return new ExternalHyperlink({ children: [new TextRun({ text: run.text, style: 'Hyperlink' })], link: run.url });
        }
        return new TextRun({
          text: run.text,
          bold: run.bold || undefined,
          font: run.code ? 'Courier New' : undefined
        });
      });

      if (block.type === 'heading') {
        return new Paragraph({ heading: DOCX_HEADING_LEVELS[block.level] || HeadingLevel.HEADING_3, children: runs });
      }
      if (block.type === 'bullet') {
        return new Paragraph({ bullet: { level: 0 }, children: runs });
      }
      return new Paragraph({ children: runs, spacing: { after: 200 } });
    })
  ];

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

function buildDocxImage(block) {
  let buffer;
  let dims;
  try {
    buffer = fs.readFileSync(block.src);
    dims = imageSize(buffer);
  } catch (err) {
    return new Paragraph({}); // Missing/unreadable/undecodable image - skip it, keep array shape.
  }

  const maxWidth = 450;
  const scale = Math.min(maxWidth / dims.width, 1);
  const width = Math.round(dims.width * scale);
  const height = Math.round(dims.height * scale);

  const children = [new ImageRun({ data: buffer, type: dims.type, transformation: { width, height } })];
  if (block.alt) {
    children.push(new TextRun({ text: block.alt, italics: true, size: 18, color: '555555', break: 1 }));
  }

  return new Paragraph({ children, alignment: AlignmentType.CENTER, spacing: { after: 200 } });
}

function buildDocxTable(block) {
  const noBorder = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
  const borders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };

  const makeRow = (cells, isHeader) => new TableRow({
    children: cells.map((cell) => new TableCell({
      borders,
      children: [new Paragraph({ children: [new TextRun({ text: String(cell ?? ''), bold: isHeader })] })]
    }))
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [makeRow(block.headers, true), ...block.rows.map((row) => makeRow(row, false))]
  });
}

async function buildXlsx(sheets) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'PATTI';

  for (const sheet of sheets) {
    const ws = workbook.addWorksheet((sheet.name || 'Sheet1').slice(0, 31));
    if (Array.isArray(sheet.headers) && sheet.headers.length) {
      const headerRow = ws.addRow(sheet.headers);
      headerRow.font = { bold: true };
    }
    for (const row of sheet.rows || []) {
      ws.addRow(row);
    }
    ws.columns.forEach((col) => { col.width = 22; });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

async function buildPptx(title, slides) {
  const pptx = new PptxGenJS();

  const titleSlide = pptx.addSlide();
  titleSlide.addText(title || 'Presentation', { x: 0.5, y: 2.2, w: 9, h: 1.5, fontSize: 32, bold: true, align: 'center' });

  for (const slide of slides) {
    const s = pptx.addSlide();
    s.addText(slide.title || '', { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 24, bold: true });
    const bulletItems = (slide.bullets || []).map((bullet) => ({ text: bullet, options: { bullet: true, breakLine: true } }));
    if (bulletItems.length) {
      s.addText(bulletItems, { x: 0.5, y: 1.3, w: 9, h: 4.5, fontSize: 16 });
    }
  }

  const buffer = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.from(buffer);
}

module.exports = { handleDocumentGeneratorTool, MIME_TYPES };
