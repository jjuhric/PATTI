const fs = require('fs');
const path = require('path');
const os = require('os');
const { searchAndDownloadImage } = require('../utils/wikimedia_images');

function jsonResponse(body, ok = true) {
  return { ok, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) };
}

describe('searchAndDownloadImage', () => {
  let destDir;

  beforeEach(() => {
    destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wikimedia-test-'));
  });

  afterEach(() => {
    fs.rmSync(destDir, { recursive: true, force: true });
    delete global.fetch;
  });

  test('downloads the first usable candidate and returns attribution info', async () => {
    const fakePngBytes = Buffer.from('89504e470d0a1a0a', 'hex');
    let callIndex = 0;
    global.fetch = jest.fn(async (url) => {
      callIndex++;
      if (url.includes('list=search')) {
        return jsonResponse({ query: { search: [{ title: 'File:Mechanical_keyboard.jpg' }] } });
      }
      if (url.includes('prop=imageinfo')) {
        return jsonResponse({
          query: {
            pages: {
              123: {
                imageinfo: [{
                  url: 'https://upload.wikimedia.org/mechanical_keyboard.jpg',
                  thumburl: 'https://upload.wikimedia.org/thumb/mechanical_keyboard.jpg',
                  descriptionurl: 'https://commons.wikimedia.org/wiki/File:Mechanical_keyboard.jpg',
                  extmetadata: {
                    LicenseShortName: { value: 'CC BY-SA 4.0' },
                    Artist: { value: '<a href="#">Jane Doe</a>' }
                  }
                }]
              }
            }
          }
        });
      }
      // Image binary download
      return { ok: true, arrayBuffer: async () => fakePngBytes.buffer.slice(fakePngBytes.byteOffset, fakePngBytes.byteOffset + fakePngBytes.byteLength) };
    });

    const result = await searchAndDownloadImage('mechanical keyboard', destDir);

    expect(result).not.toBeNull();
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.path.endsWith('.jpg')).toBe(true);
    expect(result.license).toBe('CC BY-SA 4.0');
    expect(result.attribution).toContain('Jane Doe');
    expect(result.attribution).not.toContain('<a href');
    expect(result.sourceUrl).toContain('commons.wikimedia.org');
    expect(callIndex).toBeGreaterThanOrEqual(2);
  });

  test('returns null when the search finds no candidates', async () => {
    global.fetch = jest.fn(async () => jsonResponse({ query: { search: [] } }));

    const result = await searchAndDownloadImage('a topic with no images', destDir);
    expect(result).toBeNull();
  });

  test('returns null (not a throw) when the underlying API call fails', async () => {
    global.fetch = jest.fn(async () => { throw new Error('network down'); });

    const result = await searchAndDownloadImage('anything', destDir);
    expect(result).toBeNull();
  });

  test('skips a candidate whose image download fails and does not throw', async () => {
    global.fetch = jest.fn(async (url) => {
      if (url.includes('list=search')) {
        return jsonResponse({ query: { search: [{ title: 'File:Broken.jpg' }] } });
      }
      if (url.includes('prop=imageinfo')) {
        return jsonResponse({
          query: { pages: { 1: { imageinfo: [{ url: 'https://upload.wikimedia.org/broken.jpg', extmetadata: {} }] } } }
        });
      }
      return { ok: false };
    });

    const result = await searchAndDownloadImage('broken image', destDir);
    expect(result).toBeNull();
  });
});
