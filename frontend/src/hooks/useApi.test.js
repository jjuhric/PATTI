import { describe, test, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useApi } from './useApi';

function mockFetchOnce({ ok = true, status = 200, json = {} } = {}) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => json
  });
}

describe('useApi', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('get attaches the Authorization header and returns { ok, status, data }', async () => {
    mockFetchOnce({ json: { foo: 'bar' } });
    const { result } = renderHook(() => useApi('my-token'));

    const response = await result.current.get('/api/nodes');

    expect(global.fetch).toHaveBeenCalledWith('/api/nodes', expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ Authorization: 'Bearer my-token' })
    }));
    expect(response).toEqual({ ok: true, status: 200, data: { foo: 'bar' }, error: null });
  });

  test('omits the Authorization header entirely when there is no token', async () => {
    mockFetchOnce({ json: { version: '1.0' } });
    const { result } = renderHook(() => useApi(''));

    await result.current.get('/api/version');

    const [, options] = global.fetch.mock.calls[0];
    expect(options.headers).not.toHaveProperty('Authorization');
  });

  test('post JSON-encodes the body and sets Content-Type', async () => {
    mockFetchOnce({ status: 201, json: { id: 5 } });
    const { result } = renderHook(() => useApi('tok'));

    const response = await result.current.post('/api/chats', { title: 'New Chat' });

    expect(global.fetch).toHaveBeenCalledWith('/api/chats', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ title: 'New Chat' }),
      headers: expect.objectContaining({ 'Content-Type': 'application/json', Authorization: 'Bearer tok' })
    }));
    expect(response).toEqual({ ok: true, status: 201, data: { id: 5 }, error: null });
  });

  test('put and delete use the right HTTP method', async () => {
    mockFetchOnce({ json: {} });
    const { result } = renderHook(() => useApi('tok'));

    await result.current.put('/api/chats/1', { title: 'Renamed' });
    expect(global.fetch.mock.calls[0][1].method).toBe('PUT');

    await result.current.delete('/api/chats/1');
    expect(global.fetch.mock.calls[1][1].method).toBe('DELETE');
    // A bodyless DELETE never sets Content-Type - nothing to encode.
    expect(global.fetch.mock.calls[1][1].headers).not.toHaveProperty('Content-Type');
  });

  test('a non-ok response surfaces the server-provided error message without a second res.json() call', async () => {
    mockFetchOnce({ ok: false, status: 400, json: { error: 'Node with this IP address and port is already registered' } });
    const { result } = renderHook(() => useApi('tok'));

    const response = await result.current.post('/api/nodes', { ip_address: '1.2.3.4' });

    expect(response).toEqual({
      ok: false,
      status: 400,
      data: { error: 'Node with this IP address and port is already registered' },
      error: 'Node with this IP address and port is already registered'
    });
  });

  test('a non-ok response with no JSON error body falls back to a generic message', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => { throw new Error('not json'); }
    });
    const { result } = renderHook(() => useApi('tok'));

    const response = await result.current.get('/api/whatever');
    expect(response.ok).toBe(false);
    expect(response.data).toBeNull();
    expect(response.error).toBe('Request failed (500)');
  });

  test('a network failure (fetch itself rejects) is caught and normalized', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
    const { result } = renderHook(() => useApi('tok'));

    const response = await result.current.get('/api/nodes');
    expect(response).toEqual({ ok: false, status: 0, data: null, error: 'Failed to fetch' });
  });

  test('a response with no body at all (e.g. 204) still resolves with data: null, not an error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => { throw new Error('Unexpected end of JSON input'); }
    });
    const { result } = renderHook(() => useApi('tok'));

    const response = await result.current.delete('/api/nodes/1');
    expect(response).toEqual({ ok: true, status: 204, data: null, error: null });
  });

  test('custom headers/signal are passed through and merged with the auto-added ones', async () => {
    mockFetchOnce({ json: {} });
    const { result } = renderHook(() => useApi('tok'));
    const controller = new AbortController();

    await result.current.get('/api/foo', { headers: { 'X-Custom': '1' }, signal: controller.signal });

    const [, options] = global.fetch.mock.calls[0];
    expect(options.headers).toMatchObject({ Authorization: 'Bearer tok', 'X-Custom': '1' });
    expect(options.signal).toBe(controller.signal);
  });
});
