import { create } from 'zustand';
import { http } from '@/lib/http';

export type ChatPage =
  | 'dashboard'
  | 'alerts'
  | 'customer'
  | 'customers'
  | 'case'
  | 'cases'
  | 'rules'
  | 'scenario'
  | 'reports'
  | 'unknown';

export interface ChatEntitySummary {
  type: 'customer' | 'case' | 'alert' | 'rule';
  id: string;
  label?: string;
  /** Page-derived snapshot the brain may quote. Values are scalars or
   *  small arrays of plain objects (e.g. SHAP `top_reasons`). */
  facts?: Record<string, string | number | boolean | null | unknown[]>;
}

export interface ChatContext {
  page?: ChatPage;
  entity?: ChatEntitySummary;
}

export interface ChatMessage {
  id: string;
  who: 'user' | 'bot';
  text: string;
  /** Suggestion chips returned alongside a bot reply. */
  suggestions?: string[];
  createdAt: number;
}

interface ChatState {
  open: boolean;
  sending: boolean;
  messages: ChatMessage[];
  /** Live page context — pages publish via setContext; brain receives on send. */
  context: ChatContext;
  /** Most recent error from the chat endpoint, if any. */
  error: string | null;
  /** Conversation_id returned by the v2 endpoint on first turn — reused
   *  for continuity in subsequent calls. null when using the legacy v1
   *  path or before the first turn has come back. */
  conversationId: string | null;
  /** Quota state from the most recent v2 reply. null when on legacy. */
  quota: { remaining: number; reset_at: string } | null;

  toggleOpen: () => void;
  setOpen: (open: boolean) => void;
  setContext: (ctx: ChatContext) => void;
  send: (text: string) => Promise<void>;
  clear: () => void;
}

/** Read VITE_COPILOT_API_VERSION; default 'v1'. Set 'v2' in `web/.env`
 *  to opt the floating ChatWidget into the hardened endpoint
 *  (Copilot-2 — role gate + rate limit + PII mask + audit + persistence). */
function copilotApiVersion(): 'v1' | 'v2' {
  const v = (import.meta.env?.VITE_COPILOT_API_VERSION ?? 'v1') as string;
  return v === 'v2' ? 'v2' : 'v1';
}

let _id = 0;
function nextId(): string {
  _id += 1;
  return `m-${Date.now().toString(36)}-${_id}`;
}

export const useChat = create<ChatState>((set, get) => ({
  open: false,
  sending: false,
  messages: [],
  context: { page: 'unknown' },
  error: null,
  conversationId: null,
  quota: null,

  toggleOpen: () => set((s) => ({ open: !s.open })),
  setOpen: (open) => set({ open }),
  setContext: (context) => set({ context }),

  send: async (text) => {
    const trimmed = text.trim();
    if (!trimmed || get().sending) return;
    const userMsg: ChatMessage = {
      id: nextId(),
      who: 'user',
      text: trimmed,
      createdAt: Date.now(),
    };
    set((s) => ({ messages: [...s.messages, userMsg], sending: true, error: null }));
    try {
      const v = copilotApiVersion();
      if (v === 'v2') {
        // Hardened path: response is wrapped in T4.24 envelope.
        const body = { message: trimmed, context: get().context, conversation_id: get().conversationId };
        const { data } = await http.post<{
          body: {
            conversation_id: string;
            reply: string;
            suggestions: string[];
            used_intent: string;
            masked_pii_kinds: string[];
            used_llm: boolean;
            quota: { remaining: number; reset_at: string };
          };
        }>('/v1/copilot/v2/chat', body);
        const inner = data.body;
        const botMsg: ChatMessage = {
          id: nextId(),
          who: 'bot',
          text: inner.reply,
          suggestions: inner.suggestions,
          createdAt: Date.now(),
        };
        set((s) => ({
          messages: [...s.messages, botMsg],
          sending: false,
          conversationId: inner.conversation_id,
          quota: inner.quota,
        }));
      } else {
        // Legacy path — stateless, MSW-mock-friendly.
        const { data } = await http.post<{ reply: string; suggestions: string[] }>(
          '/v1/copilot/chat',
          { message: trimmed, context: get().context },
        );
        const botMsg: ChatMessage = {
          id: nextId(),
          who: 'bot',
          text: data.reply,
          suggestions: data.suggestions,
          createdAt: Date.now(),
        };
        set((s) => ({ messages: [...s.messages, botMsg], sending: false }));
      }
    } catch (err) {
      set({
        sending: false,
        error: err instanceof Error ? err.message : 'Chat failed. Please try again.',
      });
    }
  },

  clear: () =>
    set({ messages: [], error: null, conversationId: null, quota: null }),
}));
