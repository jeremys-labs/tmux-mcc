import fs from 'fs';
import path from 'path';

interface OpenClawModelConfig {
  defaults?: {
    model?: { primary?: string };
  };
  list?: Array<{
    id: string;
    model?: { primary?: string };
  }>;
}

export function formatModelName(modelId: string): string {
  const raw = modelId.includes('/') ? modelId.split('/').pop()! : modelId;

  const claudeMatch = raw.match(/^claude-(\w+)-([\d]+)-([\d]+)$/);
  if (claudeMatch) {
    const name = claudeMatch[1].charAt(0).toUpperCase() + claudeMatch[1].slice(1);
    return `${name} ${claudeMatch[2]}.${claudeMatch[3]}`;
  }

  const gptMatch = raw.match(/^gpt-([\d.]+)(?:-(.+))?$/);
  if (gptMatch) {
    const suffix = gptMatch[2]
      ? ' ' + gptMatch[2].charAt(0).toUpperCase() + gptMatch[2].slice(1)
      : '';
    return `GPT ${gptMatch[1]}${suffix}`;
  }

  return raw;
}

export function resolveAgentModels(
  agentKeys: string[],
  agentsSection: OpenClawModelConfig
): Record<string, string> {
  const globalPrimary = agentsSection.defaults?.model?.primary ?? '';
  const agentList = agentsSection.list ?? [];

  const result: Record<string, string> = {};
  for (const key of agentKeys) {
    const entry = agentList.find((a) => a.id === key);
    const modelId = entry?.model?.primary ?? globalPrimary;
    result[key] = modelId ? formatModelName(modelId) : '';
  }
  return result;
}

export function loadAgentModels(contentRoot: string, agentKeys: string[]): Record<string, string> {
  const jsonPath = path.join(contentRoot, 'openclaw.json');
  if (!fs.existsSync(jsonPath)) return {};

  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const agentsSection = raw.agents as OpenClawModelConfig | undefined;
  if (!agentsSection) return {};

  return resolveAgentModels(agentKeys, agentsSection);
}
