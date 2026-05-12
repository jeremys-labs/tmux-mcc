import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';

const mockDbAll = vi.fn();
const mockDbClose = vi.fn();
const mockDbPrepare = vi.fn(() => ({ all: mockDbAll }));
const MockDatabase = vi.fn(() => ({ prepare: mockDbPrepare, close: mockDbClose }));

vi.mock('better-sqlite3', () => ({ default: MockDatabase }));
vi.mock('@agent-comms/mailbox', () => ({
  resolveAgentMailDbPath: vi.fn(() => path.join(os.homedir(), '.agent-comms', 'mailbox', 'agent_mail.db')),
}));

const existsSyncMock = vi.fn(() => true);
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, default: { ...actual, existsSync: existsSyncMock } };
});

const { listAgentMailMessages } = await import('../routes/channels.js');

describe('listAgentMailMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
  });

  it('maps DB rows to ChannelInteraction shape', () => {
    mockDbAll.mockReturnValue([
      {
        from_agent: 'marcus',
        to_agent: 'eli',
        type: 'handoff',
        subject: 'PR ready for review',
        body_md: 'The channels rewrite is on branch marcus/channels-from-agent-mail.',
        created_at: '2026-05-12T10:00:00.000Z',
      },
    ]);

    const result = listAgentMailMessages();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      from: 'marcus',
      to: 'eli',
      type: 'handoff',
      subject: 'PR ready for review',
      content: 'The channels rewrite is on branch marcus/channels-from-agent-mail.',
      timestamp: '2026-05-12T10:00:00.000Z',
    });
  });

  it('returns empty array when the DB file does not exist', () => {
    existsSyncMock.mockReturnValue(false);

    const result = listAgentMailMessages();

    expect(result).toEqual([]);
    expect(MockDatabase).not.toHaveBeenCalled();
  });

  it('passes the limit to the SQLite query', () => {
    mockDbAll.mockReturnValue([]);

    listAgentMailMessages(50);

    expect(mockDbAll).toHaveBeenCalledWith(50);
  });

  it('closes the DB connection even when rows are empty', () => {
    mockDbAll.mockReturnValue([]);

    listAgentMailMessages();

    expect(mockDbClose).toHaveBeenCalledOnce();
  });

  it('maps multiple rows in order', () => {
    mockDbAll.mockReturnValue([
      { from_agent: 'isla', to_agent: 'marcus', type: 'task', subject: 'Ship it', body_md: 'Go.', created_at: '2026-05-12T12:00:00.000Z' },
      { from_agent: 'harper', to_agent: 'isla', type: 'note', subject: 'Done', body_md: 'Tests pass.', created_at: '2026-05-12T11:00:00.000Z' },
    ]);

    const result = listAgentMailMessages();

    expect(result[0].from).toBe('isla');
    expect(result[1].from).toBe('harper');
  });
});
