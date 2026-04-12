export interface ChatMessage {
  seq: number;
  agent: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export type SSEEventType =
  | 'connected'
  | 'message.delta'
  | 'message.final'
  | 'message.error'
  | 'message.aborted'
  | 'message.side_result'
  | 'context.update';
