import express from 'express';
import type { EventInboxStore } from '../services/event-inbox.js';
import { normalizeGitHubWebhook, verifyGitHubSignature } from '../services/github-webhook.js';
import {
  homeAssistantDeliveryId,
  normalizeHomeAssistantWebhook,
  verifyHomeAssistantToken,
} from '../services/home-assistant-webhook.js';

export interface WebhookRouterOptions {
  githubSecret?: string;
  homeAssistantToken?: string;
}

export function createWebhookRouter(eventInbox: EventInboxStore, options: WebhookRouterOptions = {}) {
  const router = express.Router();

  router.post('/webhooks/github', (req, res) => {
    const githubSecret = options.githubSecret ?? process.env.GITHUB_WEBHOOK_SECRET;
    if (!githubSecret) {
      res.status(503).json({ error: 'GITHUB_WEBHOOK_SECRET is not configured' });
      return;
    }

    const rawBody = (req as any).rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      res.status(500).json({ error: 'raw webhook body was not captured' });
      return;
    }

    const signature = req.header('x-hub-signature-256');
    if (!verifyGitHubSignature(rawBody, signature, githubSecret)) {
      res.status(401).json({ error: 'invalid GitHub webhook signature' });
      return;
    }

    const eventName = req.header('x-github-event');
    const deliveryId = req.header('x-github-delivery');
    if (!eventName || !deliveryId) {
      res.status(400).json({ error: 'missing GitHub event headers' });
      return;
    }

    const event = normalizeGitHubWebhook({ eventName, deliveryId, payload: req.body });
    if (!event) {
      res.status(202).json({ ok: true, ignored: true });
      return;
    }

    const record = eventInbox.emitEvent(event);
    res.status(record.duplicate ? 200 : 202).json({
      ok: true,
      duplicate: record.duplicate,
      id: record.id,
      ownerAgent: record.ownerAgent,
      routeKey: record.routeKey,
    });
  });

  router.post('/webhooks/home-assistant', (req, res) => {
    const homeAssistantToken = options.homeAssistantToken ?? process.env.HOME_ASSISTANT_WEBHOOK_TOKEN;
    if (!homeAssistantToken) {
      res.status(503).json({ error: 'HOME_ASSISTANT_WEBHOOK_TOKEN is not configured' });
      return;
    }

    const rawBody = (req as any).rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      res.status(500).json({ error: 'raw webhook body was not captured' });
      return;
    }

    if (!verifyHomeAssistantToken(req.header('authorization'), req.header('x-webhook-token'), homeAssistantToken)) {
      res.status(401).json({ error: 'invalid Home Assistant webhook token' });
      return;
    }

    const deliveryId = req.header('x-event-id') ?? req.header('x-request-id') ?? homeAssistantDeliveryId(rawBody);
    const event = normalizeHomeAssistantWebhook({ deliveryId, payload: req.body });
    const record = eventInbox.emitEvent(event);
    res.status(record.duplicate ? 200 : 202).json({
      ok: true,
      duplicate: record.duplicate,
      id: record.id,
      ownerAgent: record.ownerAgent,
      routeKey: record.routeKey,
    });
  });

  return router;
}
