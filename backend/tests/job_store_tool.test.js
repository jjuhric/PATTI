const fs = require('fs');
const path = require('path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');

const { handleJobStoreTool, storeChunked } = require('../tools/job_store_tool');

describe('job_store_tool', () => {
  let db;

  beforeAll(async () => {
    db = await open({ filename: ':memory:', driver: sqlite3.Database });
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await db.exec(schemaSql);
  });

  afterAll(async () => {
    await db.close();
  });

  test('returns an error string when the db is unavailable', async () => {
    const output = await handleJobStoreTool(null, 'read_spec', { job_id: 'x' });
    expect(output).toMatch(/^Error:/);
  });

  test('returns an error string for an unknown action', async () => {
    const output = await handleJobStoreTool(db, 'bogus_action', { job_id: 'x' });
    expect(output).toMatch(/^Error: Unknown Job Store action/);
  });

  test('read_spec requires job_id', async () => {
    const output = await handleJobStoreTool(db, 'read_spec', {});
    expect(output).toMatch(/^Error: "job_id"/);
  });

  test('read_spec on a job with no stored spec returns an empty, non-hasMore chunk', async () => {
    const output = await handleJobStoreTool(db, 'read_spec', { job_id: 'never-stored' });
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({ content: '', seq: 0, hasMore: false, totalChunks: 0 });
  });

  test('storeChunked splits large content and read_spec pages through it in order', async () => {
    const jobId = 'job-large-spec';
    const content = 'A'.repeat(9000); // 3 chunks at the 4000-char default
    const chunkCount = await storeChunked(db, jobId, 'spec', content);
    expect(chunkCount).toBe(3);

    let reassembled = '';
    let seq = 0;
    for (;;) {
      const raw = await handleJobStoreTool(db, 'read_spec', { job_id: jobId, seq });
      const parsed = JSON.parse(raw);
      expect(parsed.totalChunks).toBe(3);
      reassembled += parsed.content;
      if (!parsed.hasMore) break;
      seq++;
    }
    expect(reassembled).toBe(content);
  });

  test('read_spec at an out-of-range seq returns an error', async () => {
    const output = await handleJobStoreTool(db, 'read_spec', { job_id: 'job-large-spec', seq: 99 });
    expect(output).toMatch(/^Error: No spec chunk/);
  });

  test('write_note requires job_id and content', async () => {
    expect(await handleJobStoreTool(db, 'write_note', { content: 'x' })).toMatch(/^Error: "job_id"/);
    expect(await handleJobStoreTool(db, 'write_note', { job_id: 'j1' })).toMatch(/^Error: "content"/);
  });

  test('write_note then read_notes round-trips multiple notes in order with correct paging', async () => {
    const jobId = 'job-notes';
    await handleJobStoreTool(db, 'write_note', { job_id: jobId, content: 'first finding' });
    await handleJobStoreTool(db, 'write_note', { job_id: jobId, content: 'second finding' });
    await handleJobStoreTool(db, 'write_note', { job_id: jobId, content: 'third finding' });

    const first = JSON.parse(await handleJobStoreTool(db, 'read_notes', { job_id: jobId, seq: 0 }));
    expect(first).toEqual({ content: 'first finding', seq: 0, hasMore: true, totalChunks: 3 });

    const last = JSON.parse(await handleJobStoreTool(db, 'read_notes', { job_id: jobId, seq: 2 }));
    expect(last).toEqual({ content: 'third finding', seq: 2, hasMore: false, totalChunks: 3 });
  });

  test('spec and note entries for the same job_id are independent', async () => {
    const jobId = 'job-mixed';
    await storeChunked(db, jobId, 'spec', 'the spec text');
    await handleJobStoreTool(db, 'write_note', { job_id: jobId, content: 'a note' });

    const spec = JSON.parse(await handleJobStoreTool(db, 'read_spec', { job_id: jobId, seq: 0 }));
    const notes = JSON.parse(await handleJobStoreTool(db, 'read_notes', { job_id: jobId, seq: 0 }));
    expect(spec.content).toBe('the spec text');
    expect(notes.content).toBe('a note');
  });
});
