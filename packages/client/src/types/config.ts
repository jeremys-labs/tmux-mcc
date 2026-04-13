import type { AgentConfig } from './agent';

export interface BrandingConfig {
  name: string;
  shortName: string;
  description?: string;
}

export interface AppConfig {
  branding: BrandingConfig;
  agents: Record<string, AgentConfig>;
  sidecarPort?: number;
}
