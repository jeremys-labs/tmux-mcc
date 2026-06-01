import { describe, expect, it } from 'vitest';
import {
  homeAssistantDeliveryId,
  normalizeHomeAssistantWebhook,
  verifyHomeAssistantToken,
} from './home-assistant-webhook.js';

describe('Home Assistant webhook adapter', () => {
  it('verifies either bearer or x-webhook-token shared secrets', () => {
    expect(verifyHomeAssistantToken('Bearer ha-secret', undefined, 'ha-secret')).toBe(true);
    expect(verifyHomeAssistantToken(undefined, 'ha-secret', 'ha-secret')).toBe(true);
    expect(verifyHomeAssistantToken('Bearer wrong', undefined, 'ha-secret')).toBe(false);
    expect(verifyHomeAssistantToken(undefined, undefined, 'ha-secret')).toBe(false);
  });

  it('uses raw body hash as a stable delivery id when Home Assistant does not supply one', () => {
    const rawBody = Buffer.from(JSON.stringify({ event_type: 'battery_low', entity_id: 'lock.front_door' }));
    expect(homeAssistantDeliveryId(rawBody)).toBe(homeAssistantDeliveryId(rawBody));
    expect(homeAssistantDeliveryId(rawBody)).toHaveLength(64);
  });

  it('routes notify-only home automation events to Hank', () => {
    const event = normalizeHomeAssistantWebhook({
      deliveryId: 'ha-delivery-1',
      payload: {
        event_type: 'battery_low',
        entity_id: 'lock.front_door',
        friendly_name: 'Front door lock',
        state: '18%',
        time_fired: '2026-06-01T22:00:00Z',
      },
    });

    expect(event).toMatchObject({
      source: 'home_assistant',
      sourceEventId: 'ha-delivery-1',
      eventType: 'battery_low',
      ownerAgent: 'hank',
      routeKey: 'home-assistant:battery_low:lock.front_door',
      summary: 'Front door lock: battery_low (18%)',
      occurredAt: '2026-06-01T22:00:00Z',
      priority: 'high',
      risk: 'low',
      dedupeKey: 'home_assistant:ha-delivery-1',
    });
  });

  it('marks actuation-shaped events as medium risk while still routing through Hank', () => {
    const event = normalizeHomeAssistantWebhook({
      deliveryId: 'ha-delivery-2',
      payload: {
        event_type: 'lock_check',
        entity_id: 'lock.front_door',
        action: 'lock door',
        summary: 'Front door unlocked at 10pm',
      },
    });

    expect(event).toMatchObject({
      ownerAgent: 'hank',
      summary: 'Front door unlocked at 10pm',
      risk: 'medium',
    });
  });
});
