const path = require('path');

jest.mock('../utils/embeddings', () => ({
  storeSystemDoc: jest.fn().mockResolvedValue()
}));

const REPO_ROOT = path.resolve(__dirname, '../..');
const README_PATH = path.join(REPO_ROOT, 'README.md');
const WIKI_DIR = path.join(REPO_ROOT, 'PATTI.wiki');
const MANIFEST_PATH = path.resolve(__dirname, '../../data/vector-store', 'system_docs.manifest.json');

jest.mock('fs', () => {
  const actualFs = jest.requireActual('fs');
  return {
    ...actualFs,
    existsSync: jest.fn(),
    readdirSync: jest.fn(),
    readFileSync: jest.fn(),
    writeFileSync: jest.fn(),
    mkdirSync: jest.fn()
  };
});

const fs = require('fs');
const { storeSystemDoc } = require('../utils/embeddings');
const { main, hashContent } = require('../scripts/seed_system_docs');

function setupFsMocks({ readmeContent, wikiFiles = {}, manifestContent = null, manifestExists = false }) {
  fs.existsSync.mockImplementation((p) => {
    if (p === README_PATH) return true;
    if (p === WIKI_DIR) return true;
    if (p === MANIFEST_PATH) return manifestExists;
    return false;
  });
  fs.readdirSync.mockImplementation((p) => {
    if (p === WIKI_DIR) return Object.keys(wikiFiles);
    return [];
  });
  fs.readFileSync.mockImplementation((p) => {
    if (p === README_PATH) return readmeContent;
    if (p === MANIFEST_PATH) return manifestContent;
    const filename = path.basename(p);
    if (wikiFiles[filename] !== undefined) return wikiFiles[filename];
    throw new Error(`Unexpected readFileSync call: ${p}`);
  });
}

describe('Seed System Docs Script', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('indexes README and every wiki .md file on a fresh (unseeded) run', async () => {
    setupFsMocks({
      readmeContent: 'PATTI is an AI assistant.',
      wikiFiles: { 'Contributing.md': 'Write a manifest.json and handler.js.', 'FAQ.md': 'Why do I see errors?' },
      manifestExists: false
    });

    const result = await main(['node', 'seed_system_docs.js']);

    expect(result.indexed.sort()).toEqual(['Contributing.md', 'FAQ.md', 'README.md'].sort());
    expect(result.skipped).toEqual([]);
    expect(storeSystemDoc).toHaveBeenCalledWith('PATTI is an AI assistant.', { source: 'README.md' });
    expect(storeSystemDoc).toHaveBeenCalledWith('Write a manifest.json and handler.js.', { source: 'Contributing.md' });
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      MANIFEST_PATH,
      expect.stringContaining('README.md'),
      'utf8'
    );
  });

  test('skips files whose content hash is unchanged from the manifest', async () => {
    const readmeContent = 'PATTI is an AI assistant.';
    const existingManifest = JSON.stringify({ 'README.md': hashContent(readmeContent) });

    setupFsMocks({
      readmeContent,
      wikiFiles: {},
      manifestContent: existingManifest,
      manifestExists: true
    });

    const result = await main(['node', 'seed_system_docs.js']);

    expect(result.indexed).toEqual([]);
    expect(result.skipped).toEqual(['README.md']);
    expect(storeSystemDoc).not.toHaveBeenCalled();
  });

  test('re-indexes a file whose content changed since the manifest was written', async () => {
    const oldContent = 'Old README content.';
    const newContent = 'New README content that has changed.';
    const existingManifest = JSON.stringify({ 'README.md': hashContent(oldContent) });

    setupFsMocks({
      readmeContent: newContent,
      wikiFiles: {},
      manifestContent: existingManifest,
      manifestExists: true
    });

    const result = await main(['node', 'seed_system_docs.js']);

    expect(result.indexed).toEqual(['README.md']);
    expect(storeSystemDoc).toHaveBeenCalledWith(newContent, { source: 'README.md' });
  });

  test('--force re-indexes everything even if hashes match', async () => {
    const readmeContent = 'PATTI is an AI assistant.';
    const existingManifest = JSON.stringify({ 'README.md': hashContent(readmeContent) });

    setupFsMocks({
      readmeContent,
      wikiFiles: {},
      manifestContent: existingManifest,
      manifestExists: true
    });

    const result = await main(['node', 'seed_system_docs.js', '--force']);

    expect(result.indexed).toEqual(['README.md']);
    expect(result.skipped).toEqual([]);
    expect(storeSystemDoc).toHaveBeenCalledWith(readmeContent, { source: 'README.md' });
  });
});
