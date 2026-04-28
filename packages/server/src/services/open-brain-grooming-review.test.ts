import { describe, expect, it } from 'vitest';
import { buildPromotedContent, classifyRawCapture, reviewedMetadata, type GroomingReviewRow } from './open-brain-grooming-review.js';

describe('open brain grooming review', () => {
  const row: GroomingReviewRow = {
    id: 'thought-1',
    content: [
      'Raw capture candidate for eli from Discord.',
      'At 2026-04-28T00:00:00Z, Jeremy wrote:',
      'Durable decision text.',
      'This is a candidate runtime capture for later grooming, not source-of-truth memory.',
    ].join('\n'),
    metadata: {
      scope: 'raw_capture',
      source_ref: 'discord:1',
      project: 'ob1-memory',
    },
  };

  it('builds promoted content from the useful body of a raw capture', () => {
    expect(buildPromotedContent(row)).toBe('At 2026-04-28T00:00:00Z, Jeremy wrote:\nDurable decision text.');
  });

  it('uses explicit content override when provided', () => {
    expect(buildPromotedContent(row, 'Reviewed memory.')).toBe('Reviewed memory.');
  });

  it('marks raw capture metadata as reviewed without dropping provenance', () => {
    const metadata = reviewedMetadata(row, 'promoted', 'eli', { grooming_promoted_scope: 'project' });

    expect(metadata.source_ref).toBe('discord:1');
    expect(metadata.scope).toBe('raw_capture');
    expect(metadata.grooming_status).toBe('promoted');
    expect(metadata.grooming_reviewed_by).toBe('eli');
    expect(metadata.grooming_promoted_scope).toBe('project');
    expect(typeof metadata.grooming_reviewed_at).toBe('string');
  });

  it('auto-ignores routine acknowledgements', () => {
    const classification = classifyRawCapture({
      ...row,
      content: 'Okay',
      metadata: { ...row.metadata, source_type: 'discord', confidence: 'medium' },
    });

    expect(classification.action).toBe('auto_ignore');
  });

  it('routes shared-team or source-of-truth content to review', () => {
    const classification = classifyRawCapture({
      ...row,
      content: 'Jeremy approved this as shared_team source_of_truth memory.',
      metadata: { ...row.metadata, source_type: 'discord', confidence: 'medium' },
    });

    expect(classification.action).toBe('needs_review');
  });

  it('auto-promotes project agent-mail as project context', () => {
    const classification = classifyRawCapture({
      ...row,
      content: 'Raw capture candidate.\nFrontDesk project decision text.',
      metadata: { ...row.metadata, project: 'frontdesk', source_type: 'agent_mail', confidence: 'medium' },
    });

    expect(classification.action).toBe('auto_promote_project');
    expect(classification.scope).toBe('project');
  });

  it('auto-promotes ordinary non-runtime captures to private context', () => {
    const classification = classifyRawCapture({
      ...row,
      content: 'Raw capture candidate.\nEli should remember this local preference.',
      metadata: { ...row.metadata, project: 'ob1-memory', source_type: 'manual', confidence: 'medium' },
    });

    expect(classification.action).toBe('auto_promote_private');
    expect(classification.scope).toBe('private_agent');
  });
});
