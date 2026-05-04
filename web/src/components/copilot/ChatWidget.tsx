import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { MessageCircle, Send, Sparkles, X, Trash2 } from 'lucide-react';
import { useChat } from '@/store/chat';
import { cn } from '@/lib/cn';

const DEFAULT_SUGGESTIONS = [
  'What can you do?',
  'Summarise this page',
  'Walk me through an alert',
];

export function ChatWidget() {
  const open = useChat((s) => s.open);
  const setOpen = useChat((s) => s.setOpen);
  const toggleOpen = useChat((s) => s.toggleOpen);
  const messages = useChat((s) => s.messages);
  const sending = useChat((s) => s.sending);
  const error = useChat((s) => s.error);
  const send = useChat((s) => s.send);
  const clear = useChat((s) => s.clear);
  const context = useChat((s) => s.context);

  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Autoscroll to newest message + focus input on open.
  useEffect(() => {
    if (!open) return;
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
    inputRef.current?.focus();
  }, [open, messages.length, sending]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  const lastBot = [...messages].reverse().find((m) => m.who === 'bot');
  const suggestions =
    (lastBot?.suggestions && lastBot.suggestions.length > 0
      ? lastBot.suggestions
      : DEFAULT_SUGGESTIONS).slice(0, 4);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || sending) return;
    const text = draft;
    setDraft('');
    await send(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void onSubmit(e as unknown as FormEvent);
    }
  };

  const onChip = async (text: string) => {
    if (sending) return;
    await send(text);
  };

  const contextLabel = (() => {
    const e = context.entity;
    if (e) return `${e.label ?? e.id}`;
    if (context.page && context.page !== 'unknown') {
      return context.page.charAt(0).toUpperCase() + context.page.slice(1);
    }
    return 'No context';
  })();

  return (
    <>
      {/* Floating launcher */}
      <button
        type="button"
        onClick={toggleOpen}
        aria-label={open ? 'Close copilot chat' : 'Open copilot chat'}
        aria-expanded={open}
        data-testid="chat-launcher"
        className={cn(
          'fixed bottom-5 right-5 z-40 w-12 h-12 rounded-full shadow-lg shadow-action/30',
          'bg-action hover:bg-action-hover text-white flex items-center justify-center transition-all',
          'focus:outline-none focus:ring-4 focus:ring-action/30',
          open && 'scale-90 opacity-90',
        )}
      >
        {open ? <X size={20} strokeWidth={2.25} /> : <MessageCircle size={20} strokeWidth={2.25} />}
      </button>

      {/* Slide-out panel */}
      <aside
        role="dialog"
        aria-label="APEX Copilot"
        aria-hidden={!open}
        data-testid="chat-panel"
        className={cn(
          'fixed top-0 right-0 z-30 h-screen w-full sm:w-[420px] bg-white border-l border-divider',
          'flex flex-col transition-transform duration-200 ease-out shadow-2xl',
          open ? 'translate-x-0' : 'translate-x-full pointer-events-none',
        )}
      >
        {/* Header */}
        <header className="shrink-0 px-4 h-14 flex items-center justify-between border-b border-divider bg-surface-alt">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-brand-blue flex items-center justify-center">
              <Sparkles size={14} className="text-white" strokeWidth={2.25} />
            </div>
            <div>
              <p className="text-[13px] font-semibold text-ink leading-tight">APEX Copilot</p>
              <p className="text-[10px] text-muted leading-tight">
                Context: <span className="font-mono">{contextLabel}</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {messages.length > 0 && (
              <button
                type="button"
                onClick={clear}
                aria-label="Clear conversation"
                className="w-8 h-8 rounded hover:bg-divider/60 inline-flex items-center justify-center text-muted hover:text-ink transition-colors"
              >
                <Trash2 size={14} strokeWidth={1.75} />
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close copilot chat"
              className="w-8 h-8 rounded hover:bg-divider/60 inline-flex items-center justify-center text-muted hover:text-ink transition-colors"
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>
        </header>

        {/* Messages */}
        <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-page">
          {messages.length === 0 && (
            <div className="text-center py-8">
              <div className="inline-flex w-12 h-12 rounded-full bg-action-subtle items-center justify-center mb-3">
                <Sparkles size={20} className="text-action" strokeWidth={1.75} />
              </div>
              <p className="text-[13px] text-ink font-medium">Ask me about this page.</p>
              <p className="text-[11px] text-muted mt-1 max-w-[280px] mx-auto leading-relaxed">
                I can summarise, explain a PD, walk through SHAP drivers, or recommend a next
                action.
              </p>
            </div>
          )}

          {messages.map((m) => (
            <div
              key={m.id}
              className={cn(
                'flex',
                m.who === 'user' ? 'justify-end' : 'justify-start',
              )}
            >
              <div
                className={cn(
                  'max-w-[85%] rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap',
                  m.who === 'user'
                    ? 'bg-action text-white rounded-br-md'
                    : 'bg-white border border-divider text-ink rounded-bl-md shadow-sm',
                )}
              >
                {m.text}
              </div>
            </div>
          ))}

          {sending && (
            <div className="flex justify-start">
              <div className="bg-white border border-divider rounded-2xl rounded-bl-md px-3.5 py-2 text-muted text-[13px] inline-flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" />
                <span
                  className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce"
                  style={{ animationDelay: '120ms' }}
                />
                <span
                  className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce"
                  style={{ animationDelay: '240ms' }}
                />
              </div>
            </div>
          )}

          {error && (
            <p
              role="alert"
              className="text-[11px] text-danger bg-danger-bg border border-danger/20 rounded px-3 py-1.5"
            >
              {error}
            </p>
          )}
        </div>

        {/* Suggestion chips */}
        {!sending && suggestions.length > 0 && (
          <div className="shrink-0 px-4 pt-2 pb-1 border-t border-divider bg-white">
            <div className="flex flex-wrap gap-1.5" aria-label="Suggested prompts">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onChip(s)}
                  className="text-[11px] px-2.5 py-1 rounded-full bg-action-subtle text-action hover:bg-action/10 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Composer */}
        <form
          onSubmit={onSubmit}
          className="shrink-0 px-3 py-3 border-t border-divider bg-white flex items-end gap-2"
        >
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Ask anything…"
            aria-label="Message"
            disabled={sending}
            className="flex-1 resize-none max-h-32 input py-2 text-[13px]"
          />
          <button
            type="submit"
            disabled={sending || !draft.trim()}
            aria-label="Send"
            className={cn(
              'shrink-0 w-9 h-9 rounded-input bg-action text-white inline-flex items-center justify-center',
              'hover:bg-action-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            <Send size={15} strokeWidth={2} />
          </button>
        </form>
      </aside>
    </>
  );
}
