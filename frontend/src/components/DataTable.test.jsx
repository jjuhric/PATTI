import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import DataTable from './DataTable';
import * as exportUtils from '../utils/export';

vi.mock('../utils/export', () => ({
  exportAsCSV: vi.fn(),
  exportAsJSON: vi.fn()
}));

const users = [
  { id: 1, username: 'charlie', age: 40 },
  { id: 2, username: 'alice', age: 25 },
  { id: 3, username: 'bob', age: 32 }
];

const columns = [
  { key: 'username', label: 'Username', sortable: true },
  { key: 'age', label: 'Age', sortable: true, align: 'right' }
];

describe('DataTable', () => {
  test('renders every row and column by default', () => {
    render(<DataTable columns={columns} data={users} getRowKey={(r) => r.id} />);
    expect(screen.getByText('charlie')).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByText('40')).toBeInTheDocument();
  });

  test('shows the empty message when data is empty', () => {
    render(<DataTable columns={columns} data={[]} getRowKey={(r) => r.id} emptyMessage="Nothing here." />);
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();
  });

  test('sorts ascending then descending on repeated header clicks, and leaves a non-sortable column inert', () => {
    const nonSortableColumns = [
      { key: 'username', label: 'Username', sortable: true },
      { key: 'age', label: 'Age' } // not sortable
    ];
    render(<DataTable columns={nonSortableColumns} data={users} getRowKey={(r) => r.id} pageSize={null} />);

    const rows = () => screen.getAllByRole('row').slice(1); // skip header row
    const firstCellText = () => within(rows()[0]).getAllByRole('cell')[0].textContent;

    // Unsorted: insertion order.
    expect(firstCellText()).toBe('charlie');

    fireEvent.click(screen.getByText('Username'));
    expect(firstCellText()).toBe('alice'); // ascending: alice, bob, charlie

    fireEvent.click(screen.getByText('Username'));
    expect(firstCellText()).toBe('charlie'); // descending: charlie, bob, alice

    // Clicking a non-sortable header does nothing.
    fireEvent.click(screen.getByText('Age'));
    expect(firstCellText()).toBe('charlie');
  });

  test('sorts numeric columns numerically, not lexicographically', () => {
    const wideAges = [
      { id: 1, username: 'a', age: 9 },
      { id: 2, username: 'b', age: 10 },
      { id: 3, username: 'c', age: 2 }
    ];
    render(<DataTable columns={columns} data={wideAges} getRowKey={(r) => r.id} pageSize={null} />);
    fireEvent.click(screen.getByText('Age'));
    const rows = screen.getAllByRole('row').slice(1);
    const ages = rows.map((r) => within(r).getAllByRole('cell')[1].textContent);
    expect(ages).toEqual(['2', '9', '10']); // not ['10', '2', '9']
  });

  test('search box filters rows across searchable columns, case-insensitively', () => {
    render(<DataTable columns={columns} data={users} getRowKey={(r) => r.id} searchPlaceholder="Search users..." />);
    fireEvent.change(screen.getByPlaceholderText('Search users...'), { target: { value: 'ALI' } });

    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.queryByText('charlie')).not.toBeInTheDocument();
    expect(screen.queryByText('bob')).not.toBeInTheDocument();
  });

  test('a column with a custom render and searchValue is searchable via searchValue', () => {
    const withRender = [
      { key: 'username', label: 'Username', render: (r) => <strong>{r.username}</strong>, searchValue: (r) => r.username }
    ];
    render(<DataTable columns={withRender} data={users} getRowKey={(r) => r.id} />);
    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'bob' } });
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.queryByText('alice')).not.toBeInTheDocument();
  });

  test('custom render without searchValue does not match search text (documented limitation)', () => {
    const withRender = [
      { key: 'username', label: 'Username', render: (r) => <strong>{r.username}</strong> }
    ];
    render(<DataTable columns={withRender} data={users} getRowKey={(r) => r.id} />);
    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'bob' } });
    expect(screen.queryByText('bob')).not.toBeInTheDocument();
  });

  test('search is omitted entirely when searchable=false', () => {
    render(<DataTable columns={columns} data={users} getRowKey={(r) => r.id} searchable={false} />);
    expect(screen.queryByPlaceholderText('Search...')).not.toBeInTheDocument();
  });

  test('paginates and Prev/Next navigate correctly, disabling at the boundaries', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: i, username: `user${i}`, age: i }));
    render(<DataTable columns={columns} data={many} getRowKey={(r) => r.id} pageSize={10} />);

    expect(screen.getByText('1-10 of 25')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    const prevBtn = screen.getByRole('button', { name: 'Prev' });
    const nextBtn = screen.getByRole('button', { name: 'Next' });
    expect(prevBtn).toBeDisabled();

    fireEvent.click(nextBtn);
    expect(screen.getByText('11-20 of 25')).toBeInTheDocument();
    expect(prevBtn).not.toBeDisabled();

    fireEvent.click(nextBtn);
    expect(screen.getByText('21-25 of 25')).toBeInTheDocument();
    expect(nextBtn).toBeDisabled();
  });

  test('no pagination controls render when all rows fit on one page', () => {
    render(<DataTable columns={columns} data={users} getRowKey={(r) => r.id} pageSize={10} />);
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
  });

  test('changing the search term resets to page 1', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: i, username: `user${i}`, age: i }));
    render(<DataTable columns={columns} data={many} getRowKey={(r) => r.id} pageSize={10} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'user1' } });
    expect(screen.getByText(/Page 1 of/)).toBeInTheDocument();
  });

  test('sortable header is keyboard-operable via Enter', () => {
    render(<DataTable columns={columns} data={users} getRowKey={(r) => r.id} pageSize={null} />);
    const header = screen.getByText('Username').closest('th');
    fireEvent.keyDown(header, { key: 'Enter' });
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]).getAllByRole('cell')[0].textContent).toBe('alice');
  });

  // FEAT-3 (docs/REVIEW_2026-08-03.md): bulk-select and the bulk-actions toolbar.
  describe('bulk selection', () => {
    test('no checkboxes render when selectable is false (the default)', () => {
      render(<DataTable columns={columns} data={users} getRowKey={(r) => r.id} />);
      expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    });

    test('checking a row shows the bulk toolbar with a count and the bulkActions render prop', () => {
      const bulkActions = vi.fn((selectedRows, clearSelection) => (
        <button onClick={() => { clearSelection(); }}>Delete {selectedRows.length}</button>
      ));
      render(
        <DataTable
          columns={columns}
          data={users}
          getRowKey={(r) => r.id}
          getRowLabel={(r) => r.username}
          selectable
          bulkActions={bulkActions}
          pageSize={null}
        />
      );

      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();

      fireEvent.click(screen.getByLabelText('Select charlie'));
      expect(screen.getByText('1 selected')).toBeInTheDocument();
      expect(bulkActions).toHaveBeenCalledWith([users[0]], expect.any(Function));
      expect(screen.getByText('Delete 1')).toBeInTheDocument();
    });

    test('the header checkbox selects and deselects every row on the current page only', () => {
      const many = Array.from({ length: 15 }, (_, i) => ({ id: i, username: `user${i}`, age: i }));
      render(<DataTable columns={columns} data={many} getRowKey={(r) => r.id} selectable pageSize={10} />);

      fireEvent.click(screen.getByLabelText('Select all rows on this page'));
      expect(screen.getByText('10 selected')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      // Page 2's header checkbox reflects its own (unselected) rows, not page 1's.
      expect(screen.getByLabelText('Select all rows on this page')).not.toBeChecked();

      fireEvent.click(screen.getByLabelText('Select all rows on this page'));
      expect(screen.getByText('15 selected')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Prev' }));
      fireEvent.click(screen.getByLabelText('Select all rows on this page'));
      expect(screen.getByText('5 selected')).toBeInTheDocument();
    });

    test('"Clear selection" empties the selection and hides the toolbar', () => {
      render(<DataTable columns={columns} data={users} getRowKey={(r) => r.id} getRowLabel={(r) => r.username} selectable pageSize={null} />);
      fireEvent.click(screen.getByLabelText('Select charlie'));
      fireEvent.click(screen.getByLabelText('Select alice'));
      expect(screen.getByText('2 selected')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
      expect(screen.getByLabelText('Select charlie')).not.toBeChecked();
    });

    test('selection is pruned when a selected row disappears from data (e.g. after a delete)', () => {
      const { rerender } = render(<DataTable columns={columns} data={users} getRowKey={(r) => r.id} getRowLabel={(r) => r.username} selectable pageSize={null} />);
      fireEvent.click(screen.getByLabelText('Select charlie'));
      expect(screen.getByText('1 selected')).toBeInTheDocument();

      rerender(<DataTable columns={columns} data={users.filter((u) => u.username !== 'charlie')} getRowKey={(r) => r.id} getRowLabel={(r) => r.username} selectable pageSize={null} />);
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    });

    test('getRowLabel customizes the per-row checkbox aria-label', () => {
      render(
        <DataTable
          columns={columns}
          data={users}
          getRowKey={(r) => r.id}
          selectable
          getRowLabel={(row) => `user ${row.username}`}
        />
      );
      expect(screen.getByLabelText('Select user charlie')).toBeInTheDocument();
    });
  });

  // FEAT-4 (docs/REVIEW_2026-08-03.md): CSV/JSON export.
  describe('export', () => {
    beforeEach(() => {
      exportUtils.exportAsCSV.mockClear();
      exportUtils.exportAsJSON.mockClear();
    });

    test('no export buttons render when exportable is false (the default)', () => {
      render(<DataTable columns={columns} data={users} getRowKey={(r) => r.id} />);
      expect(screen.queryByText('CSV')).not.toBeInTheDocument();
      expect(screen.queryByText('JSON')).not.toBeInTheDocument();
    });

    test('Export CSV passes the current sorted/filtered rows and derived columns', () => {
      render(<DataTable columns={columns} data={users} getRowKey={(r) => r.id} exportable exportFilename="my-users" pageSize={null} />);
      fireEvent.click(screen.getByText('CSV'));

      expect(exportUtils.exportAsCSV).toHaveBeenCalledTimes(1);
      const [filename, rows, exportCols] = exportUtils.exportAsCSV.mock.calls[0];
      expect(filename).toBe('my-users.csv');
      expect(rows).toEqual(users);
      expect(exportCols.map((c) => c.label)).toEqual(['Username', 'Age']);
    });

    test('Export JSON passes the raw row objects for the current sorted/filtered set', () => {
      render(<DataTable columns={columns} data={users} getRowKey={(r) => r.id} exportable exportFilename="my-users" pageSize={null} />);
      fireEvent.click(screen.getByText('JSON'));

      expect(exportUtils.exportAsJSON).toHaveBeenCalledWith('my-users.json', users);
    });

    test('export respects the active search filter', () => {
      render(<DataTable columns={columns} data={users} getRowKey={(r) => r.id} exportable exportFilename="my-users" searchPlaceholder="Search..." pageSize={null} />);
      fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'ali' } });
      fireEvent.click(screen.getByText('JSON'));

      expect(exportUtils.exportAsJSON).toHaveBeenCalledWith('my-users.json', [users[1]]); // alice only
    });

    test('a column with searchable: false is excluded from the default export columns', () => {
      const withAction = [...columns, { key: 'actions', label: 'Actions', searchable: false, render: () => null }];
      render(<DataTable columns={withAction} data={users} getRowKey={(r) => r.id} exportable exportFilename="my-users" />);
      fireEvent.click(screen.getByText('CSV'));

      const exportCols = exportUtils.exportAsCSV.mock.calls[0][2];
      expect(exportCols.map((c) => c.label)).toEqual(['Username', 'Age']);
    });

    test('exportColumns overrides the default derived column set', () => {
      render(
        <DataTable
          columns={columns}
          data={users}
          getRowKey={(r) => r.id}
          exportable
          exportFilename="my-users"
          exportColumns={[{ key: 'username', label: 'Only This' }]}
        />
      );
      fireEvent.click(screen.getByText('CSV'));

      const exportCols = exportUtils.exportAsCSV.mock.calls[0][2];
      expect(exportCols).toEqual([{ key: 'username', label: 'Only This' }]);
    });

    test('export covers every matching row across all pages, not just the current page', () => {
      const many = Array.from({ length: 25 }, (_, i) => ({ id: i, username: `user${i}`, age: i }));
      render(<DataTable columns={columns} data={many} getRowKey={(r) => r.id} exportable exportFilename="many" pageSize={10} />);
      fireEvent.click(screen.getByText('JSON'));

      expect(exportUtils.exportAsJSON.mock.calls[0][1]).toHaveLength(25);
    });
  });
});
