import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import AdminDashboard from './AdminDashboard';

describe('AdminDashboard - Create User', () => {
  const baseUsers = [
    { id: 1, username: 'admin_user', name: null, is_admin: 1, token_quota: 1000000, total_used_24h: 0 }
  ];

  beforeEach(() => {
    global.fetch = vi.fn((url, options = {}) => {
      if (url === '/api/admin/users' && (!options.method || options.method === 'GET')) {
        return Promise.resolve({ ok: true, json: async () => baseUsers });
      }
      if (url === '/api/admin/users' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        if (!body.username || body.password.length < 4) {
          return Promise.resolve({ ok: false, json: async () => ({ error: 'Username and password (min 4 characters) are required.' }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({ success: true, userId: 2 }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
  });

  test('opens the Create User modal and submits a new account', async () => {
    render(<AdminDashboard token="test-token" currentUserId={1} nodes={[]} handleDeleteNode={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('admin_user')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /create user/i }));
    const heading = screen.getByText('Create User', { selector: 'h3' });
    expect(heading).toBeInTheDocument();
    const modal = heading.closest('.modal-content');

    fireEvent.change(within(modal).getByLabelText('Username'), { target: { value: 'newperson' } });
    fireEvent.change(within(modal).getByLabelText('Password'), { target: { value: 'password123' } });

    fireEvent.click(within(modal).getByRole('button', { name: 'Create User' }));

    await waitFor(() => {
      const postCall = global.fetch.mock.calls.find(([url, opts]) => url === '/api/admin/users' && opts?.method === 'POST');
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall[1].body);
      expect(body).toEqual({ username: 'newperson', password: 'password123', is_admin: false });
    });

    await waitFor(() => expect(screen.getByText('Created account "newperson".')).toBeInTheDocument());
  });

  test('shows a client-side error for a too-short password without calling the API', async () => {
    render(<AdminDashboard token="test-token" currentUserId={1} nodes={[]} handleDeleteNode={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('admin_user')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /create user/i }));
    const modal = screen.getByText('Create User', { selector: 'h3' }).closest('.modal-content');
    fireEvent.change(within(modal).getByLabelText('Username'), { target: { value: 'x' } });
    fireEvent.change(within(modal).getByLabelText('Password'), { target: { value: 'ab' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Create User' }));

    expect(await screen.findByText('Username and password (min 4 characters) are required.')).toBeInTheDocument();
    const postCall = global.fetch.mock.calls.find(([url, opts]) => url === '/api/admin/users' && opts?.method === 'POST');
    expect(postCall).toBeUndefined();
  });
});

// BUG-7 (docs/REVIEW_2026-08-03.md): delete-user now goes through the app's shared confirm
// modal (via onRequestConfirm) instead of a native window.confirm.
describe('AdminDashboard - delete user confirmation', () => {
  const users = [
    { id: 1, username: 'admin_user', name: null, is_admin: 1, token_quota: 1000000, total_used_24h: 0 },
    { id: 2, username: 'regular_user', name: null, is_admin: 0, token_quota: 1000000, total_used_24h: 0 }
  ];

  beforeEach(() => {
    global.fetch = vi.fn((url, options = {}) => {
      if (url === '/api/admin/users' && (!options.method || options.method === 'GET')) {
        return Promise.resolve({ ok: true, json: async () => users });
      }
      if (url === '/api/admin/users/2' && options.method === 'DELETE') {
        return Promise.resolve({ ok: true, json: async () => ({ message: 'User 2 deleted successfully.' }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
  });

  test('routes the delete-user confirmation through onRequestConfirm instead of window.confirm', async () => {
    const onRequestConfirm = vi.fn();
    const windowConfirmSpy = vi.spyOn(window, 'confirm');

    render(<AdminDashboard token="test-token" currentUserId={1} nodes={[]} handleDeleteNode={vi.fn()} onRequestConfirm={onRequestConfirm} />);
    await waitFor(() => expect(screen.getByText('regular_user')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Delete user'));

    expect(windowConfirmSpy).not.toHaveBeenCalled();
    expect(onRequestConfirm).toHaveBeenCalledWith(expect.objectContaining({
      type: 'confirm',
      message: 'Delete user "regular_user"? This cannot be undone.',
      onConfirm: expect.any(Function)
    }));

    // The actual DELETE call only happens once the confirm callback is invoked.
    expect(global.fetch.mock.calls.some(([url, opts]) => url === '/api/admin/users/2' && opts?.method === 'DELETE')).toBe(false);
    await onRequestConfirm.mock.calls[0][0].onConfirm();
    await waitFor(() => {
      expect(global.fetch.mock.calls.some(([url, opts]) => url === '/api/admin/users/2' && opts?.method === 'DELETE')).toBe(true);
    });

    windowConfirmSpy.mockRestore();
  });

  test('falls back to window.confirm when onRequestConfirm is not provided', async () => {
    const windowConfirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<AdminDashboard token="test-token" currentUserId={1} nodes={[]} handleDeleteNode={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('regular_user')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Delete user'));

    expect(windowConfirmSpy).toHaveBeenCalledWith('Delete user "regular_user"? This cannot be undone.');
    // Cancelled via the mocked window.confirm returning false - no DELETE call.
    expect(global.fetch.mock.calls.some(([, opts]) => opts?.method === 'DELETE')).toBe(false);

    windowConfirmSpy.mockRestore();
  });
});

// FEAT-3 (docs/REVIEW_2026-08-03.md): bulk delete for the Users table.
describe('AdminDashboard - bulk delete users', () => {
  const users = [
    { id: 1, username: 'admin_user', name: null, is_admin: 1, token_quota: 1000000, total_used_24h: 0 },
    { id: 2, username: 'alice', name: null, is_admin: 0, token_quota: 1000000, total_used_24h: 0 },
    { id: 3, username: 'bob', name: null, is_admin: 0, token_quota: 1000000, total_used_24h: 0 }
  ];

  beforeEach(() => {
    global.fetch = vi.fn((url, options = {}) => {
      if (url === '/api/admin/users' && (!options.method || options.method === 'GET')) {
        return Promise.resolve({ ok: true, json: async () => users });
      }
      if (/^\/api\/admin\/users\/\d+$/.test(url) && options.method === 'DELETE') {
        return Promise.resolve({ ok: true, json: async () => ({ message: 'Deleted.' }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
  });

  test('selecting users shows a bulk-delete button that fires one DELETE per selected user, excluding self', async () => {
    const onRequestConfirm = vi.fn();
    render(<AdminDashboard token="test-token" currentUserId={1} nodes={[]} handleDeleteNode={vi.fn()} onRequestConfirm={onRequestConfirm} />);
    await waitFor(() => expect(screen.getByText('alice')).toBeInTheDocument());

    // Select-all on the page includes the admin's own row, but the bulk handler excludes it.
    fireEvent.click(screen.getByLabelText('Select all rows on this page'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete 2 users' }));

    expect(onRequestConfirm).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Delete 2 users? This cannot be undone.'
    }));
    await onRequestConfirm.mock.calls[0][0].onConfirm();

    await waitFor(() => {
      expect(global.fetch.mock.calls.some(([url, opts]) => url === '/api/admin/users/2' && opts?.method === 'DELETE')).toBe(true);
      expect(global.fetch.mock.calls.some(([url, opts]) => url === '/api/admin/users/3' && opts?.method === 'DELETE')).toBe(true);
    });
    // Never fires a DELETE against the requester's own account.
    expect(global.fetch.mock.calls.some(([url, opts]) => url === '/api/admin/users/1' && opts?.method === 'DELETE')).toBe(false);
  });

  test('shows an informative message instead of a delete button when only the requester is selected', async () => {
    render(<AdminDashboard token="test-token" currentUserId={1} nodes={[]} handleDeleteNode={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('admin_user')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Select admin_user'));
    expect(screen.getByText("Your own account can't be bulk-deleted.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete \d+ user/ })).not.toBeInTheDocument();
  });
});
