// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ChatPanel } from './ChatPanel';

const mockUseChat = vi.fn();
const mockUseVoice = vi.fn();
const mockUseSSE = vi.fn();
const mockChatStore = vi.fn();
const mockVoiceStore = vi.fn();
const mockAgentStore = vi.fn();

vi.mock('../hooks/useChat', () => ({
  useChat: (agentKey: string) => mockUseChat(agentKey),
}));

vi.mock('../hooks/useVoice', () => ({
  useVoice: () => mockUseVoice(),
}));

vi.mock('../hooks/useSSE', () => ({
  useSSE: (agentKey: string) => mockUseSSE(agentKey),
}));

vi.mock('../stores/chatStore', () => ({
  useChatStore: (selector: (state: any) => any) => mockChatStore(selector),
}));

vi.mock('../stores/voiceStore', () => ({
  useVoiceStore: (selector: (state: any) => any) => mockVoiceStore(selector),
}));

vi.mock('../stores/agentStore', () => ({
  useAgentStore: (selector: (state: any) => any) => mockAgentStore(selector),
}));

vi.mock('./ChatMessage', () => ({
  ChatMessage: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('./ChatInput', () => ({
  ChatInput: () => <div>chat-input</div>,
}));

vi.mock('./BtwOverlay', () => ({
  BtwOverlay: () => <div>btw-overlay</div>,
}));

vi.mock('./VoiceMode', () => ({
  VoiceMode: () => <div>voice-mode</div>,
}));

vi.mock('./SearchPanel', () => ({
  SearchPanel: ({ onClose, onJumpToMessage }: { onClose: () => void; onJumpToMessage: (seq: number) => void }) => (
    <div>
      <div>search-panel</div>
      <button onClick={() => onJumpToMessage(1)}>Jump to result</button>
      <button onClick={onClose}>Close search</button>
    </div>
  ),
}));

describe('ChatPanel search', () => {
  let chatState: any;
  let loadOlderMessages: ReturnType<typeof vi.fn>;

  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.useFakeTimers();

    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });

    loadOlderMessages = vi.fn();
    mockUseChat.mockReturnValue({
      draft: '',
      setDraft: vi.fn(),
      sendMessage: vi.fn(),
      sendBtw: vi.fn(),
      retryMessage: vi.fn(),
      loadHistory: vi.fn(),
      loadOlderMessages,
      interrupt: vi.fn(),
      updateProvider: vi.fn(),
    });

    mockUseVoice.mockReturnValue({ speak: vi.fn() });
    mockUseSSE.mockReturnValue(undefined);

    chatState = {
      messages: {
        marcus: [{ seq: 1, role: 'assistant', content: 'hello world', timestamp: Date.now() }],
      },
      streaming: {},
      streamBuffer: {},
      hasOlderMessages: {},
      loadingOlder: {},
      sideResults: {},
      setSideResult: vi.fn(),
    };
    mockChatStore.mockImplementation((selector: (state: any) => any) => selector(chatState));
    mockVoiceStore.mockImplementation((selector: (state: any) => any) => selector({ activeAgent: null }));
    mockAgentStore.mockImplementation((selector: (state: any) => any) =>
      selector({
        agents: {
          marcus: {
            name: 'Marcus',
            role: 'Architect',
            emoji: '🔧',
            model: 'gpt-5.4',
            color: { from: '#111111', to: '#222222' },
          },
        },
      })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the search panel from the header and closes back to chat', () => {
    render(<ChatPanel agentKey="marcus" />);

    expect(screen.getByText('hello world')).toBeTruthy();
    expect(screen.queryByText('search-panel')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /search messages/i }));

    expect(screen.getByText('search-panel')).toBeTruthy();
    expect(screen.queryByText('hello world')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /close search/i }));

    expect(screen.getByText('hello world')).toBeTruthy();
    expect(screen.queryByText('search-panel')).toBeNull();
  });

  it('returns to the chat when jumping to a search result', () => {
    render(<ChatPanel agentKey="marcus" />);

    fireEvent.click(screen.getByRole('button', { name: /search messages/i }));
    fireEvent.click(screen.getByRole('button', { name: /jump to result/i }));

    expect(screen.getByText('hello world')).toBeTruthy();
    expect(screen.queryByText('search-panel')).toBeNull();
  });

  it('loads older messages when a jumped search result is not in the loaded page yet', () => {
    chatState.messages.marcus = [{ seq: 400, role: 'assistant', content: 'newest message', timestamp: Date.now() }];
    chatState.hasOlderMessages.marcus = true;

    render(<ChatPanel agentKey="marcus" />);

    fireEvent.click(screen.getByRole('button', { name: /search messages/i }));
    fireEvent.click(screen.getByRole('button', { name: /jump to result/i }));

    expect(loadOlderMessages).toHaveBeenCalledTimes(1);
  });

  it('shows provider switch and saves provider changes for the current agent', () => {
    const updateProvider = vi.fn().mockResolvedValue(undefined);
    mockUseChat.mockReturnValue({
      draft: '',
      setDraft: vi.fn(),
      sendMessage: vi.fn(),
      sendBtw: vi.fn(),
      retryMessage: vi.fn(),
      loadHistory: vi.fn(),
      loadOlderMessages: vi.fn(),
      interrupt: vi.fn(),
      updateProvider,
    });

    render(<ChatPanel agentKey="marcus" />);

    fireEvent.change(screen.getByLabelText(/provider/i), {
      target: { value: 'claude-code' },
    });

    expect(updateProvider).toHaveBeenCalledWith('persistent-harness', {
      adapter: 'claude-code',
      cwd: '/Volumes/Repo-Drive/src/openclaw-mcc',
      modelConfig: undefined,
    });
  });
});
