import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TokenCountView from './TokenCountView';
import * as exportUtils from '../utils/export';

vi.mock('../utils/export', () => ({
  exportAsCSV: vi.fn(),
  exportAsJSON: vi.fn()
}));

// ENH-5 (docs/REVIEW_2026-08-03.md): the main app previously had zero per-user token/cost
// visibility - this component was dead code, only wired up in the separate monitor_dashboard
// (admin-only) app. GET /api/token-usage is already scoped to req.user.id server-side
// (backend/routes/token_usage.js), so no backend changes were needed - just wiring this view
// into the main app for the logged-in user's own usage.
describe('TokenCountView Component Tests (ENH-5)', () => {
  const tokenUsageResponse = {
    totalTokens: 1500,
    tableData: [
      { model_name: 'qwen2.5-coder-7b-instruct', provider_type: 'local', total_tokens: 1000, call_count: 3 },
      { model_name: 'gemini-2.0-flash', provider_type: 'online', total_tokens: 500, call_count: 1 }
    ],
    graphData: [
      { created_at: new Date().toISOString(), model_name: 'qwen2.5-coder-7b-instruct', provider_type: 'local', token_count: 1000 }
    ]
  };

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn((url) => {
      if (url.startsWith('/api/token-usage')) {
        return Promise.resolve({ ok: true, json: async () => tokenUsageResponse });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
  });

  test('fetches and renders the current user\'s own usage, scoped by the Authorization header', async () => {
    render(<TokenCountView token="my-user-token" />);

    await waitFor(() => expect(screen.getByText('1,500')).toBeInTheDocument());

    expect(screen.getByText('qwen2.5-coder-7b-instruct')).toBeInTheDocument();
    expect(screen.getByText('gemini-2.0-flash')).toBeInTheDocument();

    const call = global.fetch.mock.calls.find(([url]) => url.startsWith('/api/token-usage'));
    expect(call[1].headers.Authorization).toBe('Bearer my-user-token');
  });

  test('switching timeframe re-fetches with the new timeframe param', async () => {
    render(<TokenCountView token="my-user-token" />);
    await waitFor(() => expect(screen.getByText('1,500')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Last Week' }));

    await waitFor(() =>
      expect(global.fetch.mock.calls.some(([url]) => url === '/api/token-usage?timeframe=7d')).toBe(true)
    );
  });

  test('exports the per-model table as CSV and JSON', async () => {
    render(<TokenCountView token="my-user-token" />);
    await waitFor(() => expect(screen.getByText('1,500')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /csv/i }));
    expect(exportUtils.exportAsCSV).toHaveBeenCalledWith(
      'patti-token-usage-24h.csv',
      tokenUsageResponse.tableData,
      expect.arrayContaining([expect.objectContaining({ key: 'model_name' })])
    );

    fireEvent.click(screen.getByRole('button', { name: /json/i }));
    expect(exportUtils.exportAsJSON).toHaveBeenCalledWith('patti-token-usage-24h.json', tokenUsageResponse.tableData);
  });

  test('hides export buttons and shows an empty message when there is no usage yet', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({ totalTokens: 0, tableData: [], graphData: [] }) })
    );
    render(<TokenCountView token="my-user-token" />);

    await waitFor(() => expect(screen.getByText('No token usage recorded for this timeframe.')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /csv/i })).not.toBeInTheDocument();
  });
});
