# PATTI — Backend

Node.js/Express server: HTTP API, the multi-agent orchestration engine, SQLite storage, background daemons, and every "tool" an agent can call.

This file is deliberately short. The full architecture (agent delegation pipeline, host/PATTI-Client arbitration, sandboxing, technology choices and why), the complete REST API surface, and the DB schema are documented once, in the project-level **[README](../README.md)** and the wiki's **[Architecture](https://github.com/jjuhric/PATTI/wiki/Architecture)** and **[Codebase Documentation](https://github.com/jjuhric/PATTI/wiki/Codebase-Documentation)** pages — keeping that content in one place instead of duplicated here is what keeps it from going stale.

---

## Running this package

From the repo root (see the [top-level README](../README.md) for full first-run setup via `patti-cli.js`):

```bash
cd backend
npm install
npm test              # Jest, backend/tests/
npm run test:coverage # coverage report
```

The server itself is started via `node server.js` (or `node patti-cli.js` from the repo root, which manages this as a background service).

## Where to start reading

* **`server.js`** — entry point; wires up Express, mounts every router, starts the background daemons.
* **`db.js`** / **`schema.sql`** — SQLite connection setup and the full relational schema.
* **`services/agent_loop.js`** — the core multi-agent supervisor/delegation loop for a live chat turn.
* **`utils/agents.js`** + **`utils/agents/`** — the worker-agent execution engine and one system-prompt file per agent.
* **`routes/`** — one Express router per API surface (auth, chat, settings, notifications, ...).
* **`tools/`** — one `handleXTool(...)` function per agent capability.

See **[Codebase Documentation](https://github.com/jjuhric/PATTI/wiki/Codebase-Documentation)** in the wiki for a guided, file-by-file tour of all of the above.
