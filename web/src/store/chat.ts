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

  toggleOpen: () => void;
  setOpen: (open: boolean) => void;
  setContext: (ctx: ChatContext) => void;
  send: (text: string) => Promise<void>;
  clear: () => void;
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
    } catch (err) {
      set({
        sending: false,
        error: err instanceof Error ? err.message : 'Chat failed. Please try again.',
      });
    }
  },

  clear: () => set({ messages: [], error: null }),
}));
