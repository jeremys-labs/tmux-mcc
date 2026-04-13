# CLAUDE.md — tmux-mcc

A web dashboard for terminal-based AI agent teams. See README.md for user-facing docs.

---

## Project Structure

```
tmux-mcc/
├── packages/
│   ├── client/          # Vite + React 19 + Tailwind v4 + PixiJS 8
│   │   └── src/
│   │       ├── canvas/         # PixiJS isometric office scene
│   │       ├── components/     # React UI components
│   │       ├── hooks/          # useAgentStatusStream, useTerminal, useChat, useVoice
│   │       ├── stores/         # Zustand stores (agents, agentStatus, chat, UI, voice)
│   │       └── layouts/        # DashboardLayout, AppLayout
│   └── server/          # Express 5 + SQLite + WebSocket
│       └── src/
│           ├── services/       # TmuxRelay, AgentStatusBroadcaster, voice
│           ├── routes/         # REST API + SSE endpoints
│           ├── db.ts           # SQLite chat persistence (WAL mode)
│           └── index.ts        # Server entry point
└── scripts/             # start-mcc.sh, stop-mcc.sh
```

## Running

```bash
npm run dev                          # Both client + server with hot reload
npm run dev --workspace=packages/client   # Client only (port 3001)
npm run dev --workspace=packages/server   # Server only (port 8081)
npm run build                        # Production build
npm run test:server                  # Vitest unit tests
npm run test:e2e                     # Playwright e2e tests
```

## Key Dependencies

- **Client:** React 19, Tailwind v4 (`@plugin` syntax in CSS), PixiJS 8, Zustand 5, xterm.js, react-markdown
- **Server:** Express 5, better-sqlite3 (WAL mode), ws (WebSocket), node-pty, node-edge-tts, yaml

## External Services

| Service | Port | Purpose |
|---------|------|---------|
| tmux | — | Agent session management |
| Whisper Server | 8090 | Speech-to-text (optional) |
| Kokoro TTS | varies | Local text-to-speech (optional) |

Config: `~/.tmux-mcc/config.yaml` (or `$CONTENT_ROOT`)

## Important Patterns

- **Zustand selectors:** Use individual `(s) => s.field` selectors, never destructure the whole store. Use `?? STABLE_CONST` not `|| []` (creates new refs → infinite loops).
- **PixiJS 8 lifecycle:** Never use `resizeTo` (causes crash on destroy). Use explicit dimensions + ResizeObserver. Remove canvas from DOM before `app.destroy()`.
- **Express 5 file serving:** Use `fs.createReadStream().pipe(res)` not `res.sendFile()` for the docs endpoint.
- **Tailwind v4:** Uses `@plugin "@tailwindcss/typography"` in CSS, not a tailwind.config.js.
- **TmuxRelay:** When detaching from a session, broadcast `idle` status (not `awaiting_input`) to clear notification badges in the UI.
- **Agent status:** Status flows from tmux output parsing → `AgentStatusBroadcaster` → SSE `/api/agent-status` → `useAgentStatusStream` → `agentStatusStore`.
- **Terminal scrollback:** Pre-load tmux scrollback buffer on WebSocket connect so Claude Code history is immediately available.
