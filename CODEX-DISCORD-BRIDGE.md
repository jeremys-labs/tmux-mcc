# Codex Discord Bridge

This bridge is intentionally narrower than Claude's native `channels` support.

- `Claude CLI` keeps using the official `claude --channels ...` path.
- `Codex CLI` gets inbound Discord delivery through a separate bridge service.
- `mcc-tmux` remains terminal-only. The UI does not subscribe to the bridge.

## Delivery Model

Inbound path:

1. A standalone bridge process connects to the Discord Gateway WebSocket.
2. `MESSAGE_CREATE` events are filtered against configured Codex subscriptions.
3. Matching messages are appended to `CONTENT_ROOT/bridge/inbox/<agent>.jsonl`.
4. A Codex runtime wrapper consumes that inbox and injects new messages into the live Codex PTY.

This avoids polling Discord every 30-60 seconds. Discord push delivery is more immediate and is the standard bot pattern.

## Config

Create `CONTENT_ROOT/bridge/codex-discord.json`:

```json
{
  "bindings": [
    {
      "name": "marcus",
      "tokenEnvVar": "DISCORD_BOT_TOKEN_MARCUS",
      "selfUserId": "123456789012345678",
      "subscriptions": [
        {
          "agentKey": "marcus",
          "channelId": "1492892431543308439"
        }
      ]
    },
    {
      "name": "zara",
      "tokenEnvVar": "DISCORD_BOT_TOKEN_ZARA",
      "subscriptions": [
        {
          "agentKey": "zara",
          "channelId": "1492551894214905886"
        }
      ]
    }
  ]
}
```

This is the preferred long-term shape for 8-10 Discord-enabled agents:

- one gateway process
- one Discord client per bot token
- isolated bindings by `name`
- separate token env vars and subscriptions per agent

Backward compatibility remains in place for the older single-binding shape:

```json
{
  "tokenEnvVar": "DISCORD_BOT_TOKEN",
  "subscriptions": [
    {
      "agentKey": "marcus",
      "channelId": "1492892431543308439"
    }
  ]
}
```

The helper script for a single agent still works:

```bash
./scripts/start-codex-discord-bridge.sh zara
```

To run a multi-binding gateway, export all referenced token env vars and run:

```bash
npm run bridge:codex-discord --workspace=@mcc-tmux/server
```

Each inbound inbox entry includes the binding name so routing stays explicit.

If agents already have working Claude Discord setups, you can reuse those instead of creating a hand-maintained bridge config. The helper scripts read:

- `<agent>/.claude/discord/.env` for `DISCORD_BOT_TOKEN`
- `<agent>/.claude/discord/access.json` for the allowed group/channel IDs

Single agent:

```bash
./scripts/start-codex-discord-bridge.sh zara
```

Multiple agents:

```bash
./scripts/start-codex-discord-gateway.sh zara marcus remy
```

The multi-agent launcher generates a temporary `bindings[]` config, exports one token env var per agent, and runs one shared gateway process.

To run a Codex agent with inbox delivery enabled:

```bash
npm run run:codex-wrapper --workspace=@mcc-tmux/server -- --agent marcus --cd /Volumes/Repo-Drive/agents/marcus -- --dangerously-bypass-approvals-and-sandbox
```

Arguments after the second `--` are forwarded to `codex`.

## Scope

This bridge handles inbound Discord delivery for Codex. It does not replace:

- Claude native channels
- Discord outbound tools already available to the CLIs
- tmux as the UI/runtime display layer

The wrapper polls the local inbox file every 2 seconds. This is intentionally local-only polling; Discord delivery itself is push-based over the Gateway WebSocket.

## tmux Launch Integration

The repo now includes a launcher that respects each agent's own `launch.sh`:

```bash
./scripts/start-agents-from-launchers.sh
```

`start-mcc.sh` uses this launcher by default. That means a Codex-backed agent can opt into the bridge by changing its own `launch.sh`, while Claude-backed agents keep using native `claude --channels ...`.

Example `launch.sh` for a Codex-backed agent:

```bash
#!/bin/zsh
cd "$(dirname "$0")"
export CONTENT_ROOT="${HOME}/.tmux-mcc"
exec npm run run:codex-wrapper \
  --workspace=@mcc-tmux/server \
  --prefix /Volumes/Repo-Drive/src/mcc-tmux \
  -- \
  --agent marcus \
  --cd "$PWD" \
  -- \
  --dangerously-bypass-approvals-and-sandbox
```

That keeps tmux as the UI surface while making Codex subscribe to the Discord inbox bridge.
