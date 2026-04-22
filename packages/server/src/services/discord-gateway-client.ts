import WebSocket from 'ws';
import type { DiscordMessageEvent } from '../types/codex-bridge.js';

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const INTENTS =
  1 +      // GUILDS
  512 +    // GUILD_MESSAGES
  4096 +   // DIRECT_MESSAGES
  32768;   // MESSAGE_CONTENT

interface GatewayPayload {
  op: number;
  t?: string;
  s?: number | null;
  d?: any;
}

export class DiscordGatewayClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private seq: number | null = null;

  constructor(
    private readonly token: string,
    private readonly onMessageCreate: (event: DiscordMessageEvent) => void,
  ) {}

  connect(): void {
    this.ws = new WebSocket(GATEWAY_URL);
    this.ws.on('message', (raw) => this.handlePayload(JSON.parse(raw.toString()) as GatewayPayload));
    this.ws.on('close', () => this.cleanup());
    this.ws.on('error', (error) => console.error('[codex-bridge] discord gateway error:', error));
  }

  close(): void {
    this.cleanup();
    this.ws?.close();
    this.ws = null;
  }

  private cleanup(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private send(op: number, d: unknown): void {
    this.ws?.send(JSON.stringify({ op, d }));
  }

  private identify(): void {
    this.send(2, {
      token: this.token,
      intents: INTENTS,
      properties: {
        os: process.platform,
        browser: 'codex-discord-bridge',
        device: 'codex-discord-bridge',
      },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    this.cleanup();
    this.heartbeatTimer = setInterval(() => {
      this.send(1, this.seq);
    }, intervalMs);
  }

  private handlePayload(payload: GatewayPayload): void {
    if (typeof payload.s === 'number') this.seq = payload.s;

    if (payload.op === 10) {
      this.startHeartbeat(payload.d.heartbeat_interval);
      this.identify();
      return;
    }

    if (payload.op === 11) return;

    if (payload.op === 0 && payload.t === 'MESSAGE_CREATE') {
      this.onMessageCreate(payload.d as DiscordMessageEvent);
    }
  }
}
