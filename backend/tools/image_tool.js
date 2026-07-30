const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { searchAndDownloadImage } = require('../utils/wikimedia_images');
const { resolveSafePath } = require('../utils/pathSecurity');
const logger = require('../utils/logger');

/**
 * General-purpose image tool: search the web (Wikimedia Commons - free, no API key) for a
 * reference image, and/or process a local image (trim/crop/resize/rotate/grayscale/adjust/
 * flip/flop/format-convert/watermark) via sharp. Available to any worker agent, in particular
 * developer_agent and graphics_engineer for pulling in and editing asset art.
 *
 * @param {string} action 'search_image' | 'process_image'
 * @param {object} params Action-specific parameters
 * @returns {Promise<string>} Text result for the calling agent
 */
async function handleImageTool(action, params = {}) {
  try {
    if (action === 'search_image') return await searchImage(params);
    if (action === 'process_image') return await processImage(params);
    return `Error: Unknown Image Tool action "${action}". Valid actions: search_image, process_image.`;
  } catch (err) {
    logger.error('Image tool error:', err);
    return `Error: ${err.message}`;
  }
}

async function searchImage(params) {
  const query = params.query;
  const destDir = params.destDir || params.dest_dir;
  if (!query || typeof query !== 'string' || !query.trim()) {
    return 'Error: "query" parameter is required.';
  }
  if (!destDir || typeof destDir !== 'string' || !destDir.trim()) {
    return 'Error: "destDir" parameter is required.';
  }

  let resolvedDir;
  try {
    resolvedDir = resolveSafePath(destDir.trim());
  } catch (err) {
    return `Error: ${err.message}`;
  }
  fs.mkdirSync(resolvedDir, { recursive: true });

  const result = await searchAndDownloadImage(query.trim(), resolvedDir);
  if (!result) {
    return `No usable free/licensed image found on Wikimedia Commons for "${query}".`;
  }
  return `Downloaded an image for "${query}" to "${result.path}". License: ${result.license}. Attribution: ${result.attribution}. Source: ${result.sourceUrl}`;
}

const PROCESS_MODES = ['trim', 'crop', 'resize', 'rotate', 'grayscale', 'adjust', 'flip', 'flop', 'format', 'watermark'];
const FORMAT_EXTENSIONS = { png: '.png', jpeg: '.jpg', webp: '.webp' };

async function processImage(params) {
  const imagePath = params.imagePath || params.image_path;
  const mode = params.mode;
  if (!imagePath || typeof imagePath !== 'string' || !imagePath.trim()) {
    return 'Error: "imagePath" parameter is required.';
  }
  if (!PROCESS_MODES.includes(mode)) {
    return `Error: "mode" parameter must be one of ${PROCESS_MODES.map((m) => `"${m}"`).join(', ')}.`;
  }

  let resolvedInput;
  try {
    resolvedInput = resolveSafePath(imagePath.trim());
  } catch (err) {
    return `Error: ${err.message}`;
  }
  if (!fs.existsSync(resolvedInput)) {
    return `Error: Image not found at "${resolvedInput}".`;
  }

  const outputPathParam = params.outputPath || params.output_path;
  let resolvedOutput;
  if (outputPathParam) {
    try {
      resolvedOutput = resolveSafePath(outputPathParam.trim());
    } catch (err) {
      return `Error: ${err.message}`;
    }
  } else {
    const ext = mode === 'format'
      ? (FORMAT_EXTENSIONS[params.outputFormat] || path.extname(resolvedInput) || '.png')
      : (path.extname(resolvedInput) || '.png');
    const base = resolvedInput.slice(0, resolvedInput.length - (path.extname(resolvedInput).length || 0));
    resolvedOutput = `${base}_${mode}${ext}`;
  }

  if (resolvedOutput === resolvedInput) {
    return 'Error: outputPath must differ from imagePath (sharp cannot read and write the same file).';
  }

  let pipeline = sharp(resolvedInput);

  if (mode === 'trim') {
    pipeline = pipeline.trim();
  } else if (mode === 'resize') {
    const width = params.width ? parseInt(params.width, 10) : null;
    const height = params.height ? parseInt(params.height, 10) : null;
    if (!width && !height) {
      return 'Error: "resize" mode requires "width" and/or "height".';
    }
    pipeline = pipeline.resize(width || null, height || null, { fit: 'inside' });
  } else if (mode === 'crop') {
    const left = parseInt(params.left, 10);
    const top = parseInt(params.top, 10);
    const width = parseInt(params.width, 10);
    const height = parseInt(params.height, 10);
    if (![left, top, width, height].every(Number.isFinite)) {
      return 'Error: "crop" mode requires numeric "left", "top", "width", and "height".';
    }
    pipeline = pipeline.extract({ left, top, width, height });
  } else if (mode === 'rotate') {
    const angle = params.angle !== undefined ? parseInt(params.angle, 10) : NaN;
    if (!Number.isFinite(angle)) {
      return 'Error: "rotate" mode requires a numeric "angle".';
    }
    pipeline = pipeline.rotate(angle);
  } else if (mode === 'grayscale') {
    pipeline = pipeline.grayscale();
  } else if (mode === 'adjust') {
    const { brightness, saturation, hue } = params;
    if (brightness === undefined && saturation === undefined && hue === undefined) {
      return 'Error: "adjust" mode requires at least one of "brightness", "saturation", "hue".';
    }
    const modulateOpts = {};
    if (brightness !== undefined) modulateOpts.brightness = parseFloat(brightness);
    if (saturation !== undefined) modulateOpts.saturation = parseFloat(saturation);
    if (hue !== undefined) modulateOpts.hue = parseInt(hue, 10);
    pipeline = pipeline.modulate(modulateOpts);
  } else if (mode === 'flip') {
    pipeline = pipeline.flip(); // vertical (top-to-bottom) flip
  } else if (mode === 'flop') {
    pipeline = pipeline.flop(); // horizontal (left-to-right) flip
  } else if (mode === 'format') {
    const outputFormat = params.outputFormat;
    if (!['png', 'jpeg', 'webp'].includes(outputFormat)) {
      return 'Error: "format" mode requires "outputFormat" to be one of "png", "jpeg", "webp".';
    }
    pipeline = pipeline.toFormat(outputFormat);
  } else if (mode === 'watermark') {
    const overlayPathParam = params.overlayPath || params.overlay_path;
    if (!overlayPathParam || typeof overlayPathParam !== 'string' || !overlayPathParam.trim()) {
      return 'Error: "watermark" mode requires "overlayPath".';
    }
    let resolvedOverlay;
    try {
      resolvedOverlay = resolveSafePath(overlayPathParam.trim());
    } catch (err) {
      return `Error: ${err.message}`;
    }
    if (!fs.existsSync(resolvedOverlay)) {
      return `Error: Overlay image not found at "${resolvedOverlay}".`;
    }
    pipeline = pipeline.composite([{ input: resolvedOverlay, gravity: params.gravity || 'southeast' }]);
  }

  try {
    await pipeline.toFile(resolvedOutput);
  } catch (err) {
    return `Error processing image: ${err.message}`;
  }
  return `Image processed (${mode}) and saved to "${resolvedOutput}".`;
}

module.exports = { handleImageTool };
