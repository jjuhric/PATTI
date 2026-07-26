# PATTI — Private AI Assistant (v5.4.0)

<p align="center">
  <img src="assets/logo_text.jpg" alt="PATTI Logo" width="380" />
</p>

[![Wiki](https://img.shields.io/badge/wiki-available-brightgreen)](https://github.com/[USER]/PATTI/wiki)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-active-success)](README.md)

**PATTI** (Professional Artificial Text and Type Intelligence) is a local-first, multi-agent personal AI assistant. A **Supervisor Agent** reads each request and routes it to a specialized worker agent — weather, calendar, local system control, web search, your own document vault, code editing, and more — rather than handling everything in one giant, error-prone prompt. It runs primarily against a **local LLM** (LM Studio or Ollama) on your own hardware, with optional, explicitly opt-in fallback to an online provider (Gemini, OpenAI, or Anthropic Claude) if you choose to add a key in Settings.

New to the codebase or teaching from it? The **[Wiki](https://github.com/[USER]/PATTI/wiki)** is written as a full explainer — it covers not just how to run PATTI, but *why* it's built the way it is, in enough depth to learn from as a real-world example of a multi-agent system, a REST API, an auth flow, and a local vector search pipeline. This README is deliberately just the summary.

---

## What it does

- **Multi-agent orchestration** — a Supervisor Agent classifies each request and delegates to the right specialist (weather, calendar, system control, developer/coder, memory, document vault, sports/news, and more).
- **Local-first, cloud-optional** — defaults entirely to a local LLM; online providers are never used unless you explicitly enable them in Settings and supply your own API key.
- **Human-in-the-loop safety** — before running a shell command or writing a file, the assistant pauses and asks for your explicit approval.
- **Local semantic memory (RAG)** — uploaded documents and stored memories are embedded locally (no data leaves your machine) and retrieved by meaning, not just keyword match.
- **Local device mesh** — a Windows/Linux main host coordinates lightweight Raspberry Pi and ESP32 field nodes over MQTT, and can discover and cast text-to-speech announcements to Google Nest/Cast speakers on the LAN.
- **PATTI Client support** — pair a second full PATTI instance (its own UI, its own chat history, e.g. on a Raspberry Pi) to the Host so it can share the Host's LLM. Host-wins arbitration means the Host's own requests are never delayed by a client, and a client mid-generation is cleanly interrupted if the Host needs the LLM.
- **Dynamic tool registry** — new tools can be authored, tested, and mounted into the running agent system at runtime without a rebuild.
- **Real document generation** — ask for a report, a spreadsheet, a slide deck, or a full multi-lesson course, and PATTI writes the content and saves a real `.pdf`/`.docx`/`.xlsx`/`.pptx` on disk (auto-polished with proper structure and Wikimedia images). It can also reformat a document you've already uploaded into a cleaner new copy, without touching the original.

---

## Architecture at a glance

```mermaid
graph TB
    subgraph Client ["Client Device (Web Browser)"]
        UI["React Web UI"]
        SSE_Conn["Server-Sent Events Reader"]
    end

    subgraph MainHost ["Main Host (Windows/Linux)"]
        WebServer["Express HTTP Web Server (Port 3000)"]
        Database[("SQLite database.db")]
        Coord["ReAct Coordinator (ai.js)"]
        Bridge["Agent Bridge Router"]
        LLM["Local/Online LLM Core"]
        MQTT["MQTT Broker (Mosquitto)"]
        mDNS["mDNS Scan Daemon"]
    end

    subgraph FieldNodes ["Field Nodes (Local Network)"]
        RPi["Raspberry Pi (Zero 2W / 4 / 5)"]
        ESP["ESP32 MicroPython Nodes"]
        Nest["Google Nest Mini Speakers"]
    end

    UI -->|REST API Requests| WebServer
    SSE_Conn <-->|SSE Stream /api/chat/send| WebServer
    WebServer <--> Database
    WebServer <--> Coord
    RPi -->|MQTT Status Heartbeat| MQTT
    ESP -->|MQTT Status Heartbeat| MQTT
    mDNS -.->|Pings via _googlecast._tcp.local| Nest
    Nest -.->|Reports IP| mDNS
    Coord -->|Delegates to Remote Node| Bridge
    Bridge -->|HTTP REST Control| RPi
    Bridge -->|MicroPython REST API| ESP
```

The React (Vite) frontend talks to a Node.js/Express backend over REST and Server-Sent Events. SQLite holds users, chats, memories, calendar events, and node registrations. Field nodes (Raspberry Pi, ESP32) announce themselves over MQTT and can be queried/controlled through a signed bridge API. See **[Architecture](https://github.com/[USER]/PATTI/wiki/Architecture)** in the Wiki for the full breakdown, including why each technology was chosen and how the agent delegation pipeline works end to end.

---

## Quick start (Host)

Every device role — Host, PATTI Client, or Node — is set up through a single wizard, `patti-cli.js`.

1. Install [Node.js](https://nodejs.org/) v22+, [Git](https://git-scm.com/), and [LM Studio](https://lmstudio.ai/) or [Ollama](https://ollama.com/).
2. Load a local model and start its server (LM Studio: **Local Server** tab → **Start Server**).
3. ```powershell
   git clone https://github.com/[USER]/PATTI.git
   cd PATTI
   Set-ExecutionPolicy Bypass -Scope Process -Force
   node patti-cli.js
   ```
4. When asked what this machine is, choose **Host**.
5. Open `http://localhost:3000` and complete the Setup Wizard.

`patti-cli.js` registers a background service so PATTI keeps running after you close the terminal, and offers to open the required firewall ports for you. To stop it without uninstalling anything, run `node patti-cli.js stop`; to remove it entirely, `node patti-cli.js uninstall`.

To add a **PATTI Client** (a second full PATTI instance, e.g. on a Raspberry Pi, sharing the Host's LLM) or a lightweight **Node** (ESP32/Raspberry Pi sensor device), run `node patti-cli.js` on that device and choose the matching role — see **[Installation](https://github.com/[USER]/PATTI/wiki/Installation)** for the full walkthrough, MQTT mesh setup, and environment variable reference.

### LAN HTTPS (Android/PWA install)

To run PATTI over HTTPS on your LAN (for better mobile install behavior):

```powershell
npm run lan:https:start
```

This starts the backend and a local Caddy reverse proxy at `https://192.168.1.42`.

To stop both:

```powershell
npm run lan:https:stop
```

If this is your first run, install and trust Caddy's local root cert on your phone:

`%APPDATA%\Caddy\pki\authorities\local\root.crt`

---

## Testing

```bash
npm test              # backend (Jest) + frontend (Vitest)
npm run test:e2e       # Playwright end-to-end
npm run coverage        # coverage report, 70% statement/line threshold enforced
```

---

## Learn more

| Page | What it covers |
| --- | --- |
| **[Home](https://github.com/[USER]/PATTI/wiki)** | Project overview, what problem it solves, and how to use the wiki as a learning resource |
| **[Architecture](https://github.com/[USER]/PATTI/wiki/Architecture)** | Full system topology, technology choices and why, agent delegation pipeline, security boundaries |
| **[Installation](https://github.com/[USER]/PATTI/wiki/Installation)** | Step-by-step setup for every device role, full `.env` reference |
| **[Usage](https://github.com/[USER]/PATTI/wiki/Usage)** | How to actually use the assistant day to day |
| **[Codebase Documentation](https://github.com/[USER]/PATTI/wiki/Codebase-Documentation)** | What every folder and file does and why it's designed that way |
| **[Contributing](https://github.com/[USER]/PATTI/wiki/Contributing)** | How to author and mount a custom tool |
| **[FAQ](https://github.com/[USER]/PATTI/wiki/FAQ)** | Common setup and troubleshooting questions |

## License

MIT — see [LICENSE](LICENSE).
