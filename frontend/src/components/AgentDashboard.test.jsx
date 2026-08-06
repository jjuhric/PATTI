import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AgentDashboard from './AgentDashboard';

describe('AgentDashboard Component Tests', () => {
  test('renders nodes list correctly', () => {
    const mockNodes = [
      { id: 1, node_name: 'Pi Node 1', device_type: 'RPi', ip_address: '192.168.1.100', port: 3000, is_online: 1 }
    ];

    render(
      <AgentDashboard
        nodes={mockNodes}
        token="test-token"
        handleDeleteNode={() => {}}
        activeSubTab="nodes"
      />
    );

    expect(screen.getByText('Pi Node 1')).toBeInTheDocument();
    expect(screen.getByText('192.168.1.100:3000')).toBeInTheDocument();
  });

  // FEAT-1 (docs/REVIEW_2026-08-03.md): the nodes table now goes through the shared DataTable -
  // these confirm the existing dedup/gateway-hiding/online-only filtering (FEAT-10) still runs
  // correctly feeding into it, and that search/delete still work post-rollout.
  test('hides the gateway IP and offline nodes, and de-duplicates by IP preferring google_home', () => {
    const mockNodes = [
      { id: 1, node_name: 'Gateway', device_type: 'router', ip_address: '192.168.1.1', port: 80, is_online: 1 },
      { id: 2, node_name: 'Offline Node', device_type: 'RPi', ip_address: '192.168.1.50', port: 3000, is_online: 0 },
      { id: 3, node_name: 'Google Assistant Dup', device_type: 'assistant', ip_address: '192.168.1.60', port: 8080, is_online: 1 },
      { id: 4, node_name: 'Google Home', device_type: 'google_home', ip_address: '192.168.1.60', port: 8080, is_online: 1 }
    ];

    render(<AgentDashboard nodes={mockNodes} token="t" handleDeleteNode={() => {}} activeSubTab="nodes" />);

    expect(screen.queryByText('Gateway')).not.toBeInTheDocument();
    expect(screen.queryByText('Offline Node')).not.toBeInTheDocument();
    expect(screen.queryByText('Google Assistant Dup')).not.toBeInTheDocument();
    expect(screen.getByText('Google Home')).toBeInTheDocument();
  });

  test('search box filters the nodes table', () => {
    const mockNodes = [
      { id: 1, node_name: 'Living Room Pi', device_type: 'RPi', ip_address: '192.168.1.50', port: 3000, is_online: 1 },
      { id: 2, node_name: 'Kitchen ESP32', device_type: 'esp32', ip_address: '192.168.1.51', port: 80, is_online: 1 }
    ];

    render(<AgentDashboard nodes={mockNodes} token="t" handleDeleteNode={() => {}} activeSubTab="nodes" />);
    fireEvent.change(screen.getByPlaceholderText('Search nodes...'), { target: { value: 'kitchen' } });

    expect(screen.getByText('Kitchen ESP32')).toBeInTheDocument();
    expect(screen.queryByText('Living Room Pi')).not.toBeInTheDocument();
  });

  test('clicking delete calls handleDeleteNode with the node id', () => {
    const mockNodes = [
      { id: 42, node_name: 'Pi Node', device_type: 'RPi', ip_address: '192.168.1.50', port: 3000, is_online: 1 }
    ];
    const handleDeleteNode = vi.fn();

    render(<AgentDashboard nodes={mockNodes} token="t" handleDeleteNode={handleDeleteNode} activeSubTab="nodes" />);
    fireEvent.click(screen.getByLabelText('Delete node Pi Node'));

    expect(handleDeleteNode).toHaveBeenCalledWith(42);
  });

  test('shows the empty-state message when there are no online nodes', () => {
    render(<AgentDashboard nodes={[]} token="t" handleDeleteNode={() => {}} activeSubTab="nodes" />);
    expect(screen.getByText('No online nodes found.')).toBeInTheDocument();
  });

  // FEAT-3 (docs/REVIEW_2026-08-03.md): bulk delete for the Nodes table.
  describe('bulk delete', () => {
    const mockNodes = [
      { id: 1, node_name: 'Node One', device_type: 'RPi', ip_address: '192.168.1.50', port: 3000, is_online: 1 },
      { id: 2, node_name: 'Node Two', device_type: 'RPi', ip_address: '192.168.1.51', port: 3000, is_online: 1 }
    ];

    beforeEach(() => {
      global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) }));
    });

    test('routes the bulk-delete confirmation through onRequestConfirm when provided', async () => {
      const onRequestConfirm = vi.fn();
      const onRefresh = vi.fn();
      render(
        <AgentDashboard
          nodes={mockNodes}
          token="t"
          handleDeleteNode={() => {}}
          onRefresh={onRefresh}
          activeSubTab="nodes"
          onRequestConfirm={onRequestConfirm}
        />
      );

      fireEvent.click(screen.getByLabelText('Select all rows on this page'));
      fireEvent.click(screen.getByRole('button', { name: 'Delete 2 nodes' }));

      expect(onRequestConfirm).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Delete 2 nodes? This cannot be undone.'
      }));
      expect(global.fetch).not.toHaveBeenCalled();

      await onRequestConfirm.mock.calls[0][0].onConfirm();
      expect(global.fetch.mock.calls.some(([url, opts]) => url === '/api/nodes/1' && opts?.method === 'DELETE')).toBe(true);
      expect(global.fetch.mock.calls.some(([url, opts]) => url === '/api/nodes/2' && opts?.method === 'DELETE')).toBe(true);
      expect(onRefresh).toHaveBeenCalled();
    });

    test('falls back to window.confirm when onRequestConfirm is not provided', () => {
      const windowConfirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      render(<AgentDashboard nodes={mockNodes} token="t" handleDeleteNode={() => {}} activeSubTab="nodes" />);

      fireEvent.click(screen.getByLabelText('Select all rows on this page'));
      fireEvent.click(screen.getByRole('button', { name: 'Delete 2 nodes' }));

      expect(windowConfirmSpy).toHaveBeenCalledWith('Delete 2 nodes? This cannot be undone.');
      expect(global.fetch).not.toHaveBeenCalled();
      windowConfirmSpy.mockRestore();
    });
  });
});
