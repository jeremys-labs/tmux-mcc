import { describe, expect, it } from 'vitest';
import { buildMemoryAuditSummary, formatMemoryAuditReport, type MemoryAuditRow } from './open-brain-memory-audit.js';

describe('open brain memory audit', () => {
  it('tracks baseline defaults and enriched rows', () => {
    const rows: MemoryAuditRow[] = [
      {
        importance: 3,
        quality_score: 50,
        sensitivity_tier: 'standard',
        enriched: false,
        source_type: 'discord_reply',
        metadata: { scope: 'raw_capture', authority: 'raw_capture' },
      },
      {
        importance: 4,
        quality_score: 82,
        sensitivity_tier: 'personal',
        enriched: true,
        source_type: 'agent_mail_capture',
        metadata: { scope: 'project', authority: 'context' },
      },
    ];

    const summary = buildMemoryAuditSummary(rows);

    expect(summary.total).toBe(2);
    expect(summary.enriched).toBe(1);
    expect(summary.unenriched).toBe(1);
    expect(summary.allDefaults).toBe(1);
    expect(summary.scopeCounts.get('raw_capture')).toBe(1);
    expect(summary.scopeCounts.get('project')).toBe(1);
    expect(summary.authorityCounts.get('raw_capture')).toBe(1);
    expect(summary.authorityCounts.get('context')).toBe(1);
    expect(summary.sourceTypeCounts.get('discord_reply')).toBe(1);
  });

  it('formats a clear warning when everything is still baseline', () => {
    const report = formatMemoryAuditReport(buildMemoryAuditSummary([{
      importance: 3,
      quality_score: 50,
      sensitivity_tier: 'standard',
      enriched: false,
      metadata: { scope: 'raw_capture', authority: 'raw_capture' },
    }]));

    expect(report).toContain('Status: all rows are still at the baseline metadata shape.');
    expect(report).toContain('Action: run sensitivity backfill and enrichment, then re-run the audit.');
  });
});
