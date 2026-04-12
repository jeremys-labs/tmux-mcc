# OpenClaw MCC Dashboard

A web dashboard for interacting with [OpenClaw](https://openclaw.ai) AI agents. Features an isometric pixel-art office view, real-time streaming chat, file browsing, voice communication, agent data tabs, cron job management, and project tracking. All agent definitions, branding, and content live outside the codebase in a configurable content directory — no code changes needed to add or reconfigure agents.

## Features

### 🏢 Isometric Office
- PixiJS 8 rendered isometric office scene with animated agent sprites
- Click any agent at their desk to open a chat session
- Idle animations, name plates, and customizable desk positions

### 💬 Real-Time Chat
- Streaming responses via SSE (Server-Sent Events) with live delta rendering
- Full chat history persisted in SQLite — scroll back as far as you like
- Interrupt mid-stream with a stop button
- Retry failed messages directly from the error bubble
- Auto-reconnect with exponential backoff on connection loss

### 📊 Agent Data Tabs
Agents can expose contextual data panels alongside their chat. Each tab has a configurable source and renderer:

| Source | Description |
|--------|-------------|
| `file:<filename>` | JSON or markdown file from the agent's data directory |
| `memory` | Agent's memory markdown file |
| `about` | Static agent bio/description |
| `crons` | Live cron job list filtered to this agent |

| Renderer | Description |
|----------|-------------|
| `default` | Smart JSON renderer — flat arrays become card lists, nested objects become sections |
| `markdown` | Full GitHub-flavored markdown with table and frontmatter support |
| `chart` | Chart.js visualizations (bar, line, pie) |

**Card renderer details:** When a tab's JSON is a flat array of objects, each object renders as a card with:
- `name` / `title` → card heading
- `status` → color-coded badge (green=complete, blue=active, yellow=pending, etc.)
- `priority` / `severity` → priority indicator
- `summary` → full-width prose text below the header
- `headlines` → expandable list of linked items (type badge + clickable URL)
- All other fields → compact key-value grid

### 📋 Projects Kanban
- Kanban board showing all active agent projects across your org
- Status columns: Backlog → Planning → In Progress → In Review → Done
- Live data from a `projects.json` file — agents update it, the board auto-refreshes every 5 minutes
- Manual refresh button for instant updates

### ⏱️ Cron Job Management
- View all scheduled cron jobs across all agents
- Click any cron entry to see run history, last status, next run time, and full payload
- Filter by agent, status, or search by name
- Color-coded run status (ok / error / timeout) with consecutive error counts

### 📁 File Browser
- Browse agent-generated documents organized in inbox / approved / archive folders
- Markdown preview with GFM table rendering
- File approval workflow — move files between folders from the UI

### 🎙️ Voice
- Push-to-talk voice input via Whisper STT (local or server)
- Text-to-speech responses via Kokoro TTS or Edge TTS (cloud fallback)
- Per-agent voice configuration

### 🧠 Memory Viewer
- Read each agent's memory file directly in the dashboard
- Full markdown rendering

---

## Prerequisites

- **Node.js 20+**
- **OpenClaw Gateway** running and accessible (default port 18789)
- **Xcode Command Line Tools** (macOS) — required to compile `better-sqlite3`
  ```bash
  xcode-select --install
  ```

---

## Quick Start

```bash
git clone git@github.com:jeremys-labs/openclaw-mcc.git
cd openclaw-mcc
npm install

# Create your content directory and config
cp config.yaml.example ~/.openclaw/config.yaml   # Edit with your agents

npm run dev
```

The client runs on `http://localhost:3001` and the server on `http://localhost:8081`.

---

## Configuration

All configuration lives under `CONTENT_ROOT` (default: `~/.openclaw`).

### config.yaml (required)

```yaml
branding:
  name: "My AI Office"        # Dashboard title
  shortName: "MCC"

gateway:
  url: "http://127.0.0.1:18789"
  token: "your-gateway-token"

agents:
  researcher:
    name: Ada                   # Display name
    fullName: Ada Lovelace      # Optional full name
    role: Research Lead         # Job title shown in UI
    emoji: "🔬"                 # Fallback avatar when no sprite
    sprite: ada                 # Sprite sheet name in assets/ (optional)
    color:
      from: "#8b5cf6"          # Card gradient start
      to: "#7c3aed"            # Card gradient end
    channel: "#research"        # Channel identifier
    greeting: "What should we investigate?"
    quote: "The more I study, the more I know."
    voice: "en-US-AriaNeural"  # Edge TTS voice (optional)
    position:
      zone: desk
      x: 3
      y: 2
    tabs:
      - id: findings
        label: Findings
        source: "file:findings.json"      # Looks up CONTENT_ROOT/workspace/agents/researcher/findings.json
      - id: reports
        label: Reports
        source: "file:reports.json"
        renderer: markdown
      - id: memory
        label: Memory
        source: memory
        renderer: markdown
      - id: jobs
        label: Jobs
        source: crons                     # Live cron jobs for this agent
```

**Tab file lookup order:**
1. `CONTENT_ROOT/workspace/agents/<agentKey>/<filename>`
2. `CONTENT_ROOT/data/<filename>`

**Agent keys** (e.g., `researcher`) must match the session identifier used by OpenClaw Gateway.

### projects.json (optional)

Powers the Projects Kanban board. Agents update this file; the UI auto-refreshes:

```json
[
  {
    "id": "my-app",
    "name": "My App",
    "owner": "marcus",
    "status": "in-progress",
    "summary": "Building the core feature set",
    "nextStep": "Complete authentication flow",
    "blocker": null,
    "lastUpdated": "2026-03-16"
  }
]
```

Valid statuses: `backlog`, `planning`, `in-progress`, `in-review`, `done`

Place at `CONTENT_ROOT/workspace/docs/projects/projects.json`.

### openclaw.json (optional)

Maps agents to LLM models for display in the chat header:

```json
{
  "agents": {
    "defaults": {
      "model": { "primary": "anthropic/claude-haiku-4-5" }
    },
    "list": [
      { "id": "researcher", "model": { "primary": "anthropic/claude-sonnet-4-6" } }
    ]
  }
}
```

---

## Content Directory Layout

```
~/.openclaw/                        # CONTENT_ROOT
├── config.yaml                     # Required — agents, gateway, branding
├── openclaw.json                   # Optional — model mappings
├── workspace/
│   ├── agents/
│   │   └── <agentKey>/
│   │       ├── <tabfile>.json      # Data files for agent tabs (file: source)
│   │       └── memory.md          # Agent memory (memory source)
│   └── docs/
│       └── projects/
│           └── projects.json       # Kanban board data
├── data/                           # Fallback path for tab files
├── files/                          # Agent-generated documents
│   ├── inbox/
│   ├── approved/
│   └── archive/
├── databases/
│   └── chat.db                     # SQLite chat history (auto-created)
└── assets/                         # Custom sprite sheets (optional)
```

---

## Agent Tab Data Formats

### Card list (recommended for structured data)

Return a **flat array of objects** from your tab's JSON file. Each object becomes a card:

```json
[
  {
    "name": "Competitor A",
    "status": "active",
    "summary": "Full-width prose text that describes this item in detail. No truncation in the UI.",
    "items": 5,
    "updated": "Mar 16, 2026",
    "headlines": [
      { "title": "Competitor A launches new product", "url": "https://...", "type": "announcement" },
      { "title": "Coverage in industry press", "url": "https://...", "type": "news" }
    ]
  }
]
```

The `headlines` array renders as an expandable section — click "▼ N items" on the card to expand.

### Nested object (key-value sections)

Return a plain object. Nested objects become labeled sections, scalar values become key-value rows:

```json
{
  "budget": { "allocated": 50000, "spent": 32000, "remaining": 18000 },
  "status": "on track"
}
```

### Markdown

Set `renderer: markdown` and return a string (or use `source: memory`). Full GFM support including tables.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTENT_ROOT` | `~/.openclaw` | Path to content directory |
| `SERVER_PORT` | `8081` | Server listen port |
| `CLIENT_PORT` | `3001` | Vite dev server port |
| `GATEWAY_PORT` | `18789` | OpenClaw Gateway port (overrides config.yaml) |
| `GATEWAY_TOKEN` | — | Gateway auth token (overrides config.yaml) |
| `WHISPER_SERVER_URL` | `http://127.0.0.1:8090/inference` | Whisper HTTP server for STT |
| `WHISPER_CLI` | auto-detected | Path to whisper CLI binary |
| `FFMPEG_BIN` | auto-detected | Path to ffmpeg binary |
| `KOKORO_URL` | `http://127.0.0.1:8880` | Kokoro TTS server URL |

Copy `.env.example` to `.env` to set these locally.

---

## Production Deployment

```bash
npm run build
node packages/server/dist/index.js
```

### launchd (macOS)

Create `~/Library/LaunchAgents/com.openclaw.mcc.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.openclaw.mcc</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/openclaw-mcc/packages/server/dist/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CONTENT_ROOT</key>
    <string>/Users/you/.openclaw</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/openclaw-mcc.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/openclaw-mcc.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.openclaw.mcc.plist

# After rebuilding:
npm run build && launchctl kickstart -k gui/$(id -u)/com.openclaw.mcc
```

> **Tip:** Use `which node` to find the correct node path — hardcoded paths break when updating Node via nvm/fnm/Homebrew.

---

## Development

```bash
npm run dev                          # Both client + server with hot reload
npm run dev -w packages/client       # Client only (port 3001, proxies to server)
npm run dev -w packages/server       # Server only (port 8081)

npm run build                        # Production build
npm run test:server                  # Vitest unit tests
npm run test:e2e                     # Playwright e2e tests
```

### Project Structure

```
openclaw-mcc/
├── packages/
│   ├── client/                      # Vite + React 19 + Tailwind v4 + PixiJS 8
│   │   ├── src/
│   │   │   ├── canvas/              # Isometric office scene (PixiJS)
│   │   │   ├── components/
│   │   │   │   ├── AgentInfoTabs.tsx   # Data tabs + card/JSON renderer
│   │   │   │   ├── ChatPanel.tsx       # Chat UI + streaming
│   │   │   │   ├── ChatMessage.tsx     # Message rendering (markdown + tables)
│   │   │   │   ├── CronDetailPanel.tsx # Cron job detail drawer
│   │   │   │   ├── ProjectsView.tsx    # Kanban board
│   │   │   │   └── StandupWidget.tsx   # Agent standup summary
│   │   │   ├── hooks/
│   │   │   │   ├── useChat.ts          # Send/retry/load with safety-net poll
│   │   │   │   ├── useSSE.ts           # SSE with auto-reconnect + history reload
│   │   │   │   ├── useConfig.ts        # Agent config loader
│   │   │   │   └── useVoice.ts         # STT/TTS integration
│   │   │   └── stores/
│   │   │       ├── chatStore.ts        # Message state + stream buffer
│   │   │       └── agentStore.ts       # Agent config + error state
│   │   └── e2e/                     # Playwright tests
│   └── server/                      # Express 5 + SQLite + WebSocket
│       └── src/
│           ├── gateway/             # WebSocket client to OpenClaw Gateway
│           ├── services/
│           │   ├── chat-streaming.ts   # SSE broadcast service
│           │   └── voice.ts            # TTS/STT service
│           ├── routes/              # REST API endpoints
│           └── db.ts                # SQLite (WAL mode, auto-migration)
└── docs/plans/                      # Design documents
```

---

## Voice Services (Optional)

**Speech-to-text** — one of:
- [Whisper.cpp server](https://github.com/ggerganov/whisper.cpp) on port 8090 *(recommended)*
- Whisper CLI binary

**Text-to-speech** — in priority order:
1. [Kokoro TTS](https://github.com/remsky/Kokoro-FastAPI) — local neural TTS, no internet required
2. Edge TTS — Microsoft's free cloud TTS, no setup needed

---

## License

MIT
