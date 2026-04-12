import { useEffect, useRef, useCallback, useState } from 'react';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { BtwOverlay } from './BtwOverlay';
import { VoiceMode } from './VoiceMode';
import { SearchPanel } from './SearchPanel';
import { ProviderSwitch } from './ProviderSwitch';
import { useChat } from '../hooks/useChat';
import { useVoice } from '../hooks/useVoice';
import { useSSE } from '../hooks/useSSE';
import { useChatStore } from '../stores/chatStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useAgentStore } from '../stores/agentStore';
import { ChevronUp, Loader2, Search } from 'lucide-react';

const SEARCH_HIGHLIGHT_DURATION_MS = 2200;
const EMPTY_MESSAGES: { seq: number; role: 'user' | 'assistant'; content: string; timestamp: number }[] = [];

interface Props {
  agentKey: string;
}

export function ChatPanel({ agentKey }: Props) {
  const { draft, setDraft, sendMessage, sendBtw, retryMessage, loadHistory, loadOlderMessages, interrupt, updateProvider } = useChat(agentKey);
  const { speak } = useVoice();
  const messages = useChatStore((s) => s.messages[agentKey] ?? EMPTY_MESSAGES);
  const isStreaming = useChatStore((s) => !!s.streaming[agentKey]);
  const streamBuffer = useChatStore((s) => s.streamBuffer[agentKey] ?? '');
  const hasOlderMessages = useChatStore((s) => !!s.hasOlderMessages[agentKey]);
  const loadingOlder = useChatStore((s) => !!s.loadingOlder[agentKey]);
  const sideResult = useChatStore((s) => s.sideResults[agentKey] ?? null);
  const setSideResult = useChatStore((s) => s.setSideResult);
  const activeVoiceAgent = useVoiceStore((s) => s.activeAgent);
  const agent = useAgentStore((s) => s.agents[agentKey]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevMsgCountRef = useRef(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [focusedMessageSeq, setFocusedMessageSeq] = useState<number | null>(null);
  // Track scroll position before prepending older messages so we can restore it
  const scrollAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  // Keep speak ref stable to avoid re-render loops
  const speakRef = useRef(speak);
  speakRef.current = speak;

  // When voice mode is active and a new assistant message arrives, speak it
  useEffect(() => {
    if (activeVoiceAgent !== agentKey) {
      prevMsgCountRef.current = messages.length;
      return;
    }
    if (messages.length > prevMsgCountRef.current) {
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant' && last.content) {
        const text = last.content.length > 500 ? last.content.slice(0, 500) : last.content;
        speakRef.current(text, agentKey);
      }
    }
    prevMsgCountRef.current = messages.length;
  }, [messages, activeVoiceAgent, agentKey]);

  const handleVoiceTranscript = useCallback(
    (text: string) => {
      sendMessage(text);
    },
    [sendMessage]
  );

  useSSE(agentKey);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Auto-scroll to bottom when new messages arrive (but not when loading older ones)
  useEffect(() => {
    if (scrollAnchorRef.current) {
      // We just prepended older messages — restore scroll position
      const el = scrollRef.current;
      if (el) {
        const { scrollHeight, scrollTop } = scrollAnchorRef.current;
        el.scrollTop = el.scrollHeight - scrollHeight + scrollTop;
      }
      scrollAnchorRef.current = null;
    } else {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, streamBuffer]);

  const handleLoadOlder = useCallback(() => {
    // Snapshot scroll position before the prepend
    if (scrollRef.current) {
      scrollAnchorRef.current = {
        scrollHeight: scrollRef.current.scrollHeight,
        scrollTop: scrollRef.current.scrollTop,
      };
    }
    loadOlderMessages();
  }, [loadOlderMessages]);

  const handleJumpToMessage = useCallback((seq: number) => {
    setSearchOpen(false);
    setFocusedMessageSeq(seq);
  }, []);

  useEffect(() => {
    if (!focusedMessageSeq || searchOpen) return;

    const hasTargetMessage = messages.some((msg) => msg.seq === focusedMessageSeq);
    if (!hasTargetMessage) {
      if (hasOlderMessages && !loadingOlder) {
        handleLoadOlder();
        return;
      }

      setFocusedMessageSeq(null);
      return;
    }

    const timer = window.setTimeout(() => {
      const target = scrollRef.current?.querySelector(`[data-message-seq="${focusedMessageSeq}"]`) as HTMLElement | null;
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 0);

    const clearTimer = window.setTimeout(() => {
      setFocusedMessageSeq(null);
    }, SEARCH_HIGHLIGHT_DURATION_MS);

    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(clearTimer);
    };
  }, [focusedMessageSeq, searchOpen, messages, hasOlderMessages, loadingOlder, handleLoadOlder]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="p-3 border-b border-white/10 shrink-0"
        style={{
          background: agent ? `linear-gradient(135deg, ${agent.color.from}20, ${agent.color.to}20)` : undefined,
        }}
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">{agent?.emoji}</span>
          <div>
            <div className="text-sm font-semibold">{agent?.name}</div>
            <div className="text-xs text-text-secondary">{agent?.role}</div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {agent && (
              <ProviderSwitch
                agentKey={agentKey}
                providerType={agent.providerType}
                harnessConfig={agent.harnessConfig}
                defaultCwd="/Volumes/Repo-Drive/src/openclaw-mcc"
                onChange={(providerType, harnessConfig) => {
                  void updateProvider(providerType, harnessConfig);
                }}
              />
            )}
            <button
              onClick={() => setSearchOpen((open) => !open)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-surface-overlay px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:text-text-primary hover:bg-surface-raised"
              aria-label="Search messages"
              title="Search messages"
            >
              <Search className="w-3.5 h-3.5" />
              <span>Search</span>
            </button>
            {agent?.model && (agent.providerType ?? 'llm') === 'llm' && (
              <span className="text-xs text-text-secondary">{agent.model}</span>
            )}
          </div>
        </div>
      </div>

      {/* Messages / Search */}
      {searchOpen ? (
        <div className="flex-1 min-h-0">
          <SearchPanel agentKey={agentKey} onClose={() => setSearchOpen(false)} onJumpToMessage={handleJumpToMessage} />
        </div>
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
          {/* Load older messages button */}
          {hasOlderMessages && (
            <div className="flex justify-center mb-3">
              <button
                onClick={handleLoadOlder}
                disabled={loadingOlder}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary bg-surface-overlay hover:bg-surface-raised rounded-full border border-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loadingOlder ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <ChevronUp className="w-3 h-3" />
                )}
                {loadingOlder ? 'Loading…' : 'Load older messages'}
              </button>
            </div>
          )}
          {messages.map((msg, i) => {
            // For error messages, find the preceding user message to get the original content for retry
            const prevUserMsg = msg.error
              ? messages.slice(0, i).reverse().find((m) => m.role === 'user')
              : null;

            return (
              <ChatMessage
                key={msg.seq || i}
                seq={msg.seq}
                role={msg.role}
                content={msg.content}
                agentName={msg.role === 'assistant' ? agent?.name : undefined}
                timestamp={msg.timestamp}
                error={msg.error}
                emphasis={focusedMessageSeq === msg.seq}
                onRetry={
                  msg.error && prevUserMsg
                    ? () => retryMessage(prevUserMsg.content, msg.seq)
                    : undefined
                }
              />
            );
          })}
          {isStreaming && streamBuffer && (
            <ChatMessage role="assistant" content={streamBuffer} agentName={agent?.name} streaming />
          )}
        </div>
      )}

      {/* BTW side result overlay */}
      {sideResult && (
        <BtwOverlay
          content={sideResult}
          onDismiss={() => setSideResult(agentKey, null)}
        />
      )}

      {/* Input */}
      <ChatInput
        value={draft}
        onChange={setDraft}
        onSend={sendMessage}
        onBtw={sendBtw}
        onInterrupt={interrupt}
        isStreaming={isStreaming}
        placeholder={`Message ${agent?.name || 'agent'}...`}
      />

      {/* Voice */}
      <div className="border-t border-white/5 bg-surface-raised pb-14 md:pb-0">
        <VoiceMode agentKey={agentKey} onTranscript={handleVoiceTranscript} />
      </div>
    </div>
  );
}
