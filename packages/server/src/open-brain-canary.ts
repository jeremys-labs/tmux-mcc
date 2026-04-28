import process from 'process';
import {
  callOpenBrainTool,
  resolveOpenBrainRuntimeConfig,
} from './services/open-brain-runtime.js';

const DEFAULT_OPEN_BRAIN_ENV_PATH = '/Volumes/Repo-Drive/src/open-brain/credentials/ob1.env';

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return env;
}

async function readOpenBrainEnv(): Promise<Record<string, string>> {
  const fs = await import('fs/promises');
  const filePath = process.env.OPEN_BRAIN_ENV_PATH ?? DEFAULT_OPEN_BRAIN_ENV_PATH;
  return parseEnv(await fs.readFile(filePath, 'utf8'));
}

async function deleteBySourceRef(sourceRefs: string[]): Promise<void> {
  const env = await readOpenBrainEnv();
  const projectUrl = env.SUPABASE_PROJECT_URL;
  const serviceKey = env.SUPABASE_SECRET_KEY;
  if (!projectUrl || !serviceKey) {
    throw new Error('Missing SUPABASE_PROJECT_URL or SUPABASE_SECRET_KEY in Open Brain env');
  }

  for (const sourceRef of sourceRefs) {
    const url = new URL('/rest/v1/thoughts', projectUrl);
    url.searchParams.set('metadata->>source_ref', `eq.${sourceRef}`);
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to delete canary ${sourceRef}: ${response.status} ${await response.text()}`);
    }
  }
}

function assertIncludes(haystack: string, needle: string, label: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${label} did not include ${needle}`);
  }
}

function assertExcludes(haystack: string, needle: string, label: string): void {
  if (haystack.includes(needle)) {
    throw new Error(`${label} unexpectedly included ${needle}`);
  }
}

async function main(): Promise<void> {
  const eli = resolveOpenBrainRuntimeConfig('eli');
  const isla = resolveOpenBrainRuntimeConfig('isla');
  if (!eli || !isla) {
    throw new Error('Missing Open Brain runtime config for eli or isla');
  }

  const stamp = `ob1-canary-${Date.now()}`;
  const eliPrivate = `${stamp}-eli-private`;
  const islaPrivate = `${stamp}-isla-private`;
  const sharedProject = `${stamp}-shared-project`;
  const refs = [
    `canary:${stamp}:eli-private`,
    `canary:${stamp}:isla-private`,
    `canary:${stamp}:shared-project`,
  ];

  try {
    await callOpenBrainTool(eli, 'capture_agent_memory', {
      agent_id: 'eli',
      scope: 'private_agent',
      project: 'ob1-canary',
      audience: ['eli'],
      authority: 'context',
      confidence: 'high',
      source_type: 'policy_test',
      source_ref: refs[0],
      content: `${eliPrivate}: OB1-only canary memory owned by Eli. It is not written to local markdown or claude-mem.`,
    });

    await callOpenBrainTool(isla, 'capture_agent_memory', {
      agent_id: 'isla',
      scope: 'private_agent',
      project: 'ob1-canary',
      audience: ['isla'],
      authority: 'context',
      confidence: 'high',
      source_type: 'policy_test',
      source_ref: refs[1],
      content: `${islaPrivate}: OB1-only canary memory owned by Isla. It is not written to local markdown or claude-mem.`,
    });

    await callOpenBrainTool(eli, 'capture_agent_memory', {
      agent_id: 'eli',
      scope: 'project',
      project: 'ob1-canary',
      audience: ['eli', 'isla'],
      authority: 'context',
      confidence: 'high',
      source_type: 'policy_test',
      source_ref: refs[2],
      content: `${sharedProject}: OB1-only shared project canary memory readable by Eli and Isla.`,
    });

    const eliSearch = await callOpenBrainTool(eli, 'search_agent_memory', {
      agent_id: 'eli',
      query: stamp,
      project: 'ob1-canary',
      limit: 10,
      threshold: 0.1,
    });
    const islaSearch = await callOpenBrainTool(isla, 'search_agent_memory', {
      agent_id: 'isla',
      query: stamp,
      project: 'ob1-canary',
      limit: 10,
      threshold: 0.1,
    });

    assertIncludes(eliSearch.text, eliPrivate, 'Eli search');
    assertIncludes(eliSearch.text, sharedProject, 'Eli search');
    assertExcludes(eliSearch.text, islaPrivate, 'Eli search');

    assertIncludes(islaSearch.text, islaPrivate, 'Isla search');
    assertIncludes(islaSearch.text, sharedProject, 'Isla search');
    assertExcludes(islaSearch.text, eliPrivate, 'Isla search');

    console.log(JSON.stringify({
      ok: true,
      stamp,
      checks: {
        eliSeesOwnPrivate: true,
        eliSeesSharedProject: true,
        eliBlockedFromIslaPrivate: true,
        islaSeesOwnPrivate: true,
        islaSeesSharedProject: true,
        islaBlockedFromEliPrivate: true,
      },
    }, null, 2));
  } finally {
    await deleteBySourceRef(refs);
  }
}

main().catch((error) => {
  console.error(`[open-brain-canary] ${String(error)}`);
  process.exit(1);
});
