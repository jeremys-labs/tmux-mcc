import fs from 'fs';
import path from 'path';

const AGENTS_ROOT = process.env.AGENTS_ROOT ?? '/Volumes/Repo-Drive/agents';
const BUDGET_BYTES = 12000;

const AGENT_DIRS = fs.readdirSync(AGENTS_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== 'SHARED' && !d.name.startsWith('.'))
  .map((d) => d.name)
  .sort();

interface AgentReport {
  agent: string;
  claudeMd: number;
  soulMd: number;
  agentsMd: number;
  runtimeProfile: number;
  total: number;
  overBudget: boolean;
  hasDuplicateAgentsMd: boolean;
  hasCompactProfile: boolean;
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

const reports: AgentReport[] = AGENT_DIRS.map((agent) => {
  const dir = path.join(AGENTS_ROOT, agent);
  const claudeMd = fileSize(path.join(dir, 'CLAUDE.md'));
  const soulMd = fileSize(path.join(dir, 'SOUL.md'));
  const agentsMd = fileSize(path.join(dir, 'AGENTS.md'));
  const runtimeProfile = fileSize(path.join(dir, 'runtime-profile.md'));
  const total = claudeMd + soulMd;
  return {
    agent,
    claudeMd,
    soulMd,
    agentsMd,
    runtimeProfile,
    total,
    overBudget: total > BUDGET_BYTES,
    hasDuplicateAgentsMd: agentsMd > 0 && agentsMd === claudeMd,
    hasCompactProfile: runtimeProfile > 0,
  };
}).filter((r) => r.claudeMd > 0 || r.soulMd > 0);

const header = `Agent persona size report (budget: ${BUDGET_BYTES} bytes per agent CLAUDE+SOUL)`;
const divider = '─'.repeat(80);
console.log(header);
console.log(divider);
console.log(`${'AGENT'.padEnd(12)} ${'CLAUDE'.padStart(7)} ${'SOUL'.padStart(7)} ${'TOTAL'.padStart(7)} ${'PROFILE'.padStart(8)} ${'FLAGS'}`);
console.log(divider);

let warnings = 0;
for (const r of reports) {
  const flags: string[] = [];
  if (r.overBudget) { flags.push('OVER_BUDGET'); warnings++; }
  if (r.hasDuplicateAgentsMd) { flags.push('AGENTS.md_duplicate'); warnings++; }
  if (!r.hasCompactProfile) flags.push('no_profile');
  const line = [
    r.agent.padEnd(12),
    String(r.claudeMd).padStart(7),
    String(r.soulMd).padStart(7),
    String(r.total).padStart(7),
    (r.runtimeProfile > 0 ? String(r.runtimeProfile) : '—').padStart(8),
    flags.length > 0 ? `  ⚠ ${flags.join(', ')}` : '  ✓',
  ].join(' ');
  console.log(line);
}

console.log(divider);
if (warnings > 0) {
  console.log(`\n${warnings} warning(s). To fix AGENTS.md duplicates, archive the file:`);
  console.log('  mv agents/marcus/AGENTS.md agents/marcus/AGENTS.md.archived');
  console.log('To reduce an over-budget agent, trim CLAUDE.md or generate a compact runtime-profile.md.');
  process.exitCode = 1;
} else {
  console.log('\nAll agents within budget.');
}
