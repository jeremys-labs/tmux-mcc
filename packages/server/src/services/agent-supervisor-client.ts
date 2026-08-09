import { isTransientNetworkError, withRetry, type RetryOptions } from './retry.js';

export interface AgentSupervisorStatus {
  mode: string;
  agents: Array<{
    agent: string;
    runtime: string;
    process: { status: string; pid: number };
    progress: {
      status: string;
      detail: string;
      activeSince?: string;
      activeMessageId?: string;
    };
  }>;
}

export interface AgentSupervisorCommandPlan {
  requestId: string;
  mode: 'dry-run';
  operation: 'restart' | 'switch-runtime';
  agent: string;
  currentRuntime: string;
  targetRuntime: string;
  proposedCommand: string[];
}

export interface AgentSupervisorCommandRequest {
  requestId: string;
  operation: 'restart' | 'switch-runtime';
  agent: string;
  runtime?: 'claude' | 'codex';
}

function resolveServiceUrl(serviceUrl?: string): string {
  return serviceUrl ?? process.env.AGENT_SUPERVISOR_URL ?? 'http://127.0.0.1:4318';
}

function isRetryableSupervisorError(error: unknown): boolean {
  if (isTransientNetworkError(error)) return true;
  return error instanceof Error && /agent-supervisor \S+(?: \S+)? failed: (?:408|425|429|5\d\d)\b/.test(error.message);
}

export async function fetchAgentSupervisorStatus(
  serviceUrl?: string,
  retryOptions: Pick<RetryOptions, 'maxAttempts' | 'retryDelayMs'> = {},
): Promise<AgentSupervisorStatus> {
  return withRetry(
    async () => {
      const response = await fetch(new URL('/v1/agents', resolveServiceUrl(serviceUrl)), {
        signal: AbortSignal.timeout(1500),
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`agent-supervisor status failed: ${response.status} ${body}`);
      }
      return JSON.parse(body) as AgentSupervisorStatus;
    },
    { maxAttempts: 3, retryDelayMs: 200, ...retryOptions, isRetryable: isRetryableSupervisorError },
  );
}

export async function planAgentSupervisorCommand(
  request: AgentSupervisorCommandRequest,
  serviceUrl?: string,
  retryOptions: Pick<RetryOptions, 'maxAttempts' | 'retryDelayMs'> = {},
): Promise<AgentSupervisorCommandPlan> {
  return withRetry(
    async () => {
      const response = await fetch(new URL('/v1/commands/plan', resolveServiceUrl(serviceUrl)), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(1500),
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`agent-supervisor command plan failed: ${response.status} ${body}`);
      }
      return JSON.parse(body) as AgentSupervisorCommandPlan;
    },
    { maxAttempts: 3, retryDelayMs: 200, ...retryOptions, isRetryable: isRetryableSupervisorError },
  );
}
