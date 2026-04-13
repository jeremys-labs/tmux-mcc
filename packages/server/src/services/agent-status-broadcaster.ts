import type { Response } from 'express';

export type AgentStatus = 'idle' | 'thinking' | 'awaiting_input';

/**
 * Singleton SSE broadcaster for agent status changes.
 * TmuxRelay calls broadcast() when status changes; the SSE route
 * registers/unregisters client response objects.
 */
class AgentStatusBroadcaster {
  private clients = new Set<Response>();
  private statuses = new Map<string, AgentStatus>();

  addClient(res: Response): void {
    this.clients.add(res);
    // Send current known statuses on connect so client is up to date
    for (const [agentKey, status] of this.statuses) {
      res.write(`data: ${JSON.stringify({ agentKey, status })}\n\n`);
    }
  }

  removeClient(res: Response): void {
    this.clients.delete(res);
  }

  broadcast(agentKey: string, status: AgentStatus): void {
    this.statuses.set(agentKey, status);
    const payload = `data: ${JSON.stringify({ agentKey, status })}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
  }
}

export const agentStatusBroadcaster = new AgentStatusBroadcaster();
