export const CELLEBRITE_RESTRICTION = 'cellebrite';
export const RESTRICTED_SCOPE = 'restricted';
export const CELLEBRITE_OWNER_AGENT = 'isla';
export const CELLEBRITE_PROJECT = 'cellebrite';

export interface RestrictedMemoryMetadata {
  scope?: unknown;
  restriction?: unknown;
  owner_agent?: unknown;
  project?: unknown;
}

export function parseRestrictedChannelIds(raw = process.env.OPEN_BRAIN_CELLEBRITE_CHANNEL_IDS ?? ''): Set<string> {
  return new Set(raw.split(',').map((id) => id.trim()).filter(Boolean));
}

export function hasCellebritePrefix(content: string): boolean {
  return /^\s*Cellebrite\s*(?:--|—)\s*/i.test(content);
}

export function stripCellebritePrefix(content: string): string {
  return content.replace(/^\s*Cellebrite\s*(?:--|—)\s*/i, '').trim();
}

export function isCellebriteRestrictedMetadata(metadata?: RestrictedMemoryMetadata | null): boolean {
  return metadata?.scope === RESTRICTED_SCOPE || metadata?.restriction === CELLEBRITE_RESTRICTION;
}

export function shouldRestrictCellebriteCapture(input: {
  content: string;
  channelId?: string;
  restrictedChannelIds?: Set<string>;
}): boolean {
  const channelIds = input.restrictedChannelIds ?? parseRestrictedChannelIds();
  return hasCellebritePrefix(input.content) || Boolean(input.channelId && channelIds.has(input.channelId));
}

export function canSearchRestrictedCellebrite(input: {
  agentKey: string;
  text: string;
  channelId?: string;
  restrictedChannelIds?: Set<string>;
}): boolean {
  if (input.agentKey !== CELLEBRITE_OWNER_AGENT) return false;
  if (shouldRestrictCellebriteCapture({
    content: input.text,
    channelId: input.channelId,
    restrictedChannelIds: input.restrictedChannelIds,
  })) {
    return true;
  }
  return /\bCellebrite\b/i.test(input.text);
}

export function filterRestrictedRows<T extends { metadata?: RestrictedMemoryMetadata | null }>(rows: T[]): T[] {
  return rows.filter((row) => !isCellebriteRestrictedMetadata(row.metadata));
}
