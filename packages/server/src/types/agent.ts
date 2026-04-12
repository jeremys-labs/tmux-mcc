export interface AgentColor {
  from: string;
  to: string;
}

export interface AgentTab {
  id: string;
  label: string;
  icon: string;
  source: string;
  renderer?: 'default' | 'chart' | 'markdown' | 'table';
}

export interface AgentPosition {
  zone: string;
  x: number;
  y: number;
}

export interface AgentAvatar {
  hair?: string[];
  hairColor?: string[];
  beard?: string[];
  beardProbability?: number;
  glasses?: string[];
  glassesProbability?: number;
  hat?: string[];
  hatProbability?: number;
  accessories?: string[];
  accessoriesProbability?: number;
  clothing?: string[];
  skinColor?: string[];
}

export interface HarnessConfig {
  adapter: 'claude-code' | 'codex';
  cwd: string;
  modelConfig?: Record<string, unknown>;
}

export interface AgentConfig {
  name: string;
  fullName?: string;
  role: string;
  emoji: string;
  sprite?: string;
  color: AgentColor;
  channel: string;
  greeting: string;
  quote?: string;
  voice?: string;
  model?: string;
  position: AgentPosition;
  tabs: AgentTab[];
  avatar?: AgentAvatar;
  providerType?: 'llm' | 'persistent-harness';
  harnessConfig?: HarnessConfig;
}
