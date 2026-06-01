import { describe, expect, it, vi } from 'vitest';

const enqueueDiscord = vi.fn();
const enqueueAgentMail = vi.fn();
const enqueueBlueBubbles = vi.fn();
const enqueueEventInbox = vi.fn();

vi.mock('./runtime-discord-inbox.js', () => ({
  enqueuePendingRuntimeDiscordInbox: (input: unknown) => enqueueDiscord(input),
}));
vi.mock('./runtime-agent-mail.js', () => ({
  enqueuePendingRuntimeAgentMail: (input: unknown) => enqueueAgentMail(input),
}));
vi.mock('./runtime-bluebubbles-inbox.js', () => ({
  enqueuePendingRuntimeBlueBubblesInbox: (input: unknown) => enqueueBlueBubbles(input),
}));
vi.mock('./runtime-event-inbox.js', () => ({
  enqueuePendingRuntimeEventInbox: (input: unknown) => enqueueEventInbox(input),
}));

import { startRuntimeInboxPollers } from './runtime-inbox-pollers.js';

function baseInput(overrides: Partial<Parameters<typeof startRuntimeInboxPollers>[0]> = {}) {
  return {
    agentKey: 'enzo',
    contentRoot: '/tmp/content-root',
    events: {} as never,
    openBrainConfig: null,
    runtimeLogPath: '/tmp/runtime.log',
    enqueue: vi.fn(),
    discord: { submitPrompt: vi.fn(async () => {}) },
    agentMail: {
      mailStore: { ackMessage: vi.fn(), listInbox: vi.fn() } as never,
      submitPrompt: vi.fn(async () => {}),
    },
    blueBubbles: { submitPrompt: vi.fn(async () => {}) },
    eventInbox: {
      eventInbox: { ackEvent: vi.fn(), listInbox: vi.fn() } as never,
      submitPrompt: vi.fn(async () => {}),
    },
    ...overrides,
  };
}

describe('startRuntimeInboxPollers', () => {
  it('schedules a periodic tick that invokes all pollers', () => {
    enqueueDiscord.mockClear();
    enqueueAgentMail.mockClear();
    enqueueBlueBubbles.mockClear();
    enqueueEventInbox.mockClear();

    let registered: (() => void) | null = null;
    const fakeHandle = {} as NodeJS.Timeout;
    const setIntervalImpl = vi.fn((handler: () => void) => {
      registered = handler;
      return fakeHandle;
    });
    const clearIntervalImpl = vi.fn();

    const handle = startRuntimeInboxPollers(
      baseInput({ setIntervalImpl, clearIntervalImpl, intervalMs: 1234 }),
    );

    expect(setIntervalImpl).toHaveBeenCalledTimes(1);
    expect(setIntervalImpl.mock.calls[0][1]).toBe(1234);
    expect(registered).toBeTypeOf('function');

    registered!();
    expect(enqueueBlueBubbles).toHaveBeenCalledTimes(1);
    expect(enqueueDiscord).toHaveBeenCalledTimes(1);
    expect(enqueueAgentMail).toHaveBeenCalledTimes(1);
    expect(enqueueEventInbox).toHaveBeenCalledTimes(1);

    handle.tick();
    expect(enqueueBlueBubbles).toHaveBeenCalledTimes(2);
    expect(enqueueDiscord).toHaveBeenCalledTimes(2);
    expect(enqueueAgentMail).toHaveBeenCalledTimes(2);
    expect(enqueueEventInbox).toHaveBeenCalledTimes(2);

    handle.stop();
    expect(clearIntervalImpl).toHaveBeenCalledWith(fakeHandle);
  });

  it('threads agentKey + contentRoot + runtimeLogPath + openBrainConfig into each poller', () => {
    enqueueDiscord.mockClear();
    enqueueAgentMail.mockClear();
    enqueueBlueBubbles.mockClear();
    enqueueEventInbox.mockClear();

    const openBrainConfig = { agent: 'enzo' } as never;
    const setIntervalImpl = vi.fn((handler: () => void) => {
      handler();
      return {} as NodeJS.Timeout;
    });

    startRuntimeInboxPollers(
      baseInput({
        agentKey: 'enzo',
        contentRoot: '/tmp/cr',
        runtimeLogPath: '/tmp/log',
        openBrainConfig,
        setIntervalImpl,
        clearIntervalImpl: vi.fn(),
      }),
    );

    for (const fn of [enqueueDiscord, enqueueBlueBubbles, enqueueAgentMail]) {
      expect(fn).toHaveBeenCalledTimes(1);
      const call = fn.mock.calls[0][0];
      expect(call.agentKey).toBe('enzo');
      expect(call.runtimeLogPath).toBe('/tmp/log');
      expect(call.openBrainConfig).toBe(openBrainConfig);
    }
    expect(enqueueEventInbox).toHaveBeenCalledTimes(1);
    expect(enqueueEventInbox.mock.calls[0][0].agentKey).toBe('enzo');
    expect(enqueueEventInbox.mock.calls[0][0].runtimeLogPath).toBe('/tmp/log');

    expect(enqueueDiscord.mock.calls[0][0].contentRoot).toBe('/tmp/cr');
    expect(enqueueBlueBubbles.mock.calls[0][0].contentRoot).toBe('/tmp/cr');
  });

  it('gives each channel its own deliveredIds set', () => {
    enqueueDiscord.mockClear();
    enqueueAgentMail.mockClear();
    enqueueBlueBubbles.mockClear();
    enqueueEventInbox.mockClear();

    const setIntervalImpl = vi.fn((handler: () => void) => {
      handler();
      return {} as NodeJS.Timeout;
    });

    startRuntimeInboxPollers(
      baseInput({ setIntervalImpl, clearIntervalImpl: vi.fn() }),
    );

    const discordSet = enqueueDiscord.mock.calls[0][0].deliveredIds;
    const mailSet = enqueueAgentMail.mock.calls[0][0].deliveredIds;
    const bbSet = enqueueBlueBubbles.mock.calls[0][0].deliveredIds;
    const eventSet = enqueueEventInbox.mock.calls[0][0].deliveredIds;

    expect(discordSet).toBeInstanceOf(Set);
    expect(mailSet).toBeInstanceOf(Set);
    expect(bbSet).toBeInstanceOf(Set);
    expect(eventSet).toBeInstanceOf(Set);
    expect(discordSet).not.toBe(mailSet);
    expect(discordSet).not.toBe(bbSet);
    expect(discordSet).not.toBe(eventSet);
    expect(mailSet).not.toBe(bbSet);
    expect(mailSet).not.toBe(eventSet);
    expect(bbSet).not.toBe(eventSet);
  });
});
