# OpenClaw MCC Dashboard

## Project Purpose

A modern web dashboard for interacting with OpenClaw AI agents. Provides an isometric pixel-art office view, real-time chat with streaming responses, file browsing, voice communication, and agent status monitoring.

## Project Structure

```
openclaw-mcc/
├── packages/
│   ├── client/          # Vite + React 19 + Tailwind v4 + PixiJS 8
│   │   ├── src/
│   │   │   ├── canvas/         # PixiJS isometric office scene
│   │   │   ├── components/     # React UI components
│   │   │   ├── hooks/          # useChat, useSSE, useConfig, useVoice
│   │   │   ├── stores/         # Zustand stores (agents, chat, UI, voice)
│   │   │   └── layouts/        # DashboardLayout (responsive)
│   │   ├── e2e/                # Playwright integration tests
│   │   └── index.html
│   └── server/          # Express 5 + SQLite + WebSocket
│       └── src/
│           ├── gateway/        # WebSocket client to OpenClaw Gateway
│           ├── services/       # Chat streaming (SSE), voice (TTS/STT)
│           ├── routes/         # REST API endpoints
│           ├── db.ts           # SQLite chat persistence
│           └── index.ts        # Main server entry point
└── docs/plans/          # Design doc + implementation plan
```

## Running

```bash
# Development (both client + server)
npm run dev

# Client only (port 3001)
npm run dev --workspace=packages/client

# Server only (port 8081)
npm run dev --workspace=packages/server

# Tests
npm run test:server          # Vitest unit tests (24 tests)
npm run test:e2e             # Playwright e2e (run from packages/client)
```

## Production (launchd)

The dashboard runs as a launchd service (`com.openclaw.mcc`) serving both API and client on port 8081. Source changes are **not** picked up automatically — you must rebuild and restart:

```bash
npm run build && launchctl kickstart -k gui/$(id -u)/com.openclaw.mcc
```

Dev mode (`npm run dev`) still auto-reloads as usual.

## Key Dependencies

- **Client:** React 19, Tailwind v4 (`@plugin` syntax in CSS), PixiJS 8, Zustand 5, react-markdown, @tailwindcss/typography
- **Server:** Express 5, better-sqlite3 (WAL mode), ws (WebSocket), node-edge-tts, yaml

## External Services

| Service | Port | Purpose |
|---------|------|---------|
| OpenClaw Gateway | 18789 | Agent communication (WebSocket) |
| Whisper Server | 8090 | Speech-to-text |
| Kokoro TTS | varies | Local text-to-speech |

Config: `~/.openclaw/agents.yaml` and `~/.openclaw/openclaw.json`
Content root: `~/.openclaw` (set via `CONTENT_ROOT` env var)

## Important Patterns

- **Zustand selectors:** Use individual `(s) => s.field` selectors, never destructure whole store. Use `?? STABLE_CONST` not `|| []` (creates new refs → infinite loops).
- **PixiJS 8 lifecycle:** Never use `resizeTo` (causes crash on destroy). Use explicit dimensions + ResizeObserver. Remove canvas from DOM before `app.destroy()`.
- **Express 5 file serving:** Use `fs.createReadStream().pipe(res)` not `res.sendFile()` for the docs endpoint.
- **Gateway protocol:** Frame IDs must be strings. See `packages/server/src/gateway/client.ts` for full protocol details.
- **Tailwind v4:** Uses `@plugin "@tailwindcss/typography"` in CSS, not a tailwind.config.js file.

## Remaining Work

See the project memory for the prioritized task list.
