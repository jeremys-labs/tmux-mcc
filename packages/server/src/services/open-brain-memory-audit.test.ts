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
    expect(summary.missingOwnerAgent).toBe(2);
    expect(summary.missingSourceRef).toBe(2);
    expect(summary.scopeCounts.get('raw_capture')).toBe(1);
    expect(summary.scopeCounts.get('project')).toBe(1);
    expect(summary.authorityCounts.get('raw_capture')).toBe(1);
    expect(summary.authorityCounts.get('context')).toBe(1);
    expect(summary.sensitivityCounts.get('standard')).toBe(1);
    expect(summary.sensitivityCounts.get('personal')).toBe(1);
    expect(summary.qualityBandCounts.get('40-59')).toBe(1);
    expect(summary.qualityBandCounts.get('80-100')).toBe(1);
    expect(summary.scopeAuthorityCounts.get('raw_capture/raw_capture')).toBe(1);
    expect(summary.scopeSensitivityCounts.get('project/personal')).toBe(1);
    expect(summary.sourceTypeCounts.get('discord_reply')).toBe(1);
  });

  it('tracks malformed governance combinations', () => {
    const summary = buildMemoryAuditSummary([
      {
        quality_score: 92,
        sensitivity_tier: 'restricted',
        enriched: true,
        metadata: {
          scope: 'raw_capture',
          authority: 'context',
          owner_agent: 'eli',
          source_ref: 'discord:1',
        },
      },
      {
        quality_score: 70,
        sensitivity_tier: 'personal',
        enriched: true,
        metadata: {
          scope: 'shared_team',
          authority: 'source_of_truth',
          owner_agent: 'isla',
          source_ref: 'agent-mail:1',
        },
      },
      {
        quality_score: null,
        sensitivity_tier: null,
        enriched: false,
        metadata: {},
      },
    ]);

    expect(summary.missingScope).toBe(1);
    expect(summary.missingAuthority).toBe(1);
    expect(summary.missingOwnerAgent).toBe(1);
    expect(summary.missingSourceRef).toBe(1);
    expect(summary.malformedRawCaptureAuthority).toBe(1);
    expect(summary.unapprovedSharedSourceOfTruth).toBe(1);

    const report = formatMemoryAuditReport(summary);
    expect(report).toContain('Scope/authority:');
    expect(report).toContain('raw_capture bad auth:   1');
    expect(report).toContain('unapproved team truth:  1');
    expect(report).toContain('Action: repair malformed governance metadata');
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
