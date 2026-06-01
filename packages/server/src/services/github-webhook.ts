import crypto from 'crypto';
import type { EmitEventInput, EventInboxPriority } from './event-inbox.js';

export interface GitHubWebhookInput {
  eventName: string;
  deliveryId: string;
  payload: any;
}

export function verifyGitHubSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const actual = Buffer.from(signatureHeader, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

function repoFullName(payload: any): string {
  return payload?.repository?.full_name ?? 'unknown/repo';
}

function ownerForGitHubEvent(repo: string, eventType: string): string {
  if (repo === 'Med-Aware/inference') {
    return 'hercule';
  }
  if (repo === 'jeremys-labs/tmux-mcc') {
    if (eventType === 'workflow_run' || eventType === 'check_suite') return 'marcus';
    return 'eli';
  }
  return 'eli';
}

function priorityForGitHubEvent(eventName: string, payload: any): EventInboxPriority {
  if (eventName === 'workflow_run' && payload?.workflow_run?.conclusion === 'failure') return 'high';
  if (eventName === 'check_suite' && payload?.check_suite?.conclusion === 'failure') return 'high';
  return 'normal';
}

function eventSummary(eventName: string, payload: any): string {
  const repo = repoFullName(payload);
  if (eventName === 'issues') {
    return `${repo} issue ${payload?.action ?? 'event'}: #${payload?.issue?.number ?? '?'} ${payload?.issue?.title ?? ''}`.trim();
  }
  if (eventName === 'issue_comment') {
    return `${repo} issue comment ${payload?.action ?? 'event'}: #${payload?.issue?.number ?? '?'}`;
  }
  if (eventName === 'workflow_run') {
    const run = payload?.workflow_run;
    return `${repo} workflow ${run?.conclusion ?? run?.status ?? payload?.action ?? 'event'}: ${run?.name ?? 'unknown workflow'}`;
  }
  if (eventName === 'check_suite') {
    const suite = payload?.check_suite;
    return `${repo} check suite ${suite?.conclusion ?? suite?.status ?? payload?.action ?? 'event'}`;
  }
  return `${repo} GitHub ${eventName}`;
}

function occurredAt(eventName: string, payload: any): string | null {
  if (eventName === 'issues') return payload?.issue?.updated_at ?? payload?.issue?.created_at ?? null;
  if (eventName === 'issue_comment') return payload?.comment?.updated_at ?? payload?.comment?.created_at ?? null;
  if (eventName === 'workflow_run') return payload?.workflow_run?.updated_at ?? payload?.workflow_run?.created_at ?? null;
  if (eventName === 'check_suite') return payload?.check_suite?.updated_at ?? payload?.check_suite?.created_at ?? null;
  return null;
}

export function normalizeGitHubWebhook(input: GitHubWebhookInput): EmitEventInput | null {
  const supportedEvents = new Set(['issues', 'issue_comment', 'workflow_run', 'check_suite']);
  if (!supportedEvents.has(input.eventName)) {
    return null;
  }

  const repo = repoFullName(input.payload);
  const ownerAgent = ownerForGitHubEvent(repo, input.eventName);
  const routeKey = `github:${repo}:${input.eventName}`;

  return {
    source: 'github',
    sourceEventId: input.deliveryId,
    eventType: input.eventName,
    ownerAgent,
    routeKey,
    summary: eventSummary(input.eventName, input.payload),
    payload: input.payload,
    occurredAt: occurredAt(input.eventName, input.payload),
    priority: priorityForGitHubEvent(input.eventName, input.payload),
    risk: 'low',
    dedupeKey: `github:${input.deliveryId}`,
  };
}
