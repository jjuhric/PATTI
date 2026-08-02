import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import NotificationBell from './NotificationBell';

describe('NotificationBell Component', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  test('fetches on mount and shows no badge when there are no unread notifications', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ notifications: [], unreadCount: 0 }) });
    render(<NotificationBell token="t" refreshSignal={0} onOpenChat={() => {}} />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/notifications', {
      headers: { 'Authorization': 'Bearer t' }
    }));
    expect(screen.queryByText('1')).not.toBeInTheDocument();
  });

  test('shows an unread-count badge and caps display at "9+"', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ notifications: [], unreadCount: 12 }) });
    render(<NotificationBell token="t" refreshSignal={0} onOpenChat={() => {}} />);

    await waitFor(() => expect(screen.getByText('9+')).toBeInTheDocument());
  });

  test('refetches when refreshSignal changes', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ notifications: [], unreadCount: 0 }) });
    const { rerender } = render(<NotificationBell token="t" refreshSignal={0} onOpenChat={() => {}} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));

    rerender(<NotificationBell token="t" refreshSignal={1} onOpenChat={() => {}} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
  });

  test('opens the dropdown, lists notifications, and clicking one marks it read and opens its chat', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        notifications: [
          { id: 1, type: 'info', message: 'Your course is ready.', chat_id: 42, is_read: 0, created_at: '2026-08-02 06:00:00' }
        ],
        unreadCount: 1
      })
    });
    const onOpenChat = vi.fn();
    render(<NotificationBell token="t" refreshSignal={0} onOpenChat={onOpenChat} />);

    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Notifications, 1 unread'));
    expect(screen.getByText('Your course is ready.')).toBeInTheDocument();

    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    fireEvent.click(screen.getByText('Your course is ready.'));

    await waitFor(() => expect(onOpenChat).toHaveBeenCalledWith(42));
    expect(global.fetch).toHaveBeenCalledWith('/api/notifications/1/read', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer t' }
    });
  });

  test('"Mark all read" clears the badge and calls the read-all endpoint', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        notifications: [
          { id: 1, type: 'info', message: 'First', chat_id: null, is_read: 0, created_at: '2026-08-02 06:00:00' },
          { id: 2, type: 'info', message: 'Second', chat_id: null, is_read: 0, created_at: '2026-08-02 05:00:00' }
        ],
        unreadCount: 2
      })
    });
    render(<NotificationBell token="t" refreshSignal={0} onOpenChat={() => {}} />);

    await waitFor(() => expect(screen.getByText('2')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Notifications, 2 unread'));

    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    fireEvent.click(screen.getByText('Mark all read'));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/notifications/read-all', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer t' }
    }));
    expect(screen.queryByText('Mark all read')).not.toBeInTheDocument();
  });
});
