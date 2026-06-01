import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { normalizeGitHubWebhook, verifyGitHubSignature } from './github-webhook.js';

function sign(body: Buffer, secret: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('GitHub webhook adapter', () => {
  it('verifies GitHub HMAC signatures against the raw body', () => {
    const body = Buffer.from(JSON.stringify({ action: 'opened' }));
    const secret = 'local-secret';

    expect(verifyGitHubSignature(body, sign(body, secret), secret)).toBe(true);
    expect(verifyGitHubSignature(body, sign(Buffer.from('{}'), secret), secret)).toBe(false);
    expect(verifyGitHubSignature(body, undefined, secret)).toBe(false);
  });

  it('routes tmux-mcc issue events to Eli', () => {
    const event = normalizeGitHubWebhook({
      eventName: 'issues',
      deliveryId: 'delivery-1',
      payload: {
        action: 'opened',
        repository: { full_name: 'jeremys-labs/tmux-mcc' },
        issue: { number: 42, title: 'Webhook receiver', created_at: '2026-06-01T20:00:00Z' },
      },
    });

    expect(event).toMatchObject({
      source: 'github',
      sourceEventId: 'delivery-1',
      eventType: 'issues',
      ownerAgent: 'eli',
      routeKey: 'github:jeremys-labs/tmux-mcc:issues',
      summary: 'jeremys-labs/tmux-mcc issue opened: #42 Webhook receiver',
      occurredAt: '2026-06-01T20:00:00Z',
      dedupeKey: 'github:delivery-1',
    });
  });

  it('routes inference CI failures to Hercule with high priority', () => {
    const event = normalizeGitHubWebhook({
      eventName: 'workflow_run',
      deliveryId: 'delivery-2',
      payload: {
        repository: { full_name: 'Med-Aware/inference' },
        workflow_run: {
          name: 'TypeScript',
          conclusion: 'failure',
          updated_at: '2026-06-01T21:00:00Z',
        },
      },
    });

    expect(event).toMatchObject({
      ownerAgent: 'hercule',
      priority: 'high',
      routeKey: 'github:Med-Aware/inference:workflow_run',
      summary: 'Med-Aware/inference workflow failure: TypeScript',
    });
  });

  it('ignores unsupported GitHub webhook event types', () => {
    expect(
      normalizeGitHubWebhook({
        eventName: 'star',
        deliveryId: 'delivery-3',
        payload: { repository: { full_name: 'jeremys-labs/tmux-mcc' } },
      })
    ).toBeNull();
  });
});
