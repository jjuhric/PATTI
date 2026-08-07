# PATTI — Implementation Plan & Handoff

This document is written to be handed to any capable LLM coding assistant (Claude, Gemini,
ChatGPT, etc.) as a self-contained brief. It explains what PATTI is, what was just completed,
and exactly what remains — in the order it should be done.

**How to use this document:** paste it (or point the assistant at it) along with repository
access, then say: *"Read docs/IMPLEMENTATION_PLAN.md and carry out Phase 3."* (Phases 1 and 2
are done — see their sections for what shipped and what's still open within them.) Each phase
is independently shippable and lists its own acceptance criteria.

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

The loop itself lives in `runAgentLoop` in `backend/services/agent_loop.js` (moved from
`backend/ai.js`, which is now a thin re-exporting facade — see §3). Worker agents run via
`runWorkerAgent` in `backend/utils/agents.js`. Provider request-building (endpoint/header/body
per apiStyle) lives in `backend/llm/provider_config.js`, used by every LLM-calling function.

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
tests**.

---

## 3. Phase 1 — Refactor `backend/ai.js` — ✅ DONE

Completed in branch `feature/ai-refactor-and-provider-parity` (commits `3e93c91`, `ab15f03`,
`05ff80e`, `7fba825`). `ai.js` went from ~1723 lines to a **77-line facade**. Every import site
(`routes/chat.js`, `services/chat_stream_handler.js`, `utils/briefing.js`, and every test) still
does `require('./ai')` / `require('../ai')` and gets the same five exports — none needed to
change.

| File | Responsibility |
|---|---|
| `backend/llm/provider_config.js` | Endpoint/header/body construction for every apiStyle (openai, lm-studio, anthropic, local-gemini), shared by all six LLM-calling functions |
| `backend/llm/local_stream.js` | `callLocalLLMStream` + timeout/retry-backoff constants |
| `backend/llm/gemini_stream.js` | `callGeminiStream` |
| `backend/services/interceptors.js` | The six pure predicate functions that decide whether a message bypasses the Supervisor loop (`isGoogleHomeDeviceRequest`, `isAgentInfoRequest`, `isUserInfoRequest`, `isSendMessageCommand`, `isIpOnlyMessage`, `stripSendMessagePrefix`) |
| `backend/services/agent_loop.js` | `runAgentLoop` itself — the Supervisor/worker delegation loop and the stateful interceptor handler bodies |
| `backend/ai.js` | Facade re-exporting the above, plus `generateGreetingAndSave`/`cleanAgentResponse`/`processAgentTurn` which stayed put (small, self-contained) |

**One deliberate scope-down**, stated here so it isn't mistaken for an oversight: the
interceptor **handler bodies** (DB lookups, tool dispatch, response generation for Send-Message,
Google Home, and Personal Info) were moved as-is into `agent_loop.js` rather than further
decomposed into their own testable units the way the *predicates* were. They're deeply coupled
to `runAgentLoop`'s full closure (settings, history, streaming callbacks) and none of them had
any pre-existing test coverage to diff against — decomposing them further is real, valuable,
lower-priority follow-up work, not something to rush alongside a live production refactor with
no safety net for that specific piece.

Verified: full suite green throughout (73 suites / 764 tests by the end — the increase over the
661 baseline is new tests added alongside the refactor: 44 for `provider_config`, 12 for
`local_stream`, 47 for `interceptors`), every relative `require()` in the moved code checked
with `require.resolve()`, and three live round trips against the real production LM Studio
backend (a plain `generateText` call, a `runAgentTurn` weather decision, and a full
`runAgentLoop` run through the Personal Info Interceptor → `system_specialist` →
`host_machine` → streamed final response).

### Fixed along the way

- **`num_ctx` regression**: a merge (`f95d8c3`, PATTI Client) had silently reverted the local
  context window from 32768 back to 24576 in all six call sites, undoing yesterday's fix for a
  real "LLM Error: 400" context-overflow crash. Restored to 32768 everywhere.
- **Two missing local-gemini code paths**: `runAgentResponse` and `runSupervisorTurn`
  (`backend/utils/agents.js`) had no `local-gemini` branch in either endpoint resolution or body
  construction — a local-gemini-configured server would have received a plain openai-shaped
  request at the wrong path. Both now get it for free by going through the shared resolver.

### Remaining follow-up (not done, not urgent)

Decomposing the interceptor handler bodies described above, if desired. Approach: give each
handler (send-message dispatch, Google Home dispatch, personal-info dispatch) its own function
in `agent_loop.js` or a sibling file, threading through only the specific pieces of `settings`/
callbacks each one actually uses rather than the whole closure — then it's straightforward to
unit test each with mocked `db`/tool calls. Do this only if you're touching that code anyway for
another reason; it's cleanup, not a bug.

---

## 4. Phase 2 — Online-model parity audit — ✅ DONE (the audit; see below for what's left)

**Original finding:** provider handling was implemented six separate times (not three — the
audit undercounted `runSupervisorTurn` and `runAgentResponse`) and had drifted:

- ~~`num_ctx: 24576` vs the documented 32768~~ — **fixed**, see Phase 1.
- ~~`runAgentResponse`/`runSupervisorTurn` missing `local-gemini` support~~ — **fixed**, see
  Phase 1.
- `max_tokens`: **not fully reconciled, and intentionally so.** Anthropic's `max_tokens` really
  is 1024 in `runAgentTurn`/`runSupervisorTurn` (short JSON decisions) vs 4096 in
  `generateTextRaw` (long-form content generation) — that's a legitimate difference in purpose,
  not drift, and forcing them equal would be the actual regression. What changed: all six call
  sites now express their token limits as an explicit `maxTokensOnline` parameter to
  `buildBody()` instead of six independent inline ternaries, so the *values* stayed exactly what
  they were but the *mechanism* for setting them is now one function instead of six.
- `response_format`/`jsonMode`: now an explicit parameter passed by each caller (`true` for the
  three JSON-decision functions, unset for `generateTextRaw` and the streaming callers) — same
  behavior as before, now visible as a parameter instead of an inline conditional.
- Token-usage logging duplication: **not centralized.** Each call site still logs its own
  `token_usage` row with its own fallback estimator. This is real remaining duplication but
  lower-risk/lower-value than the request-building unification, and was left out of this pass —
  see "Remaining work" below.

**What "one code path" now means concretely:** `backend/llm/provider_config.js` exports
`resolveTarget`, `resolveEndpoint`, `buildHeaders`, `buildBody`, `buildStreamBody`, and
`extractResponseText`. Every one of the six LLM-calling functions (`callLocalLLMStream`,
`runAgentTurn`, `runAgentResponse`, `runSupervisorTurn`, `generateTextRaw`, plus `callLMStudio`
partially — see below) now calls into these instead of maintaining its own copy of the
endpoint-resolution `try/catch` or the per-style body shape.

**`callLMStudio` in `backend/utils/lmstudio.js` was deliberately left alone.** It's
axios-based (not `fetch`) with its own sampling params (`top_p`) not modeled by
`buildBody`, and it's only reachable through `processAgentTurn`/`cleanAgentResponse` in
`ai.js`, which are themselves dead code (nothing calls them outside their own tests — verify
with `git grep -rn "processAgentTurn\|cleanAgentResponse" backend --include=*.js` before
touching, in case that's changed). It did get the `num_ctx` fix directly.

### Remaining work

1. **Centralize token-usage logging.** Six near-identical `db.run('INSERT INTO token_usage...')`
   blocks remain, differing only in their fallback token-count estimator when the provider
   doesn't report usage. Extract a `logTokenUsage(db, userId, modelName, providerType,
   tokenCount)` helper and a `estimateTokens(text)` helper; have each caller compute its own
   count (they genuinely differ: streaming sums `fullResponseText`, one-shot calls know the full
   prompt+response) and call the shared logger.
2. **Provider matrix test.** `backend/tests/provider_config.test.js` (44 tests) and
   `backend/tests/local_stream.test.js` (12 tests) together already cover every apiStyle's
   endpoint/header/body shape and the streaming retry orchestration — this satisfies the intent
   of "one test asserting shape per provider combination" without a separate consolidated table.
   Only build a literal matrix test if you want the seven combinations enumerated in one place
   for readability; it would be testing already-covered ground.
3. **Live online-provider verification.** All live verification so far has been against the
   local LM Studio backend (the only provider actually configured on this machine). If you have
   a real Anthropic/OpenAI/Gemini key, configure it in Settings and exercise: a plain chat turn,
   a weather request, a movie request, and a document generation. They should behave identically
   to local except for the intentional `max_tokens` differences above.

---

## 5. Phase 3 — Extend the extractor, and Movie/TV follow-ups

These are independent and can be done in any order. Lower risk than Phases 1–2.

### 3a. Route `web_search_tool` through the extractor — DONE

Already implemented (commit `f38380a`, predates the 2026-08-03 review that flagged this as
BUG-14): `handleWebSearchTool` builds settings via `getExtractorSettings` (which calls
`buildSettingsForUser(db, userId)` and skips extraction when `llmIsBusy()`), and
`readUrlContent` routes every scrape through `readPageForRequest` first, falling back to blind
truncation (`blindScrapeUrl`) only when settings are unavailable or extraction fails. Confirmed
stale in both this doc and `docs/REVIEW_2026-08-03.md` during the Phase 5 pass; both updated
rather than re-implementing something that already exists.

### 3b. Genuine "newly added to streaming" data

Current `whats_new` approximates "new on streaming" as *recently released titles that are
currently on a streaming service*. That is a reasonable proxy but it misses back-catalog
titles that just landed on a service. TMDB does not expose an "added to service" date.

Options, best first:
1. Snapshot provider availability per title in a new SQLite table on a daily job, then diff —
   this yields true "added in the last month" data and is fully self-hosted.
2. Use the extractor against a streaming-guide page for the month.

Option 1 is more work but is the only way to get this genuinely right.

### 3c. Make the agent dashboard self-updating — DONE

Implemented during the 2026-08-03 review's Phase 4 (tracked there as BUG-4/FEAT-5): added
`GET /api/agents` (`backend/routes/agents.js`, backed by `AGENT_PROMPTS`'s existing `ownKeys`
registry), and `monitor_dashboard/src/App.jsx` now fetches it instead of hardcoding a 21-entry
array, merging with a small `AGENT_PRESENTATION` icon/description map that has a sensible
default for anything missing. Both `getAgentStatus` comparison chains were replaced with the
two generic checks described below. Two *more* agents (`automation_handler`,
`graphics_engineer`) turned out to be missing on top of the six already known, confirming this
really was a recurring drift rather than a one-off.

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

Then restart the backend process via `backend/scripts/restart_patti_service.ps1` rather than a
bare `Stop-Process`/`Start-Process` pair — the task's launcher (`run-background.vbs`) will
otherwise just relaunch a bare process outside the task's own lifecycle tracking:

```powershell
powershell -ExecutionPolicy Bypass -File backend/scripts/restart_patti_service.ps1
```

**BUG-15, confirmed 2026-08-03, fixed 2026-08-06 (see `docs/REVIEW_2026-08-03.md`):** a bare
`Stop-ScheduledTask`/`Start-ScheduledTask` pair is not reliable on its own - `Stop-ScheduledTask`
does not actually kill the underlying `node.exe`, since `run-background.vbs`'s `WshShell.Run`
spawns it in a way that Task Scheduler's job-object cleanup doesn't reach. A bare
`Start-ScheduledTask` right after then launches a *second* `node.exe` that immediately crashes
with `EADDRINUSE` on port 3000, while the orphaned original silently keeps serving stale code.
`restart_patti_service.ps1` (used by both this manual procedure and `host_machine_tool.js`'s
`restart_service` action) closes that gap: it stops the task, explicitly finds and kills any
`node.exe` still running `backend/server.js`, waits a beat, then starts the task fresh. Verified
against production on 2026-08-06 - single clean process, no `EADDRINUSE`, no retry-loop noise.

If you ever need to do this fully by hand (e.g. the script itself won't run):

```powershell
Stop-ScheduledTask -TaskName "PATTI-Assistant"
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, CreationDate, CommandLine
Stop-Process -Id <the older PID> -Force
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName "PATTI-Assistant"
```

Verify: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/` returns `200`, and the
log shows `Express Backend running securely on port 3000` with no stderr, no `EADDRINUSE`.

### Supervision

A Windows Scheduled Task (`PATTI-Assistant`) is registered and running — `patti-cli.js` set
this up already; there is no outstanding gap here. It restarts PATTI automatically after a
crash (`run-background.vbs`'s loop) or a reboot. `host_machine_tool`'s `restart_service` action
now runs `restart_patti_service.ps1` (see above) instead of a bare
`Stop-ScheduledTask`/`Start-ScheduledTask` pair, so PATTI's own "restart yourself" capability no
longer races two processes for port 3000. BUG-15 closed.

### Logs

`logs/app-YYYY-MM-DD.log`, rotated at 20 MB with numbered suffixes (`.1`, `.2`, …). **The
highest-numbered suffix is the newest**, not the base file — check modification times before
assuming the base file is current.

---

## 7. Guardrails

- **Never commit secrets.** `.env` is gitignored; `.env.example` documents variables with empty
  values. Scan staged diffs before committing.
- **The TMDB token in `.env` was pasted into a chat transcript** and should be rotated at TMDB.
- **Do not regress the test baseline** (100 backend suites / 1175 tests, 20 frontend suites /
  118 tests, as of the `docs/REVIEW_2026-08-03.md` Phase 0/1 security work landing — verified by
  running both suites directly, not carried over from an earlier note). If a test fails after a
  change, determine whether the test encoded old buggy behavior before editing it — and say so
  explicitly in the commit message when you do.
- **Local-first is not optional.** Any feature that only works with an online provider is a
  regression of the project's core goal.
- **Mind LLM call budgets.** On this hardware a single local generation takes 30–60 seconds.
  Any feature that issues N LLM calls for one user request needs an explicit cap and a
  busy-check that degrades gracefully.
