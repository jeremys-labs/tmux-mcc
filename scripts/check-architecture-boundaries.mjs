import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const sourceRoots = [
  path.join(repoRoot, 'packages', 'server', 'src'),
  path.join(repoRoot, 'packages', 'client', 'src'),
];
const forbidden = [
  { pattern: /agent-(?:memory|supervisor|harness)\/src/, reason: 'consume service/package contracts, not implementation source' },
  { pattern: /from ['"][^'"]*\/packages\/server\/src\//, reason: 'do not import MCC server internals across ownership boundaries' },
];

function sourceFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const location = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(location);
    return /\.(?:ts|tsx|js|mjs)$/.test(entry.name) ? [location] : [];
  });
}

const violations = [];
for (const file of sourceRoots.flatMap(sourceFiles)) {
  const text = fs.readFileSync(file, 'utf8');
  for (const rule of forbidden) {
    if (rule.pattern.test(text)) {
      violations.push(`${path.relative(repoRoot, file)}: ${rule.reason}`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`Architecture boundary violations:\n${violations.map((line) => `- ${line}`).join('\n')}\n`);
  process.exit(1);
}

process.stdout.write('Architecture boundaries clean.\n');
