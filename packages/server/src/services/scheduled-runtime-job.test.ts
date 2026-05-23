import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildScheduledRuntimeJobPlan,
  readAgentRuntime,
  runtimeFromExecutor,
} from './scheduled-runtime-job.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-runtime-job-'));
  const openBrainRoot = path.join(dir, 'open-brain');
  const agentDir = path.join(dir, 'agents', 'isla');
  fs.mkdirSync(path.join(agentDir, '.claude', 'discord'), { recursive: true });
  fs.mkdirSync(path.join(agentDir, '.open-brain'), { recursive: true });
  fs.mkdirSync(path.join(openBrainRoot, 'credentials'), { recursive: true });
  fs.writeFileSync(path.join(agentDir, '.claude', 'discord', 'access.json'), '{}');
  fs.writeFileSync(path.join(agentDir, '.open-brain', 'memory.env'), 'AGENT_MEMORY_AGENT_ID=isla\nAGENT_MEMORY_KEY=amk_test\n');
  fs.writeFileSync(path.join(openBrainRoot, 'credentials', 'ob1.env'), 'SUPABASE_PROJECT_URL=https://example.test\n');
  fs.writeFileSync(path.join(openBrainRoot, 'credentials', 'mcp-access-key.txt'), 'mcp_test\n');
  return { dir, openBrainRoot, agentDir };
}

describe('scheduled runtime jobs', () => {
  it('builds Claude print jobs with projected MCP and Discord guardrails', () => {
    const f = fixture();
    const plan = buildScheduledRuntimeJobPlan({
      agent: 'isla',
      agentDir: f.agentDir,
      runtime: 'claude',
      prompt: 'Send the newsletter',
      appendSystemPrompt: 'recall context',
      discordStateDir: path.join(f.agentDir, '.claude', 'discord'),
      claudeBin: 'claude-test',
    });

    expect(plan.command).toBe('claude-test');
    expect(plan.cwd).toBe(f.agentDir);
    expect(plan.env.DISCORD_STATE_DIR).toContain('.claude/discord');
    expect(plan.args).toContain('--print');
    expect(plan.args).toContain('--mcp-config');
    expect(plan.args).toContain('--append-system-prompt');
    expect(plan.args).toContain('--disallowedTools');

    const mcp = JSON.parse(fs.readFileSync(path.join(f.agentDir, '.mcp.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(expect.arrayContaining(['open-brain']));
    expect(Object.keys(mcp.mcpServers)).not.toContain('plugin_discord_discord');
  });

  it('builds Codex exec jobs without Claude MCP projection', () => {
    const f = fixture();
    const plan = buildScheduledRuntimeJobPlan({
      agent: 'isla',
      agentDir: f.agentDir,
      runtime: 'codex',
      prompt: 'Review the cache',
      appendSystemPrompt: 'context first',
      model: 'gpt-5.4',
      codexBin: 'codex-test',
    });

    expect(plan.command).toBe('codex-test');
    expect(plan.args.slice(0, 5)).toEqual(['-a', 'never', '-m', 'gpt-5.4', '-C']);
    expect(plan.args).toContain('exec');
    expect(plan.args.at(-1)).toBe('context first\n\nReview the cache');
    expect(fs.existsSync(path.join(f.agentDir, '.mcp.json'))).toBe(false);
  });

  it('uses explicit executor over runtime marker', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.agentDir, '.runtime'), 'codex\n');
    expect(readAgentRuntime(f.agentDir)).toBe('codex');
    expect(runtimeFromExecutor('claude', f.agentDir)).toBe('claude');
    expect(runtimeFromExecutor(undefined, f.agentDir)).toBe('codex');
  });
});
