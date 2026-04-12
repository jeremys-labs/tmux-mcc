import type { AgentConfig } from './agent';

export interface BrandingConfig {
  name: string;
  shortName: string;
  description?: string;
}

export interface GatewayConfig {
  url: string;
  token: string;
}

export interface AppConfig {
  branding: BrandingConfig;
  gateway: GatewayConfig;
  agents: Record<string, AgentConfig>;
  sidecarPort?: number;
}
