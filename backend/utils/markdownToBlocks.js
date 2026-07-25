/**
 * Parses a lightweight markdown subset (# through ###### headings, -/* bullets,
 * [text](url) inline links, **bold**, `inline code`, fenced ``` code blocks,
 * pipe tables, standalone ![alt](path) images, and blank-line-separated
 * paragraphs) into a block array shared by the PDF and DOCX document generators.
 *
 * @param {string} markdown
 * @returns {Array<object>} blocks: heading/bullet/paragraph (with `runs`),
 *   code (with `language`, `text`), table (with `headers`, `rows`), or
 *   image (with `alt`, `src` - src is always a local absolute file path)
 */
function markdownToBlocks(markdown) {
  const text = (markdown || '').replace(/\r\n/g, '\n');
  if (!text.trim()) return [];

  // Split on the fence delimiter directly rather than parsing line-by-line - models don't
  // reliably put ``` on its own line (a short example is sometimes embedded mid-bullet), so
  // anchoring fence detection to "start of line" misses those and lets raw ``` /backticks
  // leak into the rendered text as literal characters.
  const segments = text.split('```');
  const blocks = [];

  segments.forEach((segment, idx) => {
    if (idx % 2 === 1) {
      const { language, code } = extractLanguageAndCode(segment);
      const trimmedCode = code.replace(/^\n+/, '').replace(/\s+$/, '');
      if (trimmedCode) {
        blocks.push({ type: 'code', language, text: trimmedCode });
      }
    } else {
      parseNonCodeSegment(segment, blocks);
    }
  });

  return blocks;
}

// A fence's language tag is only trustworthy when it's on its own line before the code
// (the standard ```lang\n... convention) - otherwise assume there's no language tag rather
// than risk swallowing the first real token of unlabeled code (e.g. "int x = 5;").
function extractLanguageAndCode(segment) {
  const newlineIdx = segment.indexOf('\n');
  if (newlineIdx !== -1) {
    const firstLine = segment.slice(0, newlineIdx).trim();
    if (/^[a-zA-Z0-9_+#-]{0,20}$/.test(firstLine)) {
      return { language: firstLine, code: segment.slice(newlineIdx + 1) };
    }
  }
  return { language: '', code: segment };
}

function parseNonCodeSegment(segment, blocks) {
  const lines = segment.split('\n');
  let para = [];

  const flush = () => {
    if (para.length) {
      blocks.push({ type: 'paragraph', runs: parseInline(para.join(' ').trim()) });
      para = [];
    }
  };

  const isTableSeparator = (line) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim());

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    if (line === '') {
      flush();
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      // Only headings 1-3 have distinct rendering; deeper levels fold into level 3
      // rather than being left unrecognized (models use #### constantly for subsections).
      blocks.push({ type: 'heading', level: Math.min(heading[1].length, 3), runs: parseInline(heading[2]) });
      i++;
      continue;
    }

    // src is always a local absolute file path by the time this parser runs - callers that
    // resolve remote images (e.g. document_formatter_tool.js) download them to disk first,
    // so this shared renderer never needs to do network I/O.
    const image = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (image) {
      flush();
      blocks.push({ type: 'image', alt: image[1], src: image[2] });
      i++;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flush();
      const headers = splitTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().includes('|')) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      flush();
      blocks.push({ type: 'bullet', runs: parseInline(bullet[1]) });
      i++;
      continue;
    }

    para.push(line);
    i++;
  }
  flush();
}

function splitTableRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

/**
 * Splits a line of text into runs, extracting [text](url) links, **bold**
 * spans, and `inline code` spans so they can sit mid-sentence or mid-bullet.
 *
 * @param {string} text
 * @returns {Array<{text: string, url?: string, bold?: boolean, code?: boolean}>}
 */
function parseInline(text) {
  const runs = [];
  const pattern = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      runs.push({ text: text.slice(last, match.index) });
    }
    if (match[1] !== undefined) {
      runs.push({ text: match[1], url: match[2] });
    } else if (match[3] !== undefined) {
      runs.push({ text: match[3], bold: true });
    } else if (match[4] !== undefined) {
      runs.push({ text: match[4], code: true });
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) {
    runs.push({ text: text.slice(last) });
  }
  return runs.length ? runs : [{ text }];
}

module.exports = { markdownToBlocks, parseInlineLinks: parseInline };
