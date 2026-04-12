import { describe, expect, it } from 'vitest';
import { createConfigRouter } from './config.js';

function makeConfig() {
  return {
    branding: { name: 'Test', shortName: 'Test' },
    gateway: { url: 'ws://example.test', token: 'secret' },
    sidecarPort: 9099,
    agents: {
      zara: {
        name: 'Zara',
        role: 'Engineer',
        emoji: '🛠️',
        color: { from: '#111', to: '#222' },
        channel: 'test',
        greeting: 'hi',
        position: { zone: 'desk', x: 0, y: 0 },
        tabs: [],
        providerType: 'llm' as const,
      },
    },
  };
}

async function invokeProviderRoute(config: ReturnType<typeof makeConfig>, agentKey: string, body: any) {
  return await new Promise<any>((resolve) => {
    const mockRes = {
      json: (data: any) => resolve({ status: 200, data }),
      status: (code: number) => ({ json: (data: any) => resolve({ status: code, data }) }),
    };
    const mockReq = {
      params: { agentKey },
      body,
    };
    const router = createConfigRouter(config as any);
    const layer = router.stack.find((r: any) => r.route?.path === '/agents/:agentKey/provider');
    const handler = layer?.route?.stack?.[0]?.handle;
    if (!handler) {
      throw new Error('Provider route handler not found');
    }
    handler(mockReq, mockRes, () => {});
  });
}

describe('config provider route', () => {
  it('switches an agent to persistent-harness', async () => {
    const config = makeConfig();
    const res = await invokeProviderRoute(config, 'zara', {
      providerType: 'persistent-harness',
      harnessConfig: {
        adapter: 'claude-code',
        cwd: '/Volumes/Repo-Drive/src/openclaw-mcc',
      },
    });

    expect(res.status).toBe(200);
    expect(res.data.providerType).toBe('persistent-harness');
    expect(res.data.harnessConfig).toEqual({
      adapter: 'claude-code',
      cwd: '/Volumes/Repo-Drive/src/openclaw-mcc',
    });
  });

  it('switches an agent back to llm and clears harnessConfig', async () => {
    const config = makeConfig();
    config.agents.zara.providerType = 'persistent-harness';
    (config.agents.zara as any).harnessConfig = {
      adapter: 'codex',
      cwd: '/Volumes/Repo-Drive/src/openclaw-mcc',
    };

    const res = await invokeProviderRoute(config, 'zara', {
      providerType: 'llm',
    });

    expect(res.status).toBe(200);
    expect(res.data.providerType).toBe('llm');
    expect(res.data.harnessConfig).toBeUndefined();
  });

  it('rejects persistent-harness updates without adapter', async () => {
    const config = makeConfig();
    const res = await invokeProviderRoute(config, 'zara', {
      providerType: 'persistent-harness',
      harnessConfig: { cwd: '/tmp' },
    });

    expect(res.status).toBe(400);
    expect(res.data.error).toContain('harnessConfig.adapter required');
  });

  it('returns 404 for unknown agent', async () => {
    const config = makeConfig();
    const res = await invokeProviderRoute(config, 'missing', {
      providerType: 'llm',
    });

    expect(res.status).toBe(404);
  });
});
