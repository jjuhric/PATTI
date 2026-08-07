// FEAT-4 (docs/REVIEW_2026-08-03.md): shared CSV/JSON export helpers. Every export target in
// this app (currently just the token usage table) is already loaded client-side by the time the
// user wants to export it, so this triggers a browser download directly rather than adding a
// round trip to the server for data the page already has.
//
// This is a duplicate of frontend/src/utils/export.js, not a shared import - monitor_dashboard
// is a separate Vite app with no shared workspace (see BUG-5, docs/REVIEW_2026-08-03.md). Keep
// the two copies in sync by hand.

function csvEscape(value) {
  const str = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/**
 * Builds a CSV string from `rows` using `columns: [{ key, label }]` - `label` becomes the
 * header, `key` looks up each row's value unless the caller passes `value(row)` for a computed
 * column.
 */
export function toCSV(rows, columns) {
  const header = columns.map((c) => csvEscape(c.label)).join(',');
  const body = rows
    .map((row) => columns.map((c) => csvEscape(c.value ? c.value(row) : row[c.key])).join(','))
    .join('\n');
  return rows.length > 0 ? `${header}\n${body}` : header;
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportAsCSV(filename, rows, columns) {
  downloadFile(filename, toCSV(rows, columns), 'text/csv;charset=utf-8;');
}

export function exportAsJSON(filename, data) {
  downloadFile(filename, JSON.stringify(data, null, 2), 'application/json;charset=utf-8;');
}
