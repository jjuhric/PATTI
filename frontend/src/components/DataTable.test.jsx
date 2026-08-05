import React from 'react';
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import DataTable from './DataTable';

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
});
