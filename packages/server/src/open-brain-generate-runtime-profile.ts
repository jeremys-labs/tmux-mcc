/**
 * Generates a compact runtime-profile.md (~≤2KB) per agent from CLAUDE.md + SOUL.md.
 * The profile is injected via the SessionStart hook instead of the full SOUL.md,
 * saving 2-4KB per fresh session for agents with large persona files.
 *
 * Usage:
 *   npm run open-brain:generate-runtime-profile --workspace=@mcc-tmux/server -- [--agent eli] [--dry-run]
 */

import fs from 'fs';
import path from 'path';

const AGENTS_ROOT = process.env.AGENTS_ROOT ?? '/Volumes/Repo-Drive/agents';
const TARGET_BYTES = 1900;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const targetAgent = args.find((a, i) => args[i - 1] === '--agent');

function parseMarkdownSections(text: string): Array<{ heading: string; level: number; body: string }> {
  const lines = text.split('\n');
  const sections: Array<{ heading: string; level: number; body: string }> = [];
  let current: { heading: string; level: number; lines: string[] } | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      if (current) sections.push({ heading: current.heading, level: current.heading.match(/^#+/)?.[0].length ?? 1, body: current.lines.join('\n').trim() });
      current = { heading: line, level: headingMatch[1].length, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push({ heading: current.heading, level: current.heading.match(/^#+/)?.[0].length ?? 1, body: current.lines.join('\n').trim() });
  return sections;
}

function truncateToFirstParagraph(text: string, maxChars = 400): string {
  const firstPara = text.split(/\n{2,}/)[0]?.trim() ?? '';
  if (firstPara.length <= maxChars) return firstPara;
  return `${firstPara.slice(0, maxChars - 3).trim()}...`;
}

function generateCompactProfile(agentDir: string, agentKey: string): string {
  const claudePath = path.join(agentDir, 'CLAUDE.md');
  const soulPath = path.join(agentDir, 'SOUL.md');
  const claudeText = fs.existsSync(claudePath) ? fs.readFileSync(claudePath, 'utf8') : '';
  const soulText = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : '';

  const claudeSections = parseMarkdownSections(claudeText);
  const soulSections = parseMarkdownSections(soulText);

  const parts: string[] = [];

  // Role + model from first lines of CLAUDE.md
  const firstLines = claudeText.split('\n').slice(0, 8).filter(Boolean);
  const roleLines = firstLines.filter((l) => l.startsWith('#') || l.includes('**Role') || l.includes('**Model') || l.includes('**Channel'));
  if (roleLines.length > 0) {
    parts.push(roleLines.join('\n'));
  }

  function findSection(sections: typeof soulSections, ...patterns: RegExp[]): typeof soulSections[0] | undefined {
    for (const p of patterns) {
      const found = sections.find((s) => p.test(s.heading));
      if (found) return found;
    }
    return undefined;
  }

  // Key soul sections: Core Personality / Core Truths (first 2 paragraphs or 500 chars)
  const coreSection = findSection(soulSections, /core personality/i, /core truth/i, /core/i);
  if (coreSection?.body) {
    parts.push(`## Core\n${truncateToFirstParagraph(coreSection.body, 500)}`);
  }

  // Vibe / How I Communicate
  const vibeSection = findSection(soulSections, /how i communicate/i, /vibe/i, /communication/i);
  if (vibeSection?.body) {
    const bullets = vibeSection.body.split('\n').filter((l) => l.trim().startsWith('-')).slice(0, 3);
    const prose = truncateToFirstParagraph(vibeSection.body, 200);
    if (bullets.length > 0) parts.push(`## Vibe\n${bullets.join('\n')}`);
    else if (prose) parts.push(`## Vibe\n${prose}`);
  }

  // Key CLAUDE.md sections: How to Answer / Default Operating Rule
  const howToAnswer = findSection(claudeSections, /how to answer/i, /default operating/i);
  if (howToAnswer?.body) {
    parts.push(`## How to Answer Jeremy\n${truncateToFirstParagraph(howToAnswer.body, 400)}`);
  }

  // Non-negotiable workflow / Architecture gate
  const nonNeg = findSection(claudeSections, /non.negotiable/i, /architecture.*gate/i, /code discipline/i);
  if (nonNeg?.body) {
    parts.push(`## Non-Negotiable\n${truncateToFirstParagraph(nonNeg.body, 300)}`);
  }

  // Ambiguous Reply / Timezone rules
  const ambiguousReply = findSection(claudeSections, /ambiguous reply/i);
  if (ambiguousReply?.body) {
    parts.push(`## Ambiguous Reply Rule\n${truncateToFirstParagraph(ambiguousReply.body, 250)}`);
  }

  const timezoneRule = findSection(claudeSections, /timezone/i);
  if (timezoneRule?.body) {
    parts.push(`## Timezone\n${truncateToFirstParagraph(timezoneRule.body, 200)}`);
  }

  // What I Value from SOUL.md
  const whatIValue = findSection(soulSections, /what i value/i, /non.negotiable/i);
  if (whatIValue?.body) {
    const bullets = whatIValue.body.split('\n').filter((l) => l.trim().startsWith('-')).slice(0, 4);
    if (bullets.length > 0) parts.push(`## What I Value\n${bullets.join('\n')}`);
  }

  const profile = parts.join('\n\n');

  // Trim if still over budget
  if (Buffer.byteLength(profile) > TARGET_BYTES) {
    return profile.slice(0, TARGET_BYTES - 3).trimEnd() + '...';
  }
  return profile;
}

const agentDirs = fs.readdirSync(AGENTS_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== 'SHARED' && !d.name.startsWith('.'))
  .map((d) => d.name)
  .filter((name) => !targetAgent || name === targetAgent)
  .sort();

let generated = 0;
let skipped = 0;

for (const agentKey of agentDirs) {
  const agentDir = path.join(AGENTS_ROOT, agentKey);
  const claudePath = path.join(agentDir, 'CLAUDE.md');
  const soulPath = path.join(agentDir, 'SOUL.md');
  if (!fs.existsSync(claudePath) && !fs.existsSync(soulPath)) { skipped++; continue; }

  const profile = generateCompactProfile(agentDir, agentKey);
  const bytes = Buffer.byteLength(profile);
  const profilePath = path.join(agentDir, 'runtime-profile.md');

  if (dryRun) {
    console.log(`[dry-run] ${agentKey}: ${bytes} bytes`);
    console.log(profile.split('\n').slice(0, 5).join('\n'));
    console.log('---');
  } else {
    fs.writeFileSync(profilePath, profile, 'utf8');
    console.log(`${agentKey}: wrote ${profilePath} (${bytes} bytes)`);
    generated++;
  }
}

if (!dryRun) {
  console.log(`\nGenerated ${generated} profiles, skipped ${skipped} dirs.`);
  console.log('Update SessionStart hooks to use runtime-profile.md via the shared startup-profile.sh script.');
}
