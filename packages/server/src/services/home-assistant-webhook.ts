import crypto from 'crypto';
import type { EmitEventInput, EventInboxPriority, EventInboxRisk } from './event-inbox.js';

export interface HomeAssistantWebhookInput {
  deliveryId: string;
  payload: any;
}

export function verifyHomeAssistantToken(authHeader: string | undefined, tokenHeader: string | undefined, expectedToken: string): boolean {
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : null;
  const suppliedToken = bearerToken || tokenHeader;
  if (!suppliedToken) return false;

  const actual = Buffer.from(suppliedToken, 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function homeAssistantDeliveryId(rawBody: Buffer): string {
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

function eventType(payload: any): string {
  return payload?.event_type ?? payload?.type ?? payload?.trigger?.event_type ?? payload?.trigger?.platform ?? 'event';
}

function entityId(payload: any): string | null {
  return payload?.entity_id ?? payload?.event?.data?.entity_id ?? payload?.trigger?.entity_id ?? null;
}

function eventSummary(payload: any): string {
  if (typeof payload?.summary === 'string' && payload.summary.trim()) {
    return payload.summary.trim();
  }
  if (typeof payload?.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }

  const type = eventType(payload);
  const entity = entityId(payload);
  const friendlyName = payload?.friendly_name ?? payload?.device_name ?? payload?.event?.data?.friendly_name;
  const state = payload?.to_state?.state ?? payload?.state ?? payload?.event?.data?.state;
  const label = friendlyName || entity || 'Home Assistant';
  return state ? `${label}: ${type} (${state})` : `${label}: ${type}`;
}

function priority(payload: any): EventInboxPriority {
  const severity = String(payload?.severity ?? payload?.priority ?? '').toLowerCase();
  const type = eventType(payload).toLowerCase();
  if (severity === 'high' || severity === 'critical') return 'high';
  if (type.includes('fault') || type.includes('alarm') || type.includes('battery_low')) return 'high';
  return 'normal';
}

function risk(payload: any): EventInboxRisk {
  const action = String(payload?.action ?? payload?.mode ?? '').toLowerCase();
  if (action.includes('lock') || action.includes('close') || action.includes('set_')) return 'medium';
  return 'low';
}

function occurredAt(payload: any): string | null {
  return payload?.occurred_at ?? payload?.time_fired ?? payload?.event?.time_fired ?? null;
}

export function normalizeHomeAssistantWebhook(input: HomeAssistantWebhookInput): EmitEventInput {
  const type = eventType(input.payload);
  const entity = entityId(input.payload);
  return {
    source: 'home_assistant',
    sourceEventId: input.deliveryId,
    eventType: type,
    ownerAgent: 'hank',
    routeKey: `home-assistant:${type}:${entity ?? 'general'}`,
    summary: eventSummary(input.payload),
    payload: input.payload,
    occurredAt: occurredAt(input.payload),
    priority: priority(input.payload),
    risk: risk(input.payload),
    dedupeKey: `home_assistant:${input.deliveryId}`,
  };
}
