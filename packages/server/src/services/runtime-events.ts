import fs from 'fs';

export const RUNTIME_EVENT_NAMES = [
  'onInboundMessage',
  'beforeAgentTurn',
  'afterAgentTurn',
  'onOutboundMessage',
  'onRuntimeHealth',
  'onHandoffLoaded',
  'onHandoffConsumed',
] as const;

export type RuntimeEventName = (typeof RUNTIME_EVENT_NAMES)[number];
export type RuntimeEventSource = 'agent_mail' | 'discord' | 'runtime_handoff' | 'runtime';

export interface RuntimeEvent {
  name: RuntimeEventName;
  agent: string;
  runtime: 'claude' | 'codex' | string;
  source: RuntimeEventSource;
  messageId?: string;
  ts: string;
  metadata?: Record<string, unknown>;
}

export type RuntimeEventSink = (event: RuntimeEvent) => void | Promise<void>;
export type RuntimeEventSinkErrorHandler = (error: unknown, event: RuntimeEvent) => void;

export interface RuntimeEventEmitter {
  emit: (
    name: RuntimeEventName,
    details: Omit<RuntimeEvent, 'name' | 'agent' | 'runtime' | 'ts'>
  ) => Promise<void>;
}

export interface CreateRuntimeEventEmitterInput {
  agent: string;
  runtime: string;
  logPath?: string;
  sinks?: RuntimeEventSink[];
  now?: () => Date;
}

export interface RuntimeInboundTurnInput {
  emit: RuntimeEventEmitter['emit'];
  source: Extract<RuntimeEventSource, 'agent_mail' | 'discord'>;
  messageId: string;
  preparePrompt: () => Promise<string>;
  submitPrompt: (prompt: string) => Promise<void>;
  acknowledgeDelivery: () => Promise<void> | void;
}

export function appendRuntimeEventToLog(logPath: string): RuntimeEventSink {
  return (event) => {
    fs.appendFileSync(logPath, `${new Date().toISOString()} runtime-event ${JSON.stringify(event)}\n`);
  };
}

export async function emitRuntimeEvent(
  sinks: RuntimeEventSink[],
  event: RuntimeEvent,
  onSinkError?: RuntimeEventSinkErrorHandler
): Promise<void> {
  for (const sink of sinks) {
    try {
      await sink(event);
    } catch (error) {
      onSinkError?.(error, event);
    }
  }
}

export function createRuntimeEventEmitter(input: CreateRuntimeEventEmitterInput): RuntimeEventEmitter {
  const sinks = input.sinks ?? (input.logPath ? [appendRuntimeEventToLog(input.logPath)] : []);
  const now = input.now ?? (() => new Date());
  return {
    emit: (name, details) =>
      emitRuntimeEvent(sinks, {
        name,
        agent: input.agent,
        runtime: input.runtime,
        ts: now().toISOString(),
        ...details,
      }),
  };
}

export async function runInboundRuntimeTurn(input: RuntimeInboundTurnInput): Promise<void> {
  await input.emit('onInboundMessage', {
    source: input.source,
    messageId: input.messageId,
  });

  const prompt = await input.preparePrompt();

  await input.emit('beforeAgentTurn', {
    source: input.source,
    messageId: input.messageId,
    metadata: {
      promptLength: prompt.length,
    },
  });

  await input.submitPrompt(prompt);
  await input.acknowledgeDelivery();

  await input.emit('afterAgentTurn', {
    source: input.source,
    messageId: input.messageId,
    metadata: {
      delivery: 'acknowledged',
    },
  });
}
