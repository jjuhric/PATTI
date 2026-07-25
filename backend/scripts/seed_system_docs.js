const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chunkText } = require('../tools/vault_tool');
const { storeSystemDoc } = require('../utils/embeddings');

const REPO_ROOT = path.resolve(__dirname, '../..');
const WIKI_DIR = path.join(REPO_ROOT, 'PATTI.wiki');
const VECTOR_STORE_DIR = path.resolve(__dirname, '../../data/vector-store');
const MANIFEST_PATH = path.join(VECTOR_STORE_DIR, 'system_docs.manifest.json');

function parseArgs(argv) {
  const args = {};
  argv.slice(2).forEach(arg => {
    if (arg.startsWith('--')) {
      const raw = arg.slice(2);
      if (!raw.includes('=')) {
        // Bare boolean flag, e.g. --force
        args[raw] = true;
        return;
      }
      const parts = raw.split('=');
      const key = parts[0];
      const val = parts.slice(1).join('=');
      args[key] = val;
    }
  });
  return args;
}

function hashContent(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function readManifest() {
  try {
    if (fs.existsSync(MANIFEST_PATH)) {
      return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    }
  } catch (err) {
    console.warn('[Seed System Docs] Failed to read manifest, treating as empty:', err.message);
  }
  return {};
}

function writeManifest(manifest) {
  if (!fs.existsSync(VECTOR_STORE_DIR)) {
    fs.mkdirSync(VECTOR_STORE_DIR, { recursive: true });
  }
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
}

/**
 * Collects PATTI's own documentation files: the root README plus every
 * wiki page, keyed by a display-friendly source name.
 */
function collectDocFiles() {
  const files = [];

  const readmePath = path.join(REPO_ROOT, 'README.md');
  if (fs.existsSync(readmePath)) {
    files.push({ source: 'README.md', filePath: readmePath });
  }

  if (fs.existsSync(WIKI_DIR)) {
    const wikiFiles = fs.readdirSync(WIKI_DIR).filter(f => f.endsWith('.md'));
    for (const f of wikiFiles) {
      files.push({ source: f, filePath: path.join(WIKI_DIR, f) });
    }
  }

  return files;
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  const force = args.force === true || args.force === 'true';

  const docFiles = collectDocFiles();
  if (docFiles.length === 0) {
    console.warn('[Seed System Docs] No documentation files found (README.md or PATTI.wiki/*.md).');
    return { indexed: [], skipped: [] };
  }

  const manifest = force ? {} : readManifest();
  const indexed = [];
  const skipped = [];

  for (const { source, filePath } of docFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const hash = hashContent(content);

    if (!force && manifest[source] === hash) {
      skipped.push(source);
      continue;
    }

    const chunks = chunkText(content);
    for (const chunk of chunks) {
      await storeSystemDoc(chunk, { source });
    }

    manifest[source] = hash;
    indexed.push(source);
  }

  writeManifest(manifest);

  console.log(`[Seed System Docs] Indexed: ${indexed.length ? indexed.join(', ') : '(none)'}. Skipped (unchanged): ${skipped.length}.`);
  return { indexed, skipped };
}

if (require.main === module) {
  main().catch(err => {
    console.error('[Seed System Docs] Failed:', err);
    process.exit(1);
  });
}

module.exports = { main, collectDocFiles, hashContent };
