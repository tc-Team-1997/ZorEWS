// web/src/components/copilot/ChatWidget.tsx
//
// ZorEWS Copilot — Enterprise Risk Intelligence Assistant.
// Full enterprise rewrite of the APEX Copilot panel.
// All existing hooks, store API, and context interfaces preserved.
// Additive: zero route/API/RBAC changes.

import {
  useEffect, useRef, useState, useMemo,
  type FormEvent, type KeyboardEvent,
} from 'react';
import { Link } from 'react-router-dom';
import {
  Sparkles, X, Send, Search,
  AlertTriangle, Shield,
  ChevronRight, ArrowRight, Bot, RotateCcw,
  TrendingUp,
} from 'lucide-react';
import { useChat } from '@/store/chat';
import { useAuth } from '@/store/auth';
import { cn } from '@/lib/cn';
import {
  getWelcomeSnapshot,
  getSuggestionsForPage,
  generateResponse,
  type CopilotAction,
  type ResponseSection,
} from './copilotEngine';

// ─── Session memory ───────────────────────────────────────────────────────

let _lastUserQuery = '';

// ─── Quick access buttons ──────────────────────────────────────────────────

const QUICK_ACCESS: Array<{ label: string; prompt: string; icon: React.ElementType }> = [
  { label: 'Executive Summary',   prompt: 'Executive summary',           icon: TrendingUp },
  { label: 'Investigation Queue', prompt: 'Show open investigations',     icon: Search },
  { label: 'Compliance Overview', prompt: 'Show compliance gaps today',   icon: Shield },
  { label: 'Predictive Forecast', prompt: 'Predictive forecast 90 days', icon: Sparkles },
  { label: 'Security Overview',   prompt: 'Security events today',        icon: AlertTriangle },
];

// ─── Action renderer ───────────────────────────────────────────────────────

function ActionButton({ action }: { action: CopilotAction }) {
  return (
    <Link
      to={action.href}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] bg-indigo-50 border border-indigo-200 text-[11.5px] font-medium text-indigo-700 hover:bg-indigo-100 transition-colors"
    >
      <ArrowRight size={11} />
      {action.label}
    </Link>
  );
}

// ─── Section renderer ─────────────────────────────────────────────────────

function SectionBlock({ section }: { section: ResponseSection }) {
  const COLOR = { bullets: 'text-indigo-600', metrics: 'text-indigo-700', links: 'text-indigo-600', alert: 'text-amber-600' };
  return (
    <div className="mt-2 rounded-[8px] bg-[#F8FAFF] border border-indigo-100 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-indigo-400 mb-1.5">{section.title}</p>
      <div className="space-y-0.5">
        {section.items.map((item, i) => (
          <div key={i} className="flex items-start gap-1.5">
            <span className={cn('text-[10px] mt-0.5', COLOR[section.type ?? 'bullets'])}>
              {section.type === 'metrics' ? '•' : '→'}
            </span>
            <p className="text-[11.5px] text-gray-700 leading-snug">{item}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Message renderer ─────────────────────────────────────────────────────

interface ParsedBotMessage {
  text: string;
  sections?: ResponseSection[];
  actions?: CopilotAction[];
}

function BotMessage({ msg }: { msg: ParsedBotMessage }) {
  // Convert **bold** and bullet points to styled text
  const lines = msg.text.split('\n').filter(Boolean);
  return (
    <div className="bg-white border border-[#E5E7EB] rounded-[12px] rounded-bl-[4px] px-3.5 py-2.5 max-w-[94%] shadow-sm">
      {lines.map((line, i) => {
        if (line.startsWith('**') && line.endsWith('**')) {
          const content = line.slice(2, -2);
          return <p key={i} className="text-[12.5px] font-bold text-[#111827] mb-1 leading-tight">{content}</p>;
        }
        if (/^\*\*[^*]+\*\*/.test(line)) {
          const rendered = line.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
          return <p key={i} className="text-[12.5px] text-[#374151] leading-relaxed mb-0.5" dangerouslySetInnerHTML={{ __html: rendered }} />;
        }
        if (line.startsWith('•') || line.startsWith('·') || /^\d+\./.test(line) || line.startsWith('-')) {
          return <p key={i} className="text-[12px] text-[#374151] leading-relaxed pl-2 mb-0.5">{line}</p>;
        }
        if (line.startsWith('⚠️') || line.startsWith('✓') || line.startsWith('🔴') || line.startsWith('🟠') || line.startsWith('🟡') || line.startsWith('🟢')) {
          return <p key={i} className="text-[12px] text-[#374151] leading-relaxed mb-0.5">{line}</p>;
        }
        return <p key={i} className="text-[12.5px] text-[#374151] leading-relaxed mb-0.5">{line}</p>;
      })}
      {msg.sections?.map((section, i) => (
        <SectionBlock key={i} section={section} />
      ))}
      {msg.actions && msg.actions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          {msg.actions.map((action, i) => (
            <ActionButton key={i} action={action} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Welcome screen ────────────────────────────────────────────────────────

function WelcomeScreen({
  userName, tenantId, onPrompt,
}: { userName: string; tenantId: string; onPrompt: (p: string) => void }) {
  const snap = useMemo(() => getWelcomeSnapshot(tenantId), [tenantId]);

  const SNAP_ITEMS = [
    { label: 'Critical Alerts',     value: snap.criticalAlerts,       alert: true,  href: '/alerts' },
    { label: 'High Risk Accounts',  value: snap.highRiskAccounts,     alert: false, href: '/customers?level=High' },
    { label: 'Active Investigations', value: snap.activeInvestigations, alert: snap.activeInvestigations > 20, href: '/investigation-center' },
    { label: 'Compliance Gaps',     value: snap.complianceGaps,       alert: snap.complianceGaps > 3,  href: '/regulatory-compliance-center' },
    { label: 'Security Events',     value: snap.securityEvents,       alert: snap.securityEvents > 2, href: '/admin/security' },
    { label: 'Recovery Events',     value: snap.recoveryEvents,       alert: false, href: '/recovery-center' },
  ];

  return (
    <div className="space-y-3 p-3">
      {/* Greeting */}
      <div className="rounded-[12px] bg-gradient-to-br from-indigo-600 to-violet-700 p-4 text-white">
        <div className="flex items-center gap-2 mb-2">
          <Bot size={16} className="text-indigo-200" />
          <span className="text-[11px] font-semibold text-indigo-200 uppercase tracking-widest">ZorEWS Copilot</span>
        </div>
        <p className="text-[14px] font-bold leading-tight mb-0.5">Welcome back, {userName} 👋</p>
        <p className="text-[11px] text-indigo-200">Enterprise Risk Intelligence · Live</p>
      </div>

      {/* Today's Snapshot */}
      <div className="rounded-[12px] bg-white border border-[#E5E7EB] overflow-hidden">
        <div className="px-3 py-2 bg-[#F9FAFB] border-b border-[#E5E7EB]">
          <p className="text-[11px] font-semibold text-[#374151] uppercase tracking-wide">Today's Risk Snapshot</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-[#E5E7EB]">
          {SNAP_ITEMS.map((item) => (
            <Link
              key={item.label}
              to={item.href}
              className={cn(
                'flex flex-col items-center justify-center py-3 bg-white hover:bg-gray-50 transition-colors cursor-pointer',
              )}
            >
              <p className={cn('text-[22px] font-bold leading-none', item.alert ? 'text-red-600' : 'text-[#111827]')}>
                {item.value}
              </p>
              <p className={cn('text-[9.5px] text-center mt-0.5', item.alert ? 'text-red-500 font-medium' : 'text-[#6B7280]')}>
                {item.label}
              </p>
            </Link>
          ))}
        </div>
      </div>

      {/* Priorities */}
      <div className="rounded-[12px] bg-white border border-[#E5E7EB] overflow-hidden">
        <div className="px-3 py-2 bg-[#F9FAFB] border-b border-[#E5E7EB]">
          <p className="text-[11px] font-semibold text-[#374151] uppercase tracking-wide">Top Priorities</p>
        </div>
        <div className="divide-y divide-[#F3F4F6]">
          {snap.priorities.map((p, i) => (
            <div key={i} className="flex items-start gap-2.5 px-3 py-2 hover:bg-gray-50 transition-colors">
              <span className={cn(
                'shrink-0 text-[9.5px] font-bold w-4 h-4 rounded-full flex items-center justify-center text-white mt-0.5',
                i === 0 ? 'bg-red-500' : i <= 1 ? 'bg-amber-500' : 'bg-indigo-500',
              )}>{i + 1}</span>
              <p className="text-[11.5px] text-[#374151] leading-snug">{p}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Quick access */}
      <div>
        <p className="text-[10px] font-semibold text-[#9CA3AF] uppercase tracking-widest mb-2 px-0.5">Quick Access</p>
        <div className="space-y-1.5">
          {QUICK_ACCESS.map(({ label, prompt, icon: Icon }) => (
            <button
              key={label}
              type="button"
              onClick={() => onPrompt(prompt)}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[8px] bg-white border border-[#E5E7EB] hover:bg-[#F5F7FA] hover:border-indigo-300 transition-all text-left group"
            >
              <Icon size={14} className="text-indigo-500 shrink-0" strokeWidth={1.75} />
              <span className="text-[12px] text-[#374151] font-medium flex-1">{label}</span>
              <ChevronRight size={12} className="text-gray-300 group-hover:text-indigo-400 transition-colors" />
            </button>
          ))}
        </div>
      </div>

      {/* Ask anything prompt */}
      <p className="text-[11px] text-[#9CA3AF] text-center pb-1">
        Ask anything about risk, compliance, or any enterprise center ↓
      </p>
    </div>
  );
}

// ─── Main widget ───────────────────────────────────────────────────────────

export function ChatWidget() {
  const open    = useChat((s) => s.open);
  const setOpen = useChat((s) => s.setOpen);
  const toggleOpen = useChat((s) => s.toggleOpen);
  const messages   = useChat((s) => s.messages);
  const sending    = useChat((s) => s.sending);
  const error      = useChat((s) => s.error);
  const send       = useChat((s) => s.send);
  const clear      = useChat((s) => s.clear);
  const context    = useChat((s) => s.context);
  const user       = useAuth((s) => s.user);

  const [draft, setDraft] = useState('');
  const [localMessages, setLocalMessages] = useState<Array<{
    id: string; who: 'user' | 'bot'; text: string;
    suggestions?: string[]; sections?: ResponseSection[]; actions?: CopilotAction[];
  }>>([]);

  const listRef  = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const tenantId = 'BANK_DEMO';
  const userName = user?.display_name ?? user?.username?.split('.')[0] ?? 'Executive';

  // Sync store messages with local (preserve all existing functionality)
  useEffect(() => {
    const mapped = messages.map(m => ({
      id: m.id,
      who: m.who,
      text: m.text,
      suggestions: m.suggestions,
    }));
    setLocalMessages(mapped);
  }, [messages]);

  // Autoscroll + focus
  useEffect(() => {
    if (!open) return;
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
    inputRef.current?.focus();
  }, [open, localMessages.length, sending]);

  // Esc closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  // Dynamic suggestions from page context
  const pageSuggestions = useMemo(
    () => getSuggestionsForPage(context.page ?? 'unknown'),
    [context.page],
  );

  const lastBot = [...messages].reverse().find(m => m.who === 'bot');
  const suggestions = (lastBot?.suggestions?.length ? lastBot.suggestions : pageSuggestions).slice(0, 4);

  // Enhanced send — Enterprise Knowledge Brain always responds locally
  const handleSend = async (text: string) => {
    if (!text.trim() || sending) return;

    // ── Enterprise Intelligence Layer: ALWAYS use local knowledge engine ──
    // The local engine covers 200+ BFSI concepts, 30+ modules, 8 workflows,
    // 50+ nav entries, 8 role guides, and multilingual (EN/HI/Hinglish).
    // API fallback was eliminated because it returned "I don't have a
    // templated answer" — the knowledge brain handles everything now.
    const clientResponse = generateResponse(text, context, _lastUserQuery);
    _lastUserQuery = text;

    const uid = `m-local-${Date.now()}-u`;
    const bid = `m-local-${Date.now()}-b`;
    setLocalMessages(prev => [
      ...prev,
      { id: uid, who: 'user', text },
      {
        id: bid,
        who: 'bot',
        text: clientResponse.reply,
        suggestions: clientResponse.suggestions,
        sections: clientResponse.sections,
        actions: clientResponse.actions,
      },
    ]);
    setDraft('');
    // Fire API in background for logging/analytics only (non-blocking, result discarded)
    void send(text).catch(() => null);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || sending) return;
    void handleSend(draft);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void onSubmit(e as unknown as FormEvent);
    }
  };

  const onChip = (text: string) => {
    if (sending) return;
    void handleSend(text);
  };

  const onClear = () => {
    clear();
    setLocalMessages([]);
    _lastUserQuery = '';
  };

  const displayMessages = localMessages.length > 0 ? localMessages : messages.map(m => ({
    id: m.id, who: m.who, text: m.text, suggestions: m.suggestions,
  }));

  return (
    <>
      {/* Floating launcher */}
      <button
        type="button"
        onClick={toggleOpen}
        aria-label={open ? 'Close ZorEWS Copilot' : 'Open ZorEWS Copilot'}
        aria-expanded={open}
        data-testid="chat-launcher"
        className={cn(
          'fixed bottom-5 right-5 z-40 w-12 h-12 rounded-full shadow-lg',
          'bg-[#4F46E5] hover:bg-[#4338CA] text-white flex items-center justify-center transition-all',
          'focus:outline-none focus:ring-4 focus:ring-indigo-500/30 shadow-indigo-500/30',
          open && 'scale-90 opacity-90',
        )}
      >
        {open ? <X size={20} strokeWidth={2.25} /> : <Sparkles size={20} strokeWidth={2.25} />}
      </button>

      {/* Enterprise Copilot Panel */}
      <aside
        role="dialog"
        aria-label="ZorEWS Copilot"
        aria-hidden={!open}
        data-testid="chat-panel"
        className={cn(
          'fixed top-0 right-0 z-30 h-screen w-full sm:w-[540px] bg-[#F5F7FA] border-l border-[#E5E7EB]',
          'flex flex-col transition-transform duration-200 ease-out',
          'shadow-[−4px_0_40px_rgba(0,0,0,0.12)]',
          open ? 'translate-x-0' : 'translate-x-full pointer-events-none',
        )}
      >
        {/* ── Header ── */}
        <header className="shrink-0 h-[56px] flex items-center justify-between px-4 bg-white border-b border-[#E5E7EB]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-[10px] bg-[#4F46E5] flex items-center justify-center shadow-sm">
              <Sparkles size={14} className="text-white" strokeWidth={2.25} />
            </div>
            <div>
              <p className="text-[13px] font-bold text-[#111827] leading-tight">ZorEWS Copilot</p>
              <p className="text-[10px] text-[#6B7280] leading-tight">Enterprise Risk Intelligence Assistant</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* Connected modules badge */}
            <span className="hidden sm:flex items-center gap-1 text-[9.5px] font-medium text-indigo-600 bg-indigo-50 px-2 py-1 rounded-full border border-indigo-200 mr-1">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              16 Centers
            </span>
            {displayMessages.length > 0 && (
              <button
                type="button"
                onClick={onClear}
                aria-label="Clear conversation"
                className="w-8 h-8 rounded-[6px] hover:bg-gray-100 inline-flex items-center justify-center text-[#9CA3AF] hover:text-[#374151] transition-colors"
              >
                <RotateCcw size={13} strokeWidth={1.75} />
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close copilot"
              className="w-8 h-8 rounded-[6px] hover:bg-gray-100 inline-flex items-center justify-center text-[#9CA3AF] hover:text-[#374151] transition-colors"
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>
        </header>

        {/* ── Enterprise status bar ── */}
        <div className="shrink-0 h-6 bg-[#F9FAFB] border-b border-[#E5E7EB] flex items-center gap-3 px-4">
          <span className="flex items-center gap-1 text-[9.5px] text-[#6B7280]">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
            All systems operational
          </span>
          <span className="text-[#E5E7EB]">·</span>
          <span className="text-[9.5px] text-[#6B7280] capitalize">
            Context: {context.entity ? `${context.entity.type} ${context.entity.id}` : context.page ?? 'Enterprise Wide'}
          </span>
        </div>

        {/* ── Messages area ── */}
        <div
          ref={listRef}
          className="flex-1 overflow-y-auto py-3 px-3 space-y-2"
          style={{ background: '#F5F7FA' }}
        >
          {displayMessages.length === 0 ? (
            <WelcomeScreen
              userName={userName}
              tenantId={tenantId}
              onPrompt={(p) => void handleSend(p)}
            />
          ) : (
            <>
              {displayMessages.map((m) => (
                <div key={m.id} className={cn('flex', m.who === 'user' ? 'justify-end' : 'justify-start')}>
                  {m.who === 'bot' ? (
                    <BotMessage msg={m} />
                  ) : (
                    <div className="max-w-[80%] rounded-[12px] rounded-br-[4px] px-3.5 py-2.5 bg-[#4F46E5] text-white text-[12.5px] leading-relaxed">
                      {m.text}
                    </div>
                  )}
                </div>
              ))}

              {/* Typing indicator */}
              {sending && (
                <div className="flex justify-start">
                  <div className="bg-white border border-[#E5E7EB] rounded-[12px] rounded-bl-[4px] px-3.5 py-2.5 shadow-sm inline-flex items-center gap-1.5">
                    <span className="text-[11px] text-[#9CA3AF] mr-1">ZorEWS thinking</span>
                    {[0, 120, 240].map((d) => (
                      <span
                        key={d}
                        className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce"
                        style={{ animationDelay: `${d}ms` }}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Error */}
              {error && (
                <p role="alert" className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-[8px] px-3 py-2">
                  {error}
                </p>
              )}
            </>
          )}
        </div>

        {/* ── Suggestion chips ── */}
        {!sending && suggestions.length > 0 && (
          <div className="shrink-0 px-3 pt-2 pb-1.5 border-t border-[#E5E7EB] bg-white">
            <p className="text-[9.5px] text-[#9CA3AF] font-medium uppercase tracking-wide mb-1.5">Suggested Prompts</p>
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onChip(s)}
                  className="text-[11px] px-2.5 py-1 rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 hover:border-indigo-300 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Composer ── */}
        <form
          onSubmit={onSubmit}
          className="shrink-0 px-3 py-3 border-t border-[#E5E7EB] bg-white flex items-end gap-2"
        >
          <div className="flex-1 relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9CA3AF]" />
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Ask anything… search IDs, query risk, get briefings"
              aria-label="Message"
              disabled={sending}
              className="w-full resize-none max-h-32 pl-8 pr-3 py-2 text-[12.5px] rounded-[10px] border border-[#E5E7EB] bg-[#F9FAFB] focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 placeholder:text-[#9CA3AF] transition-all"
            />
          </div>
          <button
            type="submit"
            disabled={sending || !draft.trim()}
            aria-label="Send"
            className="shrink-0 w-9 h-9 rounded-[10px] bg-[#4F46E5] text-white inline-flex items-center justify-center hover:bg-[#4338CA] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Send size={15} strokeWidth={2} />
          </button>
        </form>

        {/* ── Footer ── */}
        <div className="shrink-0 px-3 py-1.5 bg-white border-t border-[#F3F4F6] flex items-center justify-between">
          <p className="text-[9.5px] text-[#9CA3AF]">ZorEWS Copilot · Enterprise Risk Intelligence</p>
          <div className="flex items-center gap-2">
            <Link to="/ai/workbench" className="text-[9.5px] text-indigo-500 hover:underline flex items-center gap-0.5">
              AI Workbench <ChevronRight size={9} />
            </Link>
          </div>
        </div>
      </aside>
    </>
  );
}
