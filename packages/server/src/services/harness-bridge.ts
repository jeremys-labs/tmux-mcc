// Thin HTTP client + SSE subscriber for the CLI harness sidecar.
// No external dependencies — uses Node.js built-in http module.
import http from 'http';
import type { HarnessConfig } from '../types/agent.js';

interface SidecarResponse {
  status: number;
  body: unknown;
}

export interface SessionInfo {
  sessionId: string;
  agentId: string;
  adapter: string;
  state: string;
}

function sidecarRequest(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<SidecarResponse> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': String(Buffer.byteLength(data)) } : {}),
      },
    };
    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => { raw += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

export class HarnessBridgeService {
  private readonly port: number;

  constructor(port: number) {
    this.port = port;
  }

  async checkHealth(): Promise<boolean> {
    try {
      const r = await sidecarRequest(this.port, 'GET', '/health');
      return r.status === 200;
    } catch {
      return false;
    }
  }

  async ensureSession(agentId: string, harnessConfig: HarnessConfig): Promise<SessionInfo> {
    const { adapter, cwd, modelConfig } = harnessConfig;
    const list = await sidecarRequest(this.port, 'GET', '/sessions');
    const sessions = list.body as SessionInfo[];
    const existing = sessions.find((s) => s.agentId === agentId);
    if (existing) return existing;
    const r = await sidecarRequest(this.port, 'POST', '/sessions', {
      agentId, adapter, cwd, modelConfig,
    });
    if (r.status !== 201) {
      throw new Error(`sidecar session create failed: ${JSON.stringify(r.body)}`);
    }
    return r.body as SessionInfo;
  }

  async sendMessage(
    agentId: string,
    harnessConfig: HarnessConfig,
    text: string,
  ): Promise<SessionInfo> {
    const session = await this.ensureSession(agentId, harnessConfig);
    const r = await sidecarRequest(
      this.port,
      'POST',
      `/sessions/${session.sessionId}/input`,
      { text },
    );
    if (r.status !== 200) {
      throw new Error(`sidecar send failed: ${JSON.stringify(r.body)}`);
    }
    return session;
  }

  // Subscribe to SSE event stream for a session.
  // Returns a function to close the connection.
  subscribe(
    sessionId: string,
    onEvent: (event: Record<string, unknown>) => void,
  ): () => void {
    let closed = false;
    let req: http.ClientRequest | null = null;

    const connect = () => {
      if (closed) return;
      req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.port,
          path: `/sessions/${sessionId}/events`,
          method: 'GET',
          headers: { Accept: 'text/event-stream' },
        },
        (res) => {
          let buffer = '';
          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data) {
                  try { onEvent(JSON.parse(data) as Record<string, unknown>); }
                  catch (err) {
                    console.error('[Harness-SSE] parse error', (err as Error).message);
                  }
                }
              }
            }
          });
          res.on('end', () => { if (!closed) connect(); });
          res.on('error', (err) => {
            console.error('[Harness-SSE] stream error', err.message);
            if (!closed) setTimeout(connect, 1000);
          });
        },
      );
      req.on('error', (err) => {
        console.error('[Harness-SSE] connection error', err.message);
        if (!closed) setTimeout(connect, 1000);
      });
      req.end();
    };

    connect();

    return () => {
      closed = true;
      req?.destroy();
    };
  }

  async replaceSession(agentId: string, harnessConfig: HarnessConfig): Promise<SessionInfo> {
    const list = await sidecarRequest(this.port, 'GET', '/sessions');
    const sessions = list.body as SessionInfo[];
    const existing = sessions.find((s) => s.agentId === agentId);
    const urlPath = existing ? `/sessions/${existing.sessionId}/replace` : '/sessions';
    const { adapter, cwd, modelConfig } = harnessConfig;
    const r = await sidecarRequest(this.port, 'POST', urlPath, {
      agentId, adapter, cwd, modelConfig,
    });
    if (r.status !== 201) {
      throw new Error(`sidecar replace failed: ${JSON.stringify(r.body)}`);
    }
    return r.body as SessionInfo;
  }
}
