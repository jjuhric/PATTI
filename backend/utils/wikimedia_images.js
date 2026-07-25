const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API_BASE = 'https://commons.wikimedia.org/w/api.php';
// Wikimedia's API etiquette policy blocks generic/anonymous User-Agents.
const USER_AGENT = 'PATTI-DocumentFormatter/1.0 (local personal-use app; no public contact URL)';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_CANDIDATES = 5;

function stripHtml(value) {
  return (value || '').replace(/<[^>]+>/g, '').trim();
}

/**
 * Searches Wikimedia Commons for a free-to-use image matching `query`, downloads the first
 * usable result to `destDir`, and returns its local path plus attribution info. No API key
 * required. Returns null (never throws) if nothing usable is found, so a caller can just skip
 * that image slot rather than fail an entire document reformat.
 *
 * @param {string} query Short search query (e.g. "mechanical keyboard")
 * @param {string} destDir Directory to write the downloaded image into (must already exist)
 * @returns {Promise<{path: string, license: string, attribution: string, sourceUrl: string} | null>}
 */
async function searchAndDownloadImage(query, destDir) {
  try {
    const titles = await searchCandidateTitles(query);
    for (const title of titles) {
      const info = await getImageInfo(title);
      if (!info) continue;

      const imgUrl = info.thumburl || info.url;
      if (!imgUrl) continue;

      const imgRes = await fetch(imgUrl, { headers: { 'User-Agent': USER_AGENT } });
      if (!imgRes.ok) continue;

      const buffer = Buffer.from(await imgRes.arrayBuffer());
      if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) continue;

      const ext = (path.extname(new URL(imgUrl).pathname) || '.jpg').toLowerCase();
      const destPath = path.join(destDir, `${crypto.randomUUID()}${ext}`);
      fs.writeFileSync(destPath, buffer);

      const license = info.extmetadata?.LicenseShortName?.value || 'Unknown license';
      const artist = stripHtml(info.extmetadata?.Artist?.value) || 'Unknown author';

      return {
        path: destPath,
        license,
        attribution: `${artist}, ${license}, via Wikimedia Commons`,
        sourceUrl: info.descriptionurl || imgUrl
      };
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function searchCandidateTitles(query) {
  const url = `${API_BASE}?action=query&format=json&list=search&srnamespace=6&srlimit=${MAX_CANDIDATES}&srsearch=${encodeURIComponent(`filetype:bitmap ${query}`)}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.query?.search || []).map((r) => r.title);
}

async function getImageInfo(title) {
  const url = `${API_BASE}?action=query&format=json&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1000&titles=${encodeURIComponent(title)}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return null;
  const data = await res.json();
  const pages = data.query?.pages ? Object.values(data.query.pages) : [];
  return pages[0]?.imageinfo?.[0] || null;
}

module.exports = { searchAndDownloadImage };
