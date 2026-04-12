import { useCallback, useRef } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useAgentStore } from '../stores/agentStore';
import type { ChatAttachment } from '../types/attachments';
import type { HarnessConfig } from '../types/agent';

const HISTORY_PAGE_SIZE = 100;

/** Generate a UUID, falling back to a manual implementation in insecure contexts (plain HTTP). */
function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      // Falls through to fallback — crypto.randomUUID() requires a secure context
    }
  }
  // Fallback using crypto.getRandomValues (available in all modern browsers regardless of context)
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function useChat(agentKey: string) {
  const addMessage = useChatStore((s) => s.addMessage);
  const setDraftAction = useChatStore((s) => s.setDraft);
  const draft = useChatStore((s) => s.drafts[agentKey] ?? '');
  const updateAgentProvider = useAgentStore((s) => s.updateAgentProvider);

  // Track the highest seq we've seen for this agent — used by the safety-net poll
  const latestSeqRef = useRef<Record<string, number>>({});

  const sendMessage = useCallback(async (content: string, attachments?: ChatAttachment[]) => {
    const idempotencyKey = generateUUID();
    const seq = Date.now();

    // Build display content: if there are attachments, note them
    const hasAttachments = attachments && attachments.length > 0;
    const displayContent = content || (hasAttachments
      ? `📎 ${attachments!.length} file${attachments!.length > 1 ? 's' : ''} attached`
      : '');

    addMessage(agentKey, {
      seq,
      role: 'user',
      content: displayContent,
      timestamp: Date.now(),
    });
    setDraftAction(agentKey, '');

    // Strip previewUrl (client-only) before sending
    const wireAttachments = attachments?.map(({ previewUrl: _p, sizeBytes: _s, ...a }) => a);

    try {
      const res = await fetch(`/api/chat/${agentKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          idempotencyKey,
          ...(wireAttachments && wireAttachments.length > 0 ? { attachments: wireAttachments } : {}),
        }),
      });
      if (!res.ok) {
        throw new Error(`Server responded with ${res.status}`);
      }

      // Safety-net poll (unchanged)
      setTimeout(async () => {
        try {
          const since = latestSeqRef.current[agentKey] ?? 0;
          const histRes = await fetch(`/api/chat-history/${agentKey}?since=${since}`);
          const newMsgs = await histRes.json();
          if (newMsgs.length > 0) {
            const store = useChatStore.getState();
            newMsgs.forEach((m: { seq: number; role: 'user' | 'assistant'; content: string; timestamp: number }) => {
              store.addMessage(agentKey, m);
            });
            const maxSeq = Math.max(...newMsgs.map((m: { seq: number }) => m.seq));
            latestSeqRef.current[agentKey] = Math.max(latestSeqRef.current[agentKey] ?? 0, maxSeq);
          }
        } catch { /* ignore */ }
      }, 5000);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to send message';
      addMessage(agentKey, {
        seq: Date.now(),
        role: 'assistant',
        content: `Failed to send: ${errorMsg}`,
        timestamp: Date.now(),
        error: errorMsg,
      });
    }
  }, [agentKey, addMessage, setDraftAction]);

  const retryMessage = useCallback(async (originalContent: string, errorSeq: number) => {
    // Remove the error message from the store
    const currentMessages = useChatStore.getState().messages[agentKey] || [];
    const filtered = currentMessages.filter((m) => m.seq !== errorSeq);
    useChatStore.getState().setMessages(agentKey, filtered);

    // Resend
    const idempotencyKey = generateUUID();
    try {
      const res = await fetch(`/api/chat/${agentKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: originalContent, idempotencyKey }),
      });
      if (!res.ok) {
        throw new Error(`Server responded with ${res.status}`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to send message';
      addMessage(agentKey, {
        seq: Date.now(),
        role: 'assistant',
        content: `Failed to send: ${errorMsg}`,
        timestamp: Date.now(),
        error: errorMsg,
      });
    }
  }, [agentKey, addMessage]);

  // Initial load: fetch last HISTORY_PAGE_SIZE messages
  const loadHistory = useCallback(async () => {
    const res = await fetch(`/api/chat-history/${agentKey}?limit=${HISTORY_PAGE_SIZE}`);
    const messages = await res.json();
    useChatStore.getState().setMessages(agentKey, messages);

    // Track latest seq and whether there are more messages to load
    if (messages.length > 0) {
      const maxSeq = Math.max(...messages.map((m: { seq: number }) => m.seq));
      latestSeqRef.current[agentKey] = maxSeq;
    }
    // If we got a full page, there are likely older messages
    useChatStore.getState().setHasOlderMessages(agentKey, messages.length >= HISTORY_PAGE_SIZE);
  }, [agentKey]);

  // Load older messages (pagination — prepend before the earliest loaded seq)
  const loadOlderMessages = useCallback(async () => {
    const store = useChatStore.getState();
    if (store.loadingOlder[agentKey]) return;

    const current = store.messages[agentKey] ?? [];
    if (current.length === 0) return;

    const oldestSeq = current[0].seq;
    store.setLoadingOlder(agentKey, true);
    try {
      const res = await fetch(
        `/api/chat-history/${agentKey}?before=${oldestSeq}&limit=${HISTORY_PAGE_SIZE}`
      );
      const older = await res.json();
      store.prependMessages(agentKey, older);
      // If we got a full page, there may still be more
      store.setHasOlderMessages(agentKey, older.length >= HISTORY_PAGE_SIZE);
    } catch { /* ignore */ } finally {
      store.setLoadingOlder(agentKey, false);
    }
  }, [agentKey]);

  const interrupt = useCallback(async () => {
    await fetch(`/api/chat/${agentKey}/interrupt`, { method: 'POST' });
  }, [agentKey]);

  const sendBtw = useCallback(async (question: string) => {
    try {
      const res = await fetch(`/api/chat/${agentKey}/btw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      if (!res.ok) {
        throw new Error(`Server responded with ${res.status}`);
      }
    } catch (err) {
      console.error('BTW send failed:', err);
    }
  }, [agentKey]);

  const setDraft = useCallback((text: string) => {
    setDraftAction(agentKey, text);
  }, [agentKey, setDraftAction]);

  const updateProvider = useCallback(async (
    providerType: 'llm' | 'persistent-harness',
    harnessConfig?: HarnessConfig,
  ) => {
    const res = await fetch(`/api/agents/${agentKey}/provider`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerType, harnessConfig }),
    });

    if (!res.ok) {
      throw new Error(`Provider update failed with ${res.status}`);
    }

    const updated = await res.json();
    updateAgentProvider(agentKey, updated.providerType, updated.harnessConfig);
  }, [agentKey, updateAgentProvider]);

  return {
    draft,
    setDraft,
    sendMessage,
    sendBtw,
    retryMessage,
    loadHistory,
    loadOlderMessages,
    interrupt,
    updateProvider,
  };
}
