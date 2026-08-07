import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { toCSV, exportAsCSV, exportAsJSON } from './export';

describe('toCSV', () => {
  const rows = [
    { id: 1, name: 'Alice', note: 'Likes tea' },
    { id: 2, name: 'Bob "The Builder"', note: 'Multi-line\nnote' },
    { id: 3, name: 'Carol, Inc.', note: null }
  ];
  const columns = [
    { key: 'id', label: 'ID' },
    { key: 'name', label: 'Name' },
    { key: 'note', label: 'Note' }
  ];

  test('builds a header row plus one row per item', () => {
    const csv = toCSV(rows, columns);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('ID,Name,Note');
    expect(lines).toHaveLength(1 + 3 + 1); // header + 3 data rows, one of which itself wraps to 2 lines (embedded \n)
  });

  test('quotes and escapes values containing commas, quotes, or newlines', () => {
    const csv = toCSV(rows, columns);
    expect(csv).toContain('"Bob ""The Builder"""');
    expect(csv).toContain('"Multi-line\nnote"');
    expect(csv).toContain('"Carol, Inc."');
  });

  test('renders null/undefined as an empty cell, not the literal word', () => {
    const csv = toCSV(rows, columns);
    const lastLine = csv.split('\n').slice(-1)[0];
    expect(lastLine).toBe('3,"Carol, Inc.",');
  });

  test('supports a computed value(row) column alongside plain key lookups', () => {
    const csv = toCSV(rows, [
      { key: 'id', label: 'ID' },
      { label: 'Shout', value: (r) => r.name.toUpperCase() }
    ]);
    expect(csv.split('\n')[1]).toBe('1,ALICE');
  });

  test('returns just the header for an empty row set', () => {
    expect(toCSV([], columns)).toBe('ID,Name,Note');
  });
});

describe('exportAsCSV / exportAsJSON', () => {
  let clickedLink;

  beforeEach(() => {
    global.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    global.URL.revokeObjectURL = vi.fn();
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = realCreateElement(tag);
      if (tag === 'a') {
        clickedLink = el;
        el.click = vi.fn();
      }
      return el;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('exportAsCSV creates a download link with the right filename and CSV content type', () => {
    exportAsCSV('memories.csv', [{ id: 1, content: 'test' }], [{ key: 'id', label: 'ID' }, { key: 'content', label: 'Content' }]);

    expect(clickedLink.download).toBe('memories.csv');
    expect(clickedLink.click).toHaveBeenCalled();
    expect(global.URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    const blob = global.URL.createObjectURL.mock.calls[0][0];
    expect(blob.type).toContain('text/csv');
    expect(global.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  test('exportAsJSON creates a download link with pretty-printed JSON content type', () => {
    exportAsJSON('users.json', [{ id: 1, username: 'alice' }]);

    expect(clickedLink.download).toBe('users.json');
    expect(clickedLink.click).toHaveBeenCalled();
    const blob = global.URL.createObjectURL.mock.calls[0][0];
    expect(blob.type).toContain('application/json');
  });
});
