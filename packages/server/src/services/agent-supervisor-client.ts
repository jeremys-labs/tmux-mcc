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

export async function fetchAgentSupervisorStatus(
  serviceUrl?: string,
): Promise<AgentSupervisorStatus> {
  const response = await fetch(new URL('/v1/agents', resolveServiceUrl(serviceUrl)), {
    signal: AbortSignal.timeout(1500),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`agent-supervisor status failed: ${response.status} ${body}`);
  }
  return JSON.parse(body) as AgentSupervisorStatus;
}

export async function planAgentSupervisorCommand(
  request: AgentSupervisorCommandRequest,
  serviceUrl?: string,
): Promise<AgentSupervisorCommandPlan> {
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
}
