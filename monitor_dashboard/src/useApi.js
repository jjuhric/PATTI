import { useMemo, useCallback } from 'react';

/**
 * FEAT-9 (docs/REVIEW_2026-08-03.md): every fetch call across App.jsx re-derives the same
 * boilerplate by hand - attach `Authorization: Bearer <token>`, set
 * `Content-Type: application/json` when there's a body, check `res.ok`, parse JSON, and
 * try/catch network failures. This hook centralizes exactly that, and nothing more: no
 * caching, no retries, no loading-state management - callers still own their own useState
 * for that, since how each call site reacts to loading/success/failure genuinely differs
 * (some show a toast, some fail silently, some chain a follow-up fetch).
 *
 * Returns a consistent `{ ok, status, data, error }` shape instead of `res.ok`/`res.json()`,
 * so a failed request never needs a second `res.json()` call just to read the error body.
 *
 * This is a duplicate of frontend/src/hooks/useApi.js, not a shared import - monitor_dashboard
 * is a separate Vite app with its own node_modules and no shared workspace (see BUG-5,
 * docs/REVIEW_2026-08-03.md), same as the other files already duplicated between the two apps
 * (CustomAlertModal.jsx, RpiTerminalModal.jsx, TokenCountView.jsx, TokenChart.jsx). Keep the two
 * copies in sync by hand until that structural de-duplication happens.
 */
export function useApi(token) {
  const request = useCallback(async (url, { method = 'GET', body, headers, signal } = {}) => {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal
      });

      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        // Empty or non-JSON body (e.g. a 204, or a plain-text error page) - not itself an error.
      }

      if (!res.ok) {
        return { ok: false, status: res.status, data, error: (data && data.error) || `Request failed (${res.status})` };
      }
      return { ok: true, status: res.status, data, error: null };
    } catch (err) {
      return { ok: false, status: 0, data: null, error: err.message || 'Network error' };
    }
  }, [token]);

  return useMemo(() => ({
    get: (url, options) => request(url, { ...options, method: 'GET' }),
    post: (url, body, options) => request(url, { ...options, method: 'POST', body }),
    put: (url, body, options) => request(url, { ...options, method: 'PUT', body }),
    delete: (url, options) => request(url, { ...options, method: 'DELETE' })
  }), [request]);
}
