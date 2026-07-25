const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { generateText } = require('./llm_text');
const { searchAndDownloadImage } = require('./wikimedia_images');

const MAX_IMAGES = 3;
const IMAGE_PLACEHOLDER_PATTERN = /!\[([^\]]*)\]\(SEARCH:\s*([^)]+)\)/g;

/**
 * Rewrites `rawMarkdown` into clean, well-structured Markdown via PATTI's own LLM (proper
 * headings, fenced code blocks, tables) and optionally inserts illustrative images pulled
 * from Wikimedia Commons. This is the shared "polish" step used both when reformatting an
 * uploaded document (document_formatter_tool.js) and, automatically, whenever any other tool
 * creates a new PDF/DOCX document (document_generator_tool.js) - kept as its own leaf module
 * with no dependency on either of those, so neither one has to require the other.
 *
 * Any images referenced in the returned markdown live in a temp directory that the CALLER
 * must clean up (via the returned `cleanup()`) only AFTER it has finished rendering/embedding
 * those images into the final document - deleting them any earlier would break the render.
 *
 * @param {object} settings LLM settings from llm_text.js's buildSettingsForUser
 * @param {string} rawMarkdown The content to reformat
 * @param {object} [options]
 * @param {string} [options.instructions] Additional user instructions to fold into the prompt
 * @param {number} [options.imageCount] Max illustrative images to insert (default 2, 0 disables)
 * @returns {Promise<{markdown: string, cleanup: () => void}>}
 */
async function reformatMarkdown(settings, rawMarkdown, options = {}) {
  const { instructions, imageCount = 2 } = options;

  const systemPrompt = buildReformatSystemPrompt(imageCount, instructions);
  const reformatted = await generateText(settings, systemPrompt, rawMarkdown);

  const tempDir = path.join(os.tmpdir(), `patti-doc-reformat-${crypto.randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const markdown = await resolveImagePlaceholders(reformatted, tempDir);

  return { markdown, cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }) };
}

function buildReformatSystemPrompt(imageCount, instructions) {
  let prompt = 'You are a professional document editor. You will be given the content of a document - ' +
    'some original formatting may be imperfect or lost. Rewrite the ENTIRE document as clean, ' +
    'well-structured Markdown while preserving ALL substantive content - do not summarize, shorten, or ' +
    'omit anything.\n' +
    '- Use "#"/"##"/"###" headings at levels that make sense for the content\'s structure.\n' +
    '- Wrap any code, commands, or configuration examples in fenced ```language code blocks.\n' +
    '- Use pipe tables (| header | header |) for genuinely tabular or comparison data.\n' +
    '- Use bullet lists for enumerated points.\n';

  if (imageCount > 0) {
    prompt += `- You may insert up to ${imageCount} illustrative images at points where a picture would ` +
      'genuinely help the reader. To do this, insert a line of the exact form: ' +
      '![short descriptive alt text](SEARCH: 2-5 word image search query) on its own line, with nothing ' +
      'else on that line. Only do this where an image adds real value - most documents need zero or one.\n';
  }

  if (instructions && instructions.trim()) {
    prompt += `\nAdditional instructions from the user: ${instructions.trim()}\n`;
  }

  prompt += '\nOutput ONLY the reformatted Markdown - no preamble, no commentary before or after it.';
  return prompt;
}

// Resolves each ![alt](SEARCH: query) placeholder the LLM inserted into a real Wikimedia
// Commons image downloaded to tempDir, or drops the placeholder line entirely on failure -
// a missing image should never fail the whole reformat.
async function resolveImagePlaceholders(markdown, tempDir) {
  const matches = [...markdown.matchAll(IMAGE_PLACEHOLDER_PATTERN)].slice(0, MAX_IMAGES);
  let result = markdown;

  for (const match of matches) {
    const [fullMatch, alt, query] = match;
    const image = await searchAndDownloadImage(query.trim(), tempDir);
    result = image
      ? result.replace(fullMatch, `![${alt} (${image.attribution})](${image.path})`)
      : result.replace(fullMatch, '');
  }

  // Drop any leftover placeholders beyond the MAX_IMAGES cap.
  return result.replace(IMAGE_PLACEHOLDER_PATTERN, '');
}

module.exports = { reformatMarkdown };
