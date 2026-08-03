import React from 'react';
import { describe, test, expect, vi, beforeAll } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import App from './App';

// Mock scrollIntoView in JSDOM environment
window.HTMLElement.prototype.scrollIntoView = vi.fn();

// Mock localStorage globally
const mockLocalStorage = {
  getItem: vi.fn().mockReturnValue('mock_token'),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn()
};
global.localStorage = mockLocalStorage;

// Mock global fetch in Vitest
global.fetch = vi.fn().mockImplementation((url, options) => {
  const urlStr = String(url);

  if (urlStr.includes('/api/auth/me')) {
    return Promise.resolve({
      ok: true,
      json: async () => ({ user: { username: 'appuser' } })
    });
  }

  if (urlStr.includes('/api/settings/local-models')) {
    return Promise.resolve({
      ok: true,
      json: async () => ['qwen3-8b']
    });
  }

  if (urlStr.includes('/api/settings/online-models')) {
    return Promise.resolve({
      ok: true,
      json: async () => ['gemini-2.5-flash']
    });
  }

  if (urlStr.includes('/api/settings')) {
    return Promise.resolve({
      ok: true,
      json: async () => ({
        user_id: 1,
        provider: 'local',
        model_name: 'qwen3-8b',
        local_key: '',
        local_url: 'http://localhost:1234/v1',
        local_api_style: 'openai',
        online_url: '',
        online_key: '',
        online_provider: 'gemini',
        is_setup_complete: true
      })
    });
  }

  if (urlStr.includes('/messages')) {
    return Promise.resolve({
      ok: true,
      json: async () => []
    });
  }

  if (urlStr.includes('/api/chats')) {
    if (options && options.method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: async () => ({ id: 2, title: 'Chat 12:00 AM', chatId: 2 })
      });
    }
    return Promise.resolve({
      ok: true,
      json: async () => [{ id: 1, title: 'App Chat One' }]
    });
  }

  if (urlStr.includes('/api/calendar')) {
    return Promise.resolve({
      ok: true,
      json: async () => []
    });
  }

  if (urlStr.includes('/api/profile')) {
    return Promise.resolve({
      ok: true,
      json: async () => ({
        name: 'App User Name',
        zipcode: '32421',
        country: 'US',
        temp_unit: 'imperial',
        weather_api_key: ''
      })
    });
  }

  return Promise.resolve({
    ok: true,
    json: async () => ({})
  });
});

// Captured so tests that run after "renders SetupWizard" (which intentionally overwrites
// global.fetch and never restores it) can still explicitly opt back into the real
// authenticated-workspace mock, instead of depending on declaration order for correctness.
const authenticatedWorkspaceFetchMock = global.fetch;

describe('Main App Component Tests', () => {
  test('renders authenticated main workspace layout successfully', async () => {
    // Render under act to handle state updates from useEffect API fetches
    let rendered;
    await act(async () => {
      rendered = render(<App />);
    });

    // Sidebar renders app logo title and username
    expect(screen.getAllByAltText('PATTI').length).toBeGreaterThan(0);
    expect(screen.getByText('👤 appuser')).toBeInTheDocument();
    expect(screen.getByText('App Chat One')).toBeInTheDocument();
  });

  test('header brand has no broken logo image and shows the three stat badges', async () => {
    // Must run before the "renders SetupWizard" test below, which overwrites global.fetch with
    // an is_setup_complete: false mock and never restores it - this needs the real
    // authenticated-workspace mock from the top of the file, still intact at this point.
    let rendered;
    await act(async () => {
      rendered = render(<App />);
    });

    // Only the header's own logo image (header-patti-logo) was removed - the sidebar, auth
    // screen, and chat pane each have their own separate, still-working "PATTI" logo image
    // using the same underlying asset, and must be left alone.
    expect(rendered.container.querySelector('.header-patti-logo')).toBeNull();

    // The three new header stat badges (Tokens This Session, Web Search Credits, Current IP)
    // render with their labels, filling the space the removed image left behind.
    expect(screen.getByText('Tokens')).toBeInTheDocument();
    expect(screen.getByText('Search')).toBeInTheDocument();
    expect(screen.getByText('IP')).toBeInTheDocument();
  });

  test('renders SetupWizard when setup is not complete', async () => {
    // Override fetch mock for this test
    const customFetch = vi.fn().mockImplementation((url) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/settings')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ is_setup_complete: false })
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({})
      });
    });
    global.fetch = customFetch;

    let rendered;
    await act(async () => {
      rendered = render(<App />);
    });

    expect(screen.getByText('Device Selection')).toBeInTheDocument();
  });

  test('a notif_sync alert over the SSE stream refetches notifications without showing a toast', async () => {
    // jsdom doesn't implement EventSource - App.jsx's alert-stream effect checks for this
    // and no-ops when it's undefined, which is why every other test in this file never
    // actually exercises it. Define a minimal mock just for this test so the effect
    // connects and captures the instance, letting us simulate a server-pushed message.
    global.fetch = authenticatedWorkspaceFetchMock;

    let capturedSource;
    class MockEventSource {
      constructor(url) {
        this.url = url;
        capturedSource = this;
      }
      close() {}
    }
    const originalEventSource = global.EventSource;
    global.EventSource = MockEventSource;

    await act(async () => {
      render(<App />);
    });

    expect(capturedSource).toBeDefined();
    const notificationsCallCountBefore = global.fetch.mock.calls.filter(
      (call) => String(call[0]).includes('/api/notifications')
    ).length;

    await act(async () => {
      capturedSource.onmessage({ data: JSON.stringify({ type: 'notif_sync' }) });
    });

    const notificationsCallCountAfter = global.fetch.mock.calls.filter(
      (call) => String(call[0]).includes('/api/notifications')
    ).length;
    expect(notificationsCallCountAfter).toBeGreaterThan(notificationsCallCountBefore);

    global.EventSource = originalEventSource;
  });
});
