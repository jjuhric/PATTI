import React, { useState, useMemo, useEffect } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown, Search } from 'lucide-react';

// FEAT-1 (docs/REVIEW_2026-08-03.md): one shared, reusable table with column sort, a text
// filter, and pagination, so this isn't solved separately in every view that shows tabular
// data. Reuses the app's existing `.table`/`.table-zebra`/`.form-control` classes rather than
// inventing new styling - this is a behavior layer on top of markup the app already has.
//
// columns: [{ key, label, sortable, searchable, align, render(row) }]
//   - key: property name on each data row (also the default sort/search accessor)
//   - render(row): optional custom cell content; falls back to row[key]
//   - sortable: enables click-to-sort on this column (uses row[key] unless sortValue is given)
//   - sortValue(row): optional custom value to sort by, when row[key] isn't directly sortable
//   - searchable: whether this column's text counts toward the search box match (default true
//     unless the column defines a custom `render` with no `searchValue`, since rendered JSX
//     can't be searched as text)
//   - searchValue(row): optional custom string to search, for columns with custom render

function defaultSearchValue(col, row) {
  if (col.searchValue) return String(col.searchValue(row) ?? '');
  if (!col.render) return String(row[col.key] ?? '');
  return '';
}

function defaultSortValue(col, row) {
  if (col.sortValue) return col.sortValue(row);
  return row[col.key];
}

export default function DataTable({
  columns,
  data,
  getRowKey,
  searchPlaceholder = 'Search...',
  searchable = true,
  defaultSortKey = null,
  defaultSortDirection = 'asc',
  pageSize = 10,
  emptyMessage = 'No results.',
  className = '',
  // FEAT-3 (docs/REVIEW_2026-08-03.md): bulk actions. `selectable` adds a checkbox column;
  // `bulkActions(selectedRows, clearSelection)` renders whatever action buttons the caller
  // wants in a toolbar that appears once at least one row is selected - DataTable itself has
  // no opinion on what a "bulk action" does (delete, export, etc.), it just tracks selection.
  selectable = false,
  bulkActions = null,
  getRowLabel = null
}) {
  const [searchTerm, setSearchTerm] = useState('');
  const [sortKey, setSortKey] = useState(defaultSortKey);
  const [sortDirection, setSortDirection] = useState(defaultSortDirection);
  const [page, setPage] = useState(0);
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());

  // Prune the selection to rows that still exist whenever the underlying data changes (e.g.
  // after a bulk delete completes and the list refetches) - otherwise a stale selection could
  // silently point at rows that are no longer there.
  useEffect(() => {
    if (!selectable) return;
    setSelectedKeys((prev) => {
      if (prev.size === 0) return prev;
      const validKeys = new Set(data.map(getRowKey));
      const next = new Set([...prev].filter((k) => validKeys.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [data, selectable, getRowKey]);

  const filtered = useMemo(() => {
    if (!searchable || !searchTerm.trim()) return data;
    const needle = searchTerm.trim().toLowerCase();
    return data.filter((row) =>
      columns.some((col) => {
        if (col.searchable === false) return false;
        return defaultSearchValue(col, row).toLowerCase().includes(needle);
      })
    );
  }, [data, searchTerm, columns, searchable]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return filtered;
    const withValues = filtered.map((row) => ({ row, value: defaultSortValue(col, row) }));
    withValues.sort((a, b) => {
      const av = a.value;
      const bv = b.value;
      if (av == null && bv == null) return 0;
      if (av == null) return -1;
      if (bv == null) return 1;
      if (typeof av === 'number' && typeof bv === 'number') return av - bv;
      return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
    });
    if (sortDirection === 'desc') withValues.reverse();
    return withValues.map((w) => w.row);
  }, [filtered, sortKey, sortDirection, columns]);

  const pageCount = pageSize ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  const clampedPage = Math.min(page, pageCount - 1);
  const paged = pageSize ? sorted.slice(clampedPage * pageSize, clampedPage * pageSize + pageSize) : sorted;

  // Selection is scoped to the current page - "select all" across every filtered/sorted result
  // regardless of pagination risks silently queuing up a much bigger destructive action than
  // what's visible on screen.
  const pageKeys = paged.map(getRowKey);
  const allPageSelected = pageKeys.length > 0 && pageKeys.every((k) => selectedKeys.has(k));
  const toggleSelectAllOnPage = () => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (allPageSelected) pageKeys.forEach((k) => next.delete(k));
      else pageKeys.forEach((k) => next.add(k));
      return next;
    });
  };
  const toggleRow = (key) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const clearSelection = () => setSelectedKeys(new Set());
  const selectedRows = useMemo(
    () => data.filter((row) => selectedKeys.has(getRowKey(row))),
    [data, selectedKeys, getRowKey]
  );

  const handleSort = (col) => {
    if (!col.sortable) return;
    if (sortKey !== col.key) {
      setSortKey(col.key);
      setSortDirection('asc');
    } else {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    }
    setPage(0);
  };

  const handleSearchChange = (e) => {
    setSearchTerm(e.target.value);
    setPage(0);
  };

  return (
    <div className={`data-table-wrapper ${className}`}>
      {searchable && (
        <div className="data-table-search">
          <Search size={14} className="data-table-search-icon" aria-hidden="true" />
          <input
            type="text"
            className="form-control"
            placeholder={searchPlaceholder}
            value={searchTerm}
            onChange={handleSearchChange}
            aria-label={searchPlaceholder}
          />
        </div>
      )}
      {selectable && selectedKeys.size > 0 && (
        <div className="data-table-bulk-toolbar">
          <span className="data-table-bulk-count">{selectedKeys.size} selected</span>
          {bulkActions && bulkActions(selectedRows, clearSelection)}
          <button type="button" className="btn btn-ghost btn-sm" onClick={clearSelection}>
            Clear selection
          </button>
        </div>
      )}
      <div className="overflow-x-auto w-full">
        <table className="table table-zebra w-full">
          <thead>
            <tr>
              {selectable && (
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    onChange={toggleSelectAllOnPage}
                    aria-label="Select all rows on this page"
                  />
                </th>
              )}
              {columns.map((col) => (
                <th
                  key={col.key}
                  onClick={() => handleSort(col)}
                  className={col.sortable ? 'data-table-sortable-header' : ''}
                  style={col.align ? { textAlign: col.align } : undefined}
                  role={col.sortable ? 'button' : undefined}
                  tabIndex={col.sortable ? 0 : undefined}
                  onKeyDown={col.sortable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSort(col); } } : undefined}
                  aria-sort={sortKey === col.key ? (sortDirection === 'asc' ? 'ascending' : 'descending') : col.sortable ? 'none' : undefined}
                >
                  <span className="data-table-header-content">
                    {col.label}
                    {col.sortable && (
                      sortKey === col.key
                        ? (sortDirection === 'asc' ? <ChevronUp size={13} /> : <ChevronDown size={13} />)
                        : <ChevronsUpDown size={13} className="data-table-sort-hint" />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paged.length === 0 ? (
              <tr>
                <td colSpan={columns.length + (selectable ? 1 : 0)} className="data-table-empty">{emptyMessage}</td>
              </tr>
            ) : (
              paged.map((row) => (
                <tr key={getRowKey(row)}>
                  {selectable && (
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedKeys.has(getRowKey(row))}
                        onChange={() => toggleRow(getRowKey(row))}
                        aria-label={`Select ${getRowLabel ? getRowLabel(row) : `row ${getRowKey(row)}`}`}
                      />
                    </td>
                  )}
                  {columns.map((col) => (
                    <td key={col.key} style={col.align ? { textAlign: col.align } : undefined}>
                      {col.render ? col.render(row) : row[col.key]}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {pageSize && sorted.length > pageSize && (
        <div className="data-table-pagination">
          <span className="data-table-pagination-info">
            {clampedPage * pageSize + 1}-{Math.min((clampedPage + 1) * pageSize, sorted.length)} of {sorted.length}
          </span>
          <div className="data-table-pagination-buttons">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={clampedPage === 0}
            >
              Prev
            </button>
            <span className="data-table-pagination-page">Page {clampedPage + 1} of {pageCount}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={clampedPage >= pageCount - 1}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
