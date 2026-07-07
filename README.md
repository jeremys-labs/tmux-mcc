# tmux-mcc

A web dashboard for terminal-based AI agent teams. Gives you a real-time view into a fleet of agents running in tmux sessions — each agent gets a live terminal panel, status badge, cron job management, and contextual data tabs, all in one responsive UI.

Built for Claude Code agents, but works with any terminal-based AI tool that runs in tmux.

---

## Features

### 🧑‍💼 Agent Rail
- Sidebar showing all agents with avatars and live status badges
- Status reflects real agent activity: `idle`, `awaiting_input`, `thinking`, `error`
- Click any agent to open their terminal and info panels

### 💻 Terminal Sessions
- Full terminal access to each agent's tmux window, embedded directly in the UI
- Scrollback pre-loaded on connect — full conversation history available
- Keyboard input passthrough — type directly into the terminal from the browser
- Native tmux mouse scrolling with `alternate-screen off` for Claude Code compatibility

### 📊 Agent Info Tabs
Each agent can expose contextual data panels alongside the terminal:

| Source | Description |
|--------|-------------|
| `file:<filename>` | JSON or markdown from the agent's data directory |
| `memory` | Agent's memory markdown file |
| `about` | Static agent bio/description |
| `crons` | Live cron job list filtered to this agent |

| Renderer | Description |
|----------|-------------|
| `default` | Smart JSON renderer — flat arrays become card lists, nested objects become key-value sections |
| `markdown` | Full GitHub-flavored markdown with table support |
| `chart` | Chart.js visualizations (bar, line, pie) |

### 🏢 Isometric Office View
- PixiJS 8 rendered isometric office scene
- Click agents at their desks to open a chat/terminal session
- Animated agents, name plates, and configurable desk positions

### ⏱️ Cron Job Management
- View all scheduled jobs across all agents
- Click any entry to see run history, last status, next run, and full payload
- Color-coded status (ok / error / timeout) with consecutive error counts

### 📋 Projects Kanban
- Cross-agent project board with status columns: Backlog → Planning → In Progress → In Review → Done
- Sourced from a `projects.json` file agents can update directly
- Auto-refreshes every 5 minutes

### 📁 File Browser
- Browse agent-generated documents organized in inbox / approved / archive
- Markdown preview with GFM rendering
- File approval workflow — move files between folders from the UI

### 🎙️ Voice (Optional)
- Push-to-talk via Whisper STT (local or server)
- Text-to-speech via Kokoro TTS (local) or Edge TTS (cloud fallback)

---

## Prerequisites

- **Node.js 20+**
- **tmux** — agents must be running in a tmux session
- **Xcode Command Line Tools** (macOS) — required to compile `better-sqlite3`
  ```bash
  xcode-select --install
  ```

---

## Quick Start

```bash
git clone git@github.com:jeremys-labs/tmux-mcc.git
cd tmux-mcc
npm install

# Create your content directory and config
cp .env.example .env
mkdir -p ~/.tmux-mcc
# Edit ~/.tmux-mcc/config.yaml — see Configuration below

# Create an agent directory for each agent you want visible in the UI
mkdir -p ~/.tmux-mcc/agents/myagent

# Start your agents in a tmux session named "agents" (or set TMUX_SESSION in .env)
tmux new-session -d -s agents -n myagent

npm run dev
```

The client runs on `http://localhost:3001` and the server on `http://localhost:8081`.

Use `scripts/start-mcc.sh` and `scripts/stop-mcc.sh` for managed startup/shutdown.

---

## Configuration

All configuration lives under `CONTENT_ROOT` (default: `~/.tmux-mcc`).

### config.yaml

```yaml
branding:
  name: "My Agent Team"
  shortName: "MCC"

agents:
  researcher:
    name: Ada
    fullName: Ada Lovelace
    role: Research Lead
    emoji: "🔬"
    color:
      from: "#8b5cf6"
      to: "#7c3aed"
    channel: "#research"
    greeting: "What should we investigate?"
    quote: "The more I study, the more I know."
    tmuxWindow: researcher          # tmux window name (defaults to agent key)
    position:
      zone: desk
      x: 3
      y: 2
    tabs:
      - id: findings
        label: Findings
        icon: search
        source: "file:findings.json"
      - id: memory
        label: Memory
        icon: user
        source: memory
        renderer: markdown
      - id: jobs
        label: Jobs
        icon: clock
        source: crons
```

**`tmuxWindow`** — the tmux window name for this agent. Defaults to the agent key if not set. The server looks for a window with this name inside your tmux session.

**Tab file lookup order:**
1. `CONTENT_ROOT/workspace/agents/<agentKey>/<filename>`
2. `CONTENT_ROOT/data/<filename>`

### projects.json (optional)

Powers the Projects Kanban. Place at `CONTENT_ROOT/workspace/docs/projects/projects.json`:

```json
[
  {
    "id": "my-app",
    "name": "My App",
    "owner": "ada",
    "status": "in-progress",
    "summary": "Building the core feature set",
    "nextStep": "Complete authentication flow",
    "blocker": null,
    "lastUpdated": "2026-04-12"
  }
]
```

Valid statuses: `backlog`, `planning`, `in-progress`, `in-review`, `done`

### models.json (optional)

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
~/.tmux-mcc/                        # CONTENT_ROOT
├── config.yaml                     # Required — agents and branding
├── models.json                     # Optional — model display names
├── workspace/
│   ├── agents/
│   │   └── <agentKey>/
│   │       ├── <tabfile>.json      # Data files for agent tabs
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

### Skill Promotion

Pending skill proposals are inert until reviewed and promoted:

- Agent-scoped proposals: `/Volumes/Repo-Drive/agents/<agent>/pending/skills/<skill>.md`
- Shared proposals: `/Volumes/Repo-Drive/agents/SHARED/pending/skills/<skill>.md`

The answer-context skill snapshot excludes anything under `pending/skills` from
the invocable skill list. After review, promote a pending file into the live
`skills/<skill>/SKILL.md` layout with:

```bash
npm run skill:promote --workspace=@mcc-tmux/server -- --agent <agent> --name <skill>
npm run skill:promote --workspace=@mcc-tmux/server -- --shared --name <skill>
```

The command prints the before/after snapshot version and skill count. It refuses
unsafe names, frontmatter name mismatches, missing pending files, and overwrites
of existing live skills.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTENT_ROOT` | `~/.tmux-mcc` | Path to content directory (config.yaml, workspace, etc.) |
| `AGENTS_DIR` | `~/.tmux-mcc/agents` | Directory containing one subdirectory per agent. Only agents with a matching subdirectory here are shown in the UI. Place `avatar.png` inside each subdirectory for custom avatars. |
| `TMUX_SESSION` | `agents` | Name of the tmux session your agents run in. All agent windows must be in this session. |
| `SERVER_PORT` | `8081` | Server listen port |
| `CLIENT_PORT` | `3001` | Vite dev server port |
| `WHISPER_SERVER_URL` | `http://127.0.0.1:8090/inference` | Whisper HTTP server for STT |
| `WHISPER_CLI` | auto-detected | Path to whisper CLI binary |
| `FFMPEG_BIN` | auto-detected | Path to ffmpeg binary |
| `KOKORO_URL` | `http://127.0.0.1:8880` | Kokoro TTS server URL |

Copy `.env.example` to `.env` to set these locally.

---

## Scripts

```bash
./scripts/start-mcc.sh              # Start server + client (+ optional agent session)
./scripts/start-mcc.sh --no-agents  # Start MCC only, skip agent session
./scripts/stop-mcc.sh               # Stop server + client
./scripts/stop-mcc.sh --all         # Stop everything including agent tmux session
```

The start script looks for a `start-agents.sh` in `../agents/` relative to the repo (or set `AGENTS_SCRIPT=/path/to/start-agents.sh`). This is intentionally outside the repo — your agent startup config is personal and deployment-specific.

---

## Development

```bash
npm run dev                          # Both client + server with hot reload
npm run dev -w packages/client       # Client only (port 3001)
npm run dev -w packages/server       # Server only (port 8081)

npm run build                        # Production build
npm run test:server                  # Vitest unit tests
npm run test:e2e                     # Playwright e2e tests
```

### Project Structure

```
tmux-mcc/
├── packages/
│   ├── client/                      # Vite + React 19 + Tailwind v4 + PixiJS 8
│   │   └── src/
│   │       ├── canvas/              # Isometric office scene (PixiJS)
│   │       ├── components/
│   │       │   ├── AgentRail.tsx       # Agent sidebar with status badges
│   │       │   ├── AgentAvatar.tsx     # Avatar with image/initials fallback
│   │       │   ├── TerminalPanel.tsx   # Embedded tmux terminal (xterm.js)
│   │       │   ├── AgentInfoTabs.tsx   # Data tabs + card/JSON renderer
│   │       │   ├── ChatPanel.tsx       # Chat UI + streaming
│   │       │   ├── CronDetailPanel.tsx # Cron job detail drawer
│   │       │   └── ProjectsView.tsx    # Kanban board
│   │       ├── hooks/
│   │       │   ├── useAgentStatusStream.ts  # SSE status subscription
│   │       │   ├── useTerminal.ts           # xterm.js + WebSocket terminal
│   │       │   └── useChat.ts               # Chat send/retry/history
│   │       └── stores/
│   │           ├── agentStatusStore.ts  # Live agent status
│   │           └── agentStore.ts        # Agent config
│   └── server/                      # Express 5 + SQLite + WebSocket
│       └── src/
│           ├── services/
│           │   ├── tmux-relay.ts           # tmux session bridge
│           │   └── agent-status-broadcaster.ts  # SSE status events
│           └── routes/
│               ├── agent-status.ts     # SSE stream endpoint
│               ├── avatars.ts          # Agent avatar serving
│               └── cron.ts             # Cron job data
└── scripts/
    ├── start-mcc.sh
    └── stop-mcc.sh
```

---

## Open Brain Memory (Optional)

MCC ships with optional integration for [Open Brain](https://github.com/jeremys-labs/open-brain), a governed agent-memory layer. When enabled, agents get startup memory recall and answer-time context injection through Claude/Codex hooks.

**MCC works without Open Brain.** With no Open Brain credentials present, the harness hook returns empty output and the dashboard runs normally — there is no install-time or runtime dependency on the Open Brain repo or service.

To enable, point MCC at your Open Brain credentials via these environment variables:

| Variable | Purpose |
|----------|---------|
| `OPEN_BRAIN_ENV_PATH` | Path to the OB1 endpoint env file (defines `OPEN_BRAIN_ENDPOINT_URL` etc.) |
| `OPEN_BRAIN_ACCESS_KEY_PATH` | Path to the MCP access key file |
| `OPEN_BRAIN_RUNTIME_DISABLED` | Set to `1` to force-disable even when credentials are present |

Per-agent memory keys are read from `<agent-dir>/.open-brain/memory.env` relative to your agents root.

> The defaults baked into the code (`/Volumes/Repo-Drive/src/open-brain/credentials/...`) are this repo author's local convention — external adopters should set the env vars above to point at their own paths.

---

## Voice Services (Optional)

**Speech-to-text** — one of:
- [Whisper.cpp server](https://github.com/ggerganov/whisper.cpp) on port 8090 *(recommended)*
- Whisper CLI binary

**Text-to-speech** — in priority order:
1. [Kokoro TTS](https://github.com/remsky/Kokoro-FastAPI) — local neural TTS, no internet required
2. Edge TTS — Microsoft's free cloud TTS, no API key needed

---

## License

MIT
