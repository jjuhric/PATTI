# PATTI — Implementation Plan & Handoff

This document is written to be handed to any capable LLM coding assistant (Claude, Gemini,
ChatGPT, etc.) as a self-contained brief. It explains what PATTI is, what was just completed,
and exactly what remains — in the order it should be done.

**How to use this document:** paste it (or point the assistant at it) along with repository
access, then say: *"Read docs/IMPLEMENTATION_PLAN.md and carry out Phase 1."* Each phase is
independently shippable and lists its own acceptance criteria.

---

## 1. Orientation

### What PATTI is

PATTI (Professional Artificial Text and Type Intelligence) is a **self-hosted, local-first AI
assistant**. It runs primarily against a local LLM served by LM Studio, with optional fallback
to online providers (Gemini, OpenAI, Anthropic). It is not a wrapper around a hosted API — the
local path is the primary path, and every feature must work there.

### Deployment topology

| Role | Hardware | Notes |
|---|---|---|
| **Host** | Windows desktop | Runs the LLM and the full app. This is the authoritative node. |
| **Node** | ESP32-CYD devices | Sensor/actuator edge clients. |
| **Client** | Raspberry Pi | Full app, but borrows the host's LLM via host-wins arbitration. |

Host-wins arbitration lives in `backend/services/ai_queue.js`: the host always preempts a
client request. Anything that consumes the LLM must go through this queue.

### Stack

- **Backend:** Node.js + Express, SQLite (`backend/db.js`, schema in `backend/schema.sql`)
- **Frontend:** React + Vite (`frontend/`)
- **Tests:** Jest (backend), Vitest (frontend), Playwright (E2E)
- **CI:** `.github/workflows/ci.yml` — already runs all three on every PR

### Architecture: how a chat turn flows

Understanding this is essential before touching anything.

1. **Communication Specialist (MODE 1)** — `backend/utils/agents/communication_specialist.js`.
   Translates the user's message into a structured "Project Idea" JSON.
2. **Supervisor** — `backend/utils/agents/supervisor.js`. Reads the Project Idea and decides
   which specialist agent to delegate to. Loops up to `maxToolCalls` turns.
3. **Worker agent** — one of `backend/utils/agents/*.js`. Chooses a tool and parameters.
4. **Tool** — one of `backend/tools/*.js`. Does the actual work and returns markdown.
5. **Communication Specialist (MODE 2)** — same file, other half of the prompt. Formats the
   gathered tool output into the final user-facing reply.

The loop itself lives in `runAgentLoop` in `backend/ai.js`. Worker agents run via
`runWorkerAgent` in `backend/utils/agents.js`.

### Key conventions

- **Agent prompts are auto-discovered by filename.** `AGENT_PROMPTS` in
  `backend/utils/agents.js` is a `Proxy` that `require`s `./agents/<name>.js` on demand. To add
  an agent you create the prompt file, add a dispatcher branch, and add a supervisor registry
  entry. There is **no** database registration for built-in agents — the `agent_capabilities`
  table is only for dynamically installed custom tools.
- **Tools return markdown strings**, not objects. Any value placed in a markdown table cell
  must have `|` escaped or the row breaks.
- **Every LLM call must go through the queue.** Use `generateText` from
  `backend/utils/llm_text.js` for one-shot calls; it wraps `ai_queue`. Calling a provider
  directly will collide with in-flight chat requests, and most local servers only run one
  generation at a time.
- **Secrets live in the gitignored `.env`**, documented (with empty values) in `.env.example`.
  Never commit a real key.

### Commands

```bash
cd backend && npx jest --runInBand --forceExit     # backend tests
cd frontend && npx vitest run                       # frontend tests
cd frontend && npm run build                        # required before restarting production
```

Production currently runs as a bare `node backend/server.js` process from the repo root. See
§6 for the restart procedure and a known gap.

---

## 2. What was just completed (do not redo)

Delivered in PR #76, branch `feature/movie-tv-agent-and-hardening`:

- **Movie & TV agent** — `backend/tools/movie_tv_tool.js`,
  `backend/utils/agents/movie_tv_agent.js`. TMDB-backed, with actions `whats_new`, `upcoming`,
  `search`, `where_to_watch`. Rotten Tomatoes via the LLM extractor, Reddit via its public JSON
  API. Review enrichment is opt-in.
- **LLM-driven web extractor** — `backend/utils/web_extract.js`. Fetches a page, isolates the
  main content region, and has the LLM pull only what is relevant to the request.
- **Weather correctness** — partial days are labeled instead of being reported as full-day
  highs/lows; hourly fallback no longer mislabels 72 hours as 24; `weather_expert` now maps
  each question type to a fixed action.
- **Local LLM reliability** — 180s timeout, backoff before retry, 15-minute idle-unload window,
  all configurable via env vars.
- **Voice deprioritized** — narration yields whenever the LLM queue is busy or has waiters.
- **Supervisor loop fix** — turns after the first now state that results are already in hand.

Test baseline after this work: **70 backend suites / 661 tests**, **17 frontend suites / 96
tests**. Do not let these regress.

---

## 3. Phase 1 — Refactor `backend/ai.js`

**Why:** `ai.js` is ~1,700 lines mixing four unrelated responsibilities. It is the single
biggest obstacle to changing anything safely, and it is where provider-handling logic has
already drifted out of sync with `agents.js` and `llm_text.js` (see Phase 2).

**Risk:** high — every chat request flows through this file. This is why it was deliberately
kept out of PR #76.

### Ground rules

- **Pure move-and-rewire only.** No behavior changes, no "while I'm here" fixes. If you find a
  bug, note it and fix it in a *separate* commit with its own test.
- **One extraction per commit**, with the full backend suite green before moving on.
- The public exports of `ai.js` (`runAgentLoop`, `handleGoogleNewsTool`,
  `generateGreetingAndSave`, `cleanAgentResponse`, `processAgentTurn`) **must not change** —
  they are imported across routes, services, and tests. Keep `ai.js` as a thin facade that
  re-exports from the new modules.

### Target structure

| New file | Responsibility | Approx. source lines in `ai.js` |
|---|---|---|
| `backend/llm/local_stream.js` | `callLocalLLMStream` + timeout/backoff constants | 17–257 |
| `backend/llm/gemini_stream.js` | `callGeminiStream` | 260–321 |
| `backend/llm/provider_config.js` | `defaultOnlineBaseUrl`, endpoint/header/body construction shared by all callers | 12–16, plus the duplicated blocks inside `runAgentLoop` |
| `backend/services/interceptors.js` | Personal-info intercept and Google Home intercept | ~428–988 |
| `backend/services/agent_loop.js` | `runAgentLoop` core: supervisor loop, delegation, responder | ~990–1640 |
| `backend/ai.js` | Facade re-exporting the above | — |

### Order of work

1. **Extract `provider_config.js` first.** Endpoint/header/body construction is currently
   duplicated in at least three places (`callLocalLLMStream`, `runAgentTurn` in `agents.js`,
   `generateTextRaw` in `llm_text.js`). Write it to serve all three, but in this commit only
   wire up `ai.js`. Add unit tests covering each `apiStyle`: `openai`, `lm-studio`,
   `anthropic`, `local-gemini`.
2. **Extract the two stream callers.** Mechanical move. `local_stream.js` owns
   `LOCAL_LLM_TIMEOUT_MS`, `RETRY_BACKOFF_MS`, and `sleep`.
3. **Extract the interceptors.** These are two large `if` blocks near the top of
   `runAgentLoop` that short-circuit the whole loop. Give each a clear predicate function
   (`isPersonalInfoRequest`, `isSmartSpeakerCommand`) and unit-test the predicates directly —
   they are currently untested keyword matchers and are easy to get subtly wrong.
4. **Extract the agent loop.** The remainder.
5. **Reduce `ai.js` to a facade.** Confirm no import site anywhere needed to change.

### Acceptance criteria

- Backend suite still **661+ passing**, no skips added.
- `git grep -n "require.*ai')" backend/` shows no import site changed.
- `wc -l backend/ai.js` under 100 lines.
- A real chat turn, a weather request, and a movie request all verified working against the
  live app (see §6).

---

## 4. Phase 2 — Online-model parity audit

**Why:** PATTI is meant to work with online models as a first-class option, but provider
handling is implemented three separate times and they have drifted. Concretely, the following
already differ between code paths:

- `max_tokens` is set for online providers but omitted for local in some paths and not others.
- `num_ctx: 24576` is passed only for `lm-studio` style, and only in some callers — while the
  documented context window was raised to 32768 (commit `0f3897d`). **These disagree.**
- `response_format: { type: "json_object" }` is set in `runAgentTurn` but not in
  `generateTextRaw`, so structured-output enforcement depends on which path you're on.
- Anthropic's `max_tokens` is 1024 in `runAgentTurn` but 4096 in `generateTextRaw`.
- Token-usage logging is duplicated with slightly different fallback estimators in three files.

### Work

1. **Land Phase 1's `provider_config.js` first** — this phase is much cheaper afterwards.
2. Migrate `runAgentTurn` (`backend/utils/agents.js`) and `generateTextRaw`
   (`backend/utils/llm_text.js`) onto the shared builder.
3. Reconcile every divergence above. Each decision needs a comment stating *why* that value.
   Resolve the `num_ctx` / 32768 contradiction explicitly — pick one and make it a named
   constant used everywhere.
4. Centralize token-usage logging into one helper.
5. Build a provider matrix test: for each of `local/openai`, `local/lm-studio`,
   `local/anthropic`, `local/local-gemini`, `online/gemini`, `online/openai`,
   `online/anthropic`, assert the endpoint, headers, and body shape.

### Manual verification

With a real online key configured in Settings, exercise: a plain chat turn, a weather request
(worker-agent path), a movie request (tool + optional extractor path), and a document
generation (`generateText` path). All four must behave identically to local.

### Acceptance criteria

- One code path builds every provider request.
- Provider matrix test passes for all seven combinations.
- No remaining `defaultOnlineBaseUrl` duplicate definitions (`git grep -c defaultOnlineBaseUrl`
  should show one definition).

---

## 5. Phase 3 — Extend the extractor, and Movie/TV follow-ups

These are independent and can be done in any order. Lower risk than Phases 1–2.

### 3a. Route `web_search_tool` through the extractor

`backend/tools/web_search_tool.js` still does blind truncation — it scrapes a page, strips
tags, and cuts at 3000 characters, which frequently captures navigation and cookie banners
rather than content. Replace that path with `readPageForRequest` from `utils/web_extract.js`.

Two constraints:
- The tool's signature is `handleWebSearchTool(db, userId, query)` — it has no LLM settings.
  Build them with `buildSettingsForUser(db, userId)`.
- **Budget the calls.** Extraction is one LLM call per page. Cap at 2–3 pages per search, and
  skip extraction entirely when `ai_queue` is busy (mirror `llmIsBusy()` in
  `backend/utils/tts_narration.js`), falling back to truncation. A search that fans out to
  eight pages would stall the assistant for minutes.

### 3b. Genuine "newly added to streaming" data

Current `whats_new` approximates "new on streaming" as *recently released titles that are
currently on a streaming service*. That is a reasonable proxy but it misses back-catalog
titles that just landed on a service. TMDB does not expose an "added to service" date.

Options, best first:
1. Snapshot provider availability per title in a new SQLite table on a daily job, then diff —
   this yields true "added in the last month" data and is fully self-hosted.
2. Use the extractor against a streaming-guide page for the month.

Option 1 is more work but is the only way to get this genuinely right.

### 3c. Make the agent dashboard self-updating

**This is a recurring bug, not a one-off.** The agent roster shown in the monitor dashboard is a
hardcoded `agents` array in `monitor_dashboard/src/App.jsx`, and "is this agent active?" is a
hand-written chain of string comparisons in `getAgentStatus` — in *two* places (one matching
SSE thought text, one matching the reported agent/tool name).

Adding a backend agent therefore requires three separate frontend edits that nothing enforces.
When they are missed the agent silently never appears and never lights up. This had already
drifted badly: six agents were missing (`movie_tv`, `deep_research`, `deep_research_pro`,
`course_builder`, `document_generator`, `document_formatter`) before being added by hand.

The fix is a single source of truth:

1. Add a backend endpoint (for example `GET /api/agents`) that enumerates agent prompt files
   from `backend/utils/agents/`, returning each agent's canonical name, display name,
   description, and the tool names it dispatches to. `AGENT_PROMPTS`'s `ownKeys` trap in
   `backend/utils/agents.js` already reads that directory and can back this.
2. Have the dashboard fetch that list instead of hardcoding it, keeping a small
   name-to-icon map with a sensible default so a new agent still renders without a frontend
   change.
3. Replace both `getAgentStatus` comparison chains with one match against the canonical name
   returned by the endpoint.

Watch one subtlety when matching by substring: `deep_research_pro_agent` and
`deep_research_agent` are distinct agents whose names overlap. Exact-match on canonical names
avoids this class of bug entirely, which is another reason to prefer the registry over
substring heuristics.

### 3d. Favorite services

`users.favorite_teams` already exists for sports. Add an analogous
`users.streaming_services` column so `whats_new` filters to services the user actually pays
for, instead of all eight majors. Follow the existing encrypted-column and profile-UI patterns.

---

## 6. Operations

### Restarting production

Frontend changes require a rebuild first — production serves the built bundle from
`frontend/dist`, not source:

```bash
cd frontend && npm run build
```

Then restart the backend process:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, CommandLine
Stop-Process -Id <pid> -Force
Start-Process -FilePath "node" -ArgumentList "backend/server.js" -WorkingDirectory "C:\Users\jjuhr\OneDrive\Documents\private_ai" -WindowStyle Hidden
```

Verify: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/` returns `200`, and the
log shows `Express Backend running securely on port 3000` with no stderr.

### Known gap: no supervision

**PATTI currently runs as a bare `node` process with nothing supervising it.** It will not
restart after a crash or a reboot. `patti-cli.js` can register a proper Windows scheduled task
(`PATTI-Assistant`), and `backend/tools/host_machine_tool.js` already assumes that task exists
for self-restart — but no such task is registered on this machine, so PATTI's own "restart
yourself" capability silently falls through to a service-restart path that also does not exist.

Fixing this is worth doing early:

```bash
node patti-cli.js
```

Verify with `Get-ScheduledTask -TaskName "PATTI-Assistant"`, then confirm
`host_machine_tool`'s `restart_service` action actually works end to end.

### Logs

`logs/app-YYYY-MM-DD.log`, rotated at 20 MB with numbered suffixes (`.1`, `.2`, …). **The
highest-numbered suffix is the newest**, not the base file — check modification times before
assuming the base file is current.

---

## 7. Guardrails

- **Never commit secrets.** `.env` is gitignored; `.env.example` documents variables with empty
  values. Scan staged diffs before committing.
- **The TMDB token in `.env` was pasted into a chat transcript** and should be rotated at TMDB.
- **Do not regress the test baseline** (661 backend / 96 frontend). If a test fails after a
  change, determine whether the test encoded old buggy behavior before editing it — and say so
  explicitly in the commit message when you do.
- **Local-first is not optional.** Any feature that only works with an online provider is a
  regression of the project's core goal.
- **Mind LLM call budgets.** On this hardware a single local generation takes 30–60 seconds.
  Any feature that issues N LLM calls for one user request needs an explicit cap and a
  busy-check that degrades gracefully.
