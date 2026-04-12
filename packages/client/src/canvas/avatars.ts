import { createAvatar } from '@dicebear/core';
import * as pixelArt from '@dicebear/pixel-art';
import { Assets, Texture } from 'pixi.js';
import type { Options } from '@dicebear/pixel-art';
import type { AgentAvatar, AgentConfig } from '../types/agent';

// ---------------------------------------------------------------------------
// Role → DiceBear options mapping
// ---------------------------------------------------------------------------

function roleToDiceBearOpts(role: string): Partial<Options> {
  switch (role.toLowerCase()) {
    case 'chef':
      return { hat: ['variant01'], hatProbability: 100 };
    case 'research':
      return { glasses: ['dark01'], glassesProbability: 100 };
    case 'finance':
      return { glasses: ['dark03'], glassesProbability: 100, accessories: ['variant01'], accessoriesProbability: 100 };
    case 'architect':
      return { glasses: ['light01'], glassesProbability: 100 };
    case 'dev manager':
      return { accessories: ['variant02'], accessoriesProbability: 100 };
    case 'chief of staff':
      return { accessories: ['variant03'], accessoriesProbability: 100 };
    case 'qa':
      return { glasses: ['dark02'], glassesProbability: 100 };
    case 'marketing':
      return { accessories: ['variant04'], accessoriesProbability: 100 };
    case 'gym':
    case 'coach':
      return { hat: ['variant05'], hatProbability: 100 };
    case 'travel':
      return { hat: ['variant03'], hatProbability: 100 };
    case 'hr':
      return { accessories: ['variant01'], accessoriesProbability: 100 };
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Options merge
// ---------------------------------------------------------------------------

export function buildAvatarOptions(role: string, avatar: AgentAvatar | undefined): Partial<Options> {
  return { ...roleToDiceBearOpts(role), ...avatar } as Partial<Options>;
}

// ---------------------------------------------------------------------------
// SVG generation
// ---------------------------------------------------------------------------

function generateAvatarSvg(agentKey: string, role: string, colorHex: string, avatar?: AgentAvatar): string {
  const cleanColor = colorHex.startsWith('#') ? colorHex.slice(1) : colorHex;
  const merged = buildAvatarOptions(role, avatar);

  const avatar_ = createAvatar(pixelArt, {
    seed: agentKey,
    size: 128,
    backgroundColor: ['transparent'],
    clothingColor: [cleanColor],
    mouth: ['happy01', 'happy02', 'happy03', 'happy04', 'happy05'],
    ...merged,
  });

  return avatar_.toString();
}

// ---------------------------------------------------------------------------
// Texture cache
// ---------------------------------------------------------------------------

const textureCache = new Map<string, Texture>();
const blobUrls: string[] = [];

export async function loadAvatarTexture(
  key: string,
  role: string,
  colorHex: string,
  avatar?: AgentAvatar,
): Promise<Texture> {
  const cached = textureCache.get(key);
  if (cached) return cached;

  const svg = generateAvatarSvg(key, role, colorHex, avatar);
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  blobUrls.push(url);

  const texture = await Assets.load<Texture>({
    src: url,
    loadParser: 'loadSVG',
    data: {
      parseAsGraphicsContext: false,
    },
  });

  textureCache.set(key, texture);
  return texture;
}

export async function preloadAllAvatars(
  agents: Record<string, AgentConfig>,
): Promise<Map<string, Texture>> {
  const entries = Object.entries(agents);
  await Promise.all(
    entries.map(([key, agent]) =>
      loadAvatarTexture(key, agent.role, agent.color.from, agent.avatar),
    ),
  );
  return textureCache;
}

export function getAvatarTexture(key: string): Texture | undefined {
  return textureCache.get(key);
}

export function destroyAvatarTextures(): void {
  for (const url of blobUrls) {
    URL.revokeObjectURL(url);
  }
  blobUrls.length = 0;
  textureCache.clear();
}
