# PATTI — Frontend

A single-page React app (built with Vite) — the chat interface, field-node dashboard, and every settings/config modal.

This file is deliberately short. The full architecture, the SSE streaming protocol, and the design system are documented once, in the project-level **[README](../README.md)** and the **[Wiki](https://github.com/jjuhric/PATTI/wiki)** — keeping that content in one place instead of duplicated here is what keeps it from going stale.

---

## Running this package

From the repo root (see the [top-level README](../README.md) for full first-run setup via `patti-cli.js`):

```bash
cd frontend
npm install
npm run dev            # Vite dev server with HMR
npm run build           # production build
npm test                # Vitest, src/**/*.test.jsx
npm run test:coverage   # coverage report
```

In normal use the backend serves the built frontend directly (`backend/server.js` serves `frontend/dist`) — `npm run dev` is only needed while actively working on frontend code.

## Where to start reading

* **`src/main.jsx`** — React entry point.
* **`src/App.jsx`** — top-level state: auth, active chat, settings, which panel is shown, the SSE alert-stream listener.
* **`src/components/ChatPane.jsx`** — the chat interface: streamed responses, collapsible "Agent Plan & Internal Thoughts," HITL approval prompts.
* **`src/components/NotificationBell.jsx`** — the durable-notification bell in the header.
* **`src/components/SettingsModal.jsx`**, **`SetupWizard.jsx`**, **`ProfileModal.jsx`** — configuration modals.
* **`src/index.css`** — the design system: CSS custom properties for the light/dark theme palette, plus shared component classes (`.btn`/`.btn-secondary`/`.btn-sm`, `.badge`) rather than one-off inline styles.

See **[Codebase Documentation](https://github.com/jjuhric/PATTI/wiki/Codebase-Documentation)** in the wiki for a guided tour of every component and how the SSE streaming protocol works end to end.
