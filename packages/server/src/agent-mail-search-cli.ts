#!/usr/bin/env node
import { searchAgentMail } from './services/agent-mail-search.js';

function main(): void {
  const args = process.argv.slice(2);
  const agentIndex = args.indexOf('--agent');
  const agent = agentIndex >= 0 ? args[agentIndex + 1] : undefined;
  const queryParts = args.filter((arg, i) => arg !== '--agent' && args[i - 1] !== '--agent');
  const query = queryParts.join(' ');

  if (!query.trim()) {
    process.stderr.write('Usage: agent-mail-search <query> [--agent <name>]\n');
    process.exit(1);
  }

  const results = searchAgentMail(query, { agent });
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

main();
