// web/src/__tests__/ChatStoreV2.test.tsx
//
// Copilot-3 — verifies the chat store's v2 opt-in code path.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http } from '@/lib/http';
import { useChat } from '@/store/chat';

vi.mock('@/lib/http');

describe('Copilot-3 — chat store v2 opt-in', () => {
  beforeEach(() => {
    // Reset zustand store between tests.
    useChat.setState({
      open: false,
      sending: false,
      messages: [],
      context: { page: 'unknown' },
      error: null,
      conversationId: null,
      quota: null,
    });
  });
  afterEach(() => vi.clearAllMocks());

  it('legacy v1 path: posts to /v1/copilot/chat (default)', async () => {
    vi.stubEnv('VITE_COPILOT_API_VERSION', 'v1');
    (http.post as unknown as ReturnType<typeof vi.fn>) = vi
      .fn()
      .mockResolvedValue({ data: { reply: 'pong', suggestions: ['ok'] } });
    await useChat.getState().send('hello');
    const calls = (http.post as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toBe('/v1/copilot/chat');
    const messages = useChat.getState().messages;
    expect(messages).toHaveLength(2);
    expect(messages[1]!.text).toBe('pong');
    expect(useChat.getState().conversationId).toBeNull();
    vi.unstubAllEnvs();
  });

  it('v2 path: posts to /v1/copilot/v2/chat + extracts conversation_id + quota', async () => {
    vi.stubEnv('VITE_COPILOT_API_VERSION', 'v2');
    (http.post as unknown as ReturnType<typeof vi.fn>) = vi.fn().mockResolvedValue({
      data: {
        body: {
          conversation_id: 'conv-1',
          reply: 'why_flagged reply',
          suggestions: ['Show drivers'],
          used_intent: 'why_flagged',
          masked_pii_kinds: [],
          used_llm: false,
          quota: { remaining: 29, reset_at: '2026-05-06T13:00:00.000Z' },
        },
      },
    });
    await useChat.getState().send('why is X high risk');
    const calls = (http.post as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toBe('/v1/copilot/v2/chat');
    const messages = useChat.getState().messages;
    expect(messages[1]!.text).toBe('why_flagged reply');
    expect(useChat.getState().conversationId).toBe('conv-1');
    expect(useChat.getState().quota).toEqual({
      remaining: 29,
      reset_at: '2026-05-06T13:00:00.000Z',
    });
    vi.unstubAllEnvs();
  });

  it('v2 path: 2nd turn reuses conversation_id from store', async () => {
    vi.stubEnv('VITE_COPILOT_API_VERSION', 'v2');
    let callCount = 0;
    (http.post as unknown as ReturnType<typeof vi.fn>) = vi.fn().mockImplementation(
      () => {
        callCount += 1;
        return Promise.resolve({
          data: {
            body: {
              conversation_id: 'conv-1',
              reply: `turn-${callCount}`,
              suggestions: [],
              used_intent: 'fallback',
              masked_pii_kinds: [],
              used_llm: false,
              quota: { remaining: 30 - callCount, reset_at: '...' },
            },
          },
        });
      },
    );
    await useChat.getState().send('first');
    await useChat.getState().send('second');
    const calls = (http.post as unknown as ReturnType<typeof vi.fn>).mock.calls;
    // Second call body must include conversation_id from the first response
    const secondBody = calls[1]![1] as { conversation_id?: string | null };
    expect(secondBody.conversation_id).toBe('conv-1');
    vi.unstubAllEnvs();
  });

  it('clear() resets conversationId + quota', () => {
    useChat.setState({
      conversationId: 'conv-x',
      quota: { remaining: 5, reset_at: 'x' },
      messages: [{ id: 'a', who: 'user', text: 'hi', createdAt: 0 }],
    });
    useChat.getState().clear();
    expect(useChat.getState().conversationId).toBeNull();
    expect(useChat.getState().quota).toBeNull();
    expect(useChat.getState().messages).toEqual([]);
  });

  it('error handling: sending false-flag and error string set', async () => {
    vi.stubEnv('VITE_COPILOT_API_VERSION', 'v2');
    (http.post as unknown as ReturnType<typeof vi.fn>) = vi.fn().mockRejectedValue(
      new Error('429 rate limited'),
    );
    await useChat.getState().send('hi');
    expect(useChat.getState().sending).toBe(false);
    expect(useChat.getState().error).toContain('rate limited');
    vi.unstubAllEnvs();
  });
});
