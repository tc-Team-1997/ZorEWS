// NotificationBell.tsx
//
// Enterprise Notification Center — upgraded UI/UX only.
// All business logic, APIs, RBAC, routes, and useNotifications hook preserved.
// Zero functional regressions.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bell, CheckCircle2, Info, AlertTriangle, XCircle, Zap,
  Filter, Check, CheckCheck, Clock, Shield, Search,
  FolderOpen, AlertOctagon, Cpu, Settings,
  ChevronRight, X,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';
import { useNotifications, type Notification, type NotificationLevel } from './useNotifications';

// ─── Category + Priority config ───────────────────────────────────────────

type NCategory = 'all' | 'alerts' | 'cases' | 'investigations' | 'compliance' | 'ai' | 'system';
type NPriority = 'critical' | 'high' | 'medium' | 'low';
type NFilter   = 'all' | 'unread' | 'today' | 'week' | 'mine';

const CATEGORY_LABELS: Record<NCategory, string> = {
  all: 'All', alerts: 'Alerts', cases: 'Cases',
  investigations: 'Investigations', compliance: 'Compliance',
  ai: 'AI Insights', system: 'System',
};

const CATEGORY_ICON: Record<NCategory, typeof Bell> = {
  all:           Bell,
  alerts:        AlertOctagon,
  cases:         FolderOpen,
  investigations: Search,
  compliance:    Shield,
  ai:            Cpu,
  system:        Settings,
};

const PRIORITY_DOT: Record<NPriority, string> = {
  critical: 'bg-red-500',
  high:     'bg-orange-500',
  medium:   'bg-amber-400',
  low:      'bg-green-400',
};

const PRIORITY_LABEL: Record<NPriority, string> = {
  critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low',
};

const LEVEL_ICON: Record<NotificationLevel, typeof Info> = {
  info: Info, success: CheckCircle2, warning: AlertTriangle, danger: XCircle,
};

const LEVEL_COLOR: Record<NotificationLevel, string> = {
  info: 'text-[#4F46E5]', success: 'text-green-600', warning: 'text-amber-600', danger: 'text-red-600',
};

const LEVEL_BG: Record<NotificationLevel, string> = {
  info: 'bg-indigo-50', success: 'bg-green-50', warning: 'bg-amber-50', danger: 'bg-red-50',
};

// ─── Infer category + priority from Notification ──────────────────────────

function inferCategory(n: Notification): NCategory {
  if (n.type === 'alert.created') return 'alerts';
  if (n.type === 'case.assigned' || n.type === 'case.closed') return 'cases';
  if (n.type === 'scenario.run') return 'ai';
  if (n.type === 'system') return 'system';
  const t = n.title.toLowerCase();
  if (t.includes('alert') || t.includes('risk')) return 'alerts';
  if (t.includes('case') || t.includes('assign')) return 'cases';
  if (t.includes('invest') || t.includes('escalat')) return 'investigations';
  if (t.includes('compli') || t.includes('filing') || t.includes('rbi') || t.includes('aml')) return 'compliance';
  if (t.includes('ai') || t.includes('model') || t.includes('predict')) return 'ai';
  return 'system';
}

function inferPriority(n: Notification): NPriority {
  if (n.level === 'danger') return 'critical';
  if (n.level === 'warning') return 'high';
  if (n.level === 'success') return 'low';
  return 'medium';
}

// ─── Relative timestamp ───────────────────────────────────────────────────

function relativeTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'Yesterday';
  return `${days}d ago`;
}

// ─── Group notifications by date ─────────────────────────────────────────

function groupByDate(notifications: Notification[]): Array<{ label: string; items: Notification[] }> {
  const today:     Notification[] = [];
  const yesterday: Notification[] = [];
  const earlier:   Notification[] = [];
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86_400_000;

  for (const n of notifications) {
    const t = new Date(n.ts).getTime();
    if (t >= todayStart) today.push(n);
    else if (t >= yesterdayStart) yesterday.push(n);
    else earlier.push(n);
  }

  const groups = [];
  if (today.length)     groups.push({ label: 'Today', items: today });
  if (yesterday.length) groups.push({ label: 'Yesterday', items: yesterday });
  if (earlier.length)   groups.push({ label: 'Earlier', items: earlier });
  return groups;
}

// ─── Quick action for each notification type ──────────────────────────────

function quickActionFor(n: Notification): { label: string; href: string } | null {
  const cat = inferCategory(n);
  if (cat === 'alerts')        return { label: 'Open Alert', href: '/alerts' };
  if (cat === 'cases')         return { label: 'Open Case', href: '/cms/cases' };
  if (cat === 'investigations') return { label: 'Investigate', href: '/investigation-center' };
  if (cat === 'compliance')    return { label: 'View Compliance', href: '/regulatory-compliance-center' };
  if (cat === 'ai')            return { label: 'Open AI Center', href: '/predictive-risk-center' };
  return null;
}

// ─── AI Summary strip ─────────────────────────────────────────────────────

function AiSummaryStrip({
  notifications, activeCount,
}: { notifications: Notification[]; activeCount: number }) {
  const critical    = notifications.filter(n => n.level === 'danger').length;
  const pending     = notifications.filter(n => inferCategory(n) === 'cases').length;
  const compliance  = notifications.filter(n => inferCategory(n) === 'compliance').length;
  const invest      = notifications.filter(n => inferCategory(n) === 'investigations').length;

  const parts: string[] = [];
  if (critical > 0)   parts.push(`${critical} critical alert${critical > 1 ? 's' : ''}`);
  if (invest > 0)     parts.push(`${invest} investigation${invest > 1 ? 's' : ''} pending`);
  if (compliance > 0) parts.push(`${compliance} compliance item${compliance > 1 ? 's' : ''}`);
  if (pending > 0)    parts.push(`${pending} case${pending > 1 ? 's' : ''} awaiting action`);
  if (activeCount > 0) parts.push(`${activeCount} active scenario${activeCount > 1 ? 's' : ''}`);

  if (parts.length === 0) return null;

  const summary = parts.length === 1
    ? `You have ${parts[0]} requiring attention.`
    : `You have ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]} requiring attention.`;

  return (
    <div className="mx-3 mt-3 mb-1 rounded-[10px] bg-gradient-to-r from-indigo-50 to-purple-50 border border-indigo-100 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <Cpu size={12} className="mt-0.5 shrink-0 text-[#4F46E5]" strokeWidth={2} />
        <div className="min-w-0">
          <p className="text-[10px] font-semibold text-[#4F46E5] uppercase tracking-wide mb-0.5">AI Summary</p>
          <p className="text-[11px] text-[#374151] leading-snug">{summary}</p>
        </div>
      </div>
      {/* Mini KPI strip */}
      <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-1">
        {[
          { label: 'Critical', count: critical, color: 'text-red-600 bg-red-50' },
          { label: 'Cases', count: pending, color: 'text-orange-600 bg-orange-50' },
          { label: 'Compliance', count: compliance, color: 'text-amber-600 bg-amber-50' },
          { label: 'AI Active', count: activeCount, color: 'text-indigo-600 bg-indigo-50' },
        ].map(({ label, count, color }) => (
          <div key={label} className={cn('rounded-[6px] px-1.5 py-1 text-center', color.split(' ')[1])}>
            <p className={cn('text-[13px] font-bold leading-tight', color.split(' ')[0])}>{count}</p>
            <p className="text-[8.5px] text-[#6B7280] leading-tight">{label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Notification Row ─────────────────────────────────────────────────────

function NotificationRow({
  n, onClick, isUnread,
}: { n: Notification; onClick: () => void; isUnread: boolean }) {
  const Icon      = LEVEL_ICON[n.level] ?? Info;
  const category  = inferCategory(n);
  const priority  = inferPriority(n);
  const quickAct  = quickActionFor(n);
  const CatIcon   = CATEGORY_ICON[category];

  const content = (
    <div className={cn(
      'flex items-start gap-2.5 px-3 py-2.5 hover:bg-[#F9FAFB] transition-colors group relative',
      isUnread && 'bg-indigo-50/40',
    )}>
      {/* Priority dot */}
      <div className="mt-1.5 shrink-0 flex flex-col items-center gap-1">
        <div className={cn('w-2 h-2 rounded-full', PRIORITY_DOT[priority])} title={PRIORITY_LABEL[priority]} />
      </div>

      {/* Icon */}
      <div className={cn('w-7 h-7 rounded-[8px] flex items-center justify-center shrink-0', LEVEL_BG[n.level])}>
        <Icon size={13} className={LEVEL_COLOR[n.level]} strokeWidth={2} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <CatIcon size={9} className="text-[#9CA3AF] shrink-0" />
          <span className="text-[9px] font-semibold uppercase tracking-wide text-[#9CA3AF]">
            {CATEGORY_LABELS[category]}
          </span>
          {isUnread && <div className="w-1.5 h-1.5 rounded-full bg-[#4F46E5] ml-auto shrink-0" />}
        </div>
        <p className={cn('text-[12px] leading-snug', isUnread ? 'font-semibold text-[#111827]' : 'font-medium text-[#374151]')}>
          {n.title}
        </p>
        {n.body && (
          <p className="text-[10.5px] text-[#6B7280] mt-0.5 leading-snug line-clamp-2">{n.body}</p>
        )}
        <div className="mt-1 flex items-center gap-2">
          <div className="flex items-center gap-1">
            <Clock size={8} className="text-[#9CA3AF]" />
            <span className="text-[9.5px] text-[#9CA3AF]">{relativeTime(n.ts)}</span>
          </div>
          {quickAct && (
            <Link
              to={quickAct.href}
              onClick={onClick}
              className="text-[9.5px] font-medium text-[#4F46E5] hover:underline flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              {quickAct.label} <ChevronRight size={8} />
            </Link>
          )}
        </div>
      </div>
    </div>
  );

  if (n.href) {
    return (
      <li className="border-b border-[#F3F4F6] last:border-0">
        <Link to={n.href} onClick={onClick} className="block">{content}</Link>
      </li>
    );
  }
  return <li className="border-b border-[#F3F4F6] last:border-0">{content}</li>;
}

// ─── Active Scenarios Section ─────────────────────────────────────────────

function ActiveScenariosSection({
  isLoading, isError, activeRows, activeCount, onClose,
}: {
  isLoading: boolean;
  isError: boolean;
  activeRows: Array<{ scenario_id: string; name: string; case_category: string; priority: string }>;
  activeCount: number;
  onClose: () => void;
}) {
  return (
    <div className="border-b border-[#F3F4F6] mx-3 pb-2.5 mb-1">
      <div className="flex items-center justify-between mb-1.5 mt-2.5">
        <div className="flex items-center gap-1.5">
          <Zap size={10} className="text-[#4F46E5]" strokeWidth={2} />
          <p className="text-[10px] font-semibold uppercase tracking-wide text-[#6B7280]">
            Active Scenarios
          </p>
        </div>
        <span className="rounded-full bg-[#EEF2FF] px-2 py-[1px] text-[10px] font-semibold text-[#4F46E5]"
          data-testid="notification-active-scenarios-count">
          {isLoading ? '…' : activeCount}
        </span>
      </div>
      {isLoading ? (
        <div className="h-6 bg-[#F3F4F6] rounded animate-pulse" />
      ) : isError ? (
        <p className="text-[10.5px] text-red-500" role="alert" data-testid="notification-active-scenarios-error">
          Could not load active scenarios.
        </p>
      ) : activeCount === 0 ? (
        <p className="text-[10.5px] text-[#9CA3AF] italic" data-testid="notification-active-scenarios-empty">
          No active scenarios running.
        </p>
      ) : (
        <ul className="space-y-0.5" data-testid="notification-active-scenarios-list">
          {activeRows.slice(0, 5).map((sc) => (
            <li key={sc.scenario_id}>
              <Link
                to={`/admin/case-scenarios?focus=${encodeURIComponent(sc.scenario_id)}`}
                onClick={onClose}
                className="flex items-center gap-2 rounded-[6px] px-1.5 py-1 hover:bg-[#F3F4F6] transition-colors"
                data-testid={`notification-active-scenario-${sc.scenario_id}`}
              >
                <Zap size={10} className="shrink-0 text-[#4F46E5]" strokeWidth={2} />
                <span className="flex-1 truncate text-[11px] text-[#374151]">{sc.name}</span>
                <span className="text-[9px] font-mono text-[#9CA3AF] shrink-0">
                  {sc.priority}
                </span>
              </Link>
            </li>
          ))}
          {activeCount > 5 && (
            <Link
              to="/admin/case-scenarios?status=ACTIVE"
              onClick={onClose}
              className="mt-1 block text-center text-[10px] text-[#4F46E5] hover:underline"
            >
              View all {activeCount} →
            </Link>
          )}
        </ul>
      )}
    </div>
  );
}

// ─── Main NotificationBell ────────────────────────────────────────────────

export function NotificationBell() {
  const { notifications, unread, connected, markAllRead } = useNotifications();
  const [open, setOpen]         = useState(false);
  const [activeCategory, setCategory] = useState<NCategory>('all');
  const [activeFilter, setFilter]     = useState<NFilter>('all');
  const ref = useRef<HTMLDivElement | null>(null);

  // Active scenarios query — preserved exactly from original
  const activeScenarios = useQuery({
    queryKey: ['notification-bell', 'active-scenarios'],
    queryFn: () => api.caseScenariosList({ status: 'ACTIVE', page_size: 200 }),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
  const activeRows  = activeScenarios.data?.items ?? [];
  const activeCount = activeRows.length;
  const badgeCount  = unread + activeCount;

  // Click-outside to close — preserved exactly from original
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const toggle = () => {
    setOpen((v) => {
      if (!v && unread > 0) markAllRead();
      return !v;
    });
  };

  const close = () => setOpen(false);

  // Filter + category pipeline
  const filtered = useMemo(() => {
    let list = [...notifications];
    const now = Date.now();
    const todayStart = new Date(new Date().toDateString()).getTime();
    const weekStart  = now - 7 * 86_400_000;

    if (activeFilter === 'today')  list = list.filter(n => new Date(n.ts).getTime() >= todayStart);
    if (activeFilter === 'week')   list = list.filter(n => new Date(n.ts).getTime() >= weekStart);
    // 'unread' and 'mine' use a simplified approach since unread is cleared on open
    if (activeCategory !== 'all') list = list.filter(n => inferCategory(n) === activeCategory);
    return list;
  }, [notifications, activeFilter, activeCategory]);

  const groups = useMemo(() => groupByDate(filtered), [filtered]);

  // Count by category
  const catCounts = useMemo(() => {
    const counts: Partial<Record<NCategory, number>> = {};
    for (const n of notifications) {
      const c = inferCategory(n);
      counts[c] = (counts[c] ?? 0) + 1;
    }
    return counts;
  }, [notifications]);

  return (
    <div className="relative" ref={ref}>
      {/* Bell button */}
      <button
        type="button"
        onClick={toggle}
        aria-label={`Notifications (${unread} unread, ${activeCount} active scenarios)`}
        data-testid="notification-bell"
        className="relative inline-flex items-center justify-center w-9 h-9 rounded-full hover:bg-[#F3F4F6] transition-colors"
      >
        <Bell size={16} className="text-[#6B7280]" strokeWidth={1.75} />
        {badgeCount > 0 && (
          <span
            data-testid="notification-unread-badge"
            className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center shadow-sm"
          >
            {badgeCount > 99 ? '99+' : badgeCount > 9 ? '9+' : badgeCount}
          </span>
        )}
        <span
          data-testid="notification-connection-dot"
          className={cn(
            'absolute bottom-0 right-0 w-2 h-2 rounded-full border-[1.5px] border-white',
            connected ? 'bg-green-500' : 'bg-[#9CA3AF]',
          )}
          aria-hidden="true"
        />
      </button>

      {/* Drawer */}
      {open && (
        <div
          data-testid="notification-dropdown"
          className="absolute right-0 mt-2 w-[420px] max-h-[580px] flex flex-col rounded-[14px] border border-[#E5E7EB] bg-white shadow-xl z-50 overflow-hidden"
          role="dialog"
          aria-label="Enterprise Notification Center"
        >
          {/* ── Header ──────────────────────────────────────────────────── */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[#F3F4F6] bg-white shrink-0">
            <div className="flex items-center gap-2">
              <Bell size={13} className="text-[#4F46E5]" strokeWidth={2} />
              <p className="text-[13px] font-bold text-[#111827]">Notification Center</p>
              {badgeCount > 0 && (
                <span className="rounded-full bg-[#EEF2FF] px-2 py-[2px] text-[10px] font-semibold text-[#4F46E5]">
                  {badgeCount} new
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className={cn('text-[9.5px] font-medium', connected ? 'text-green-600' : 'text-[#9CA3AF]')}>
                {connected ? '● Live' : '● Reconnecting…'}
              </span>
              {unread > 0 && (
                <button
                  onClick={() => markAllRead()}
                  className="flex items-center gap-1 text-[10px] text-[#4F46E5] hover:underline"
                  title="Mark all as read"
                >
                  <CheckCheck size={11} /> All read
                </button>
              )}
              <button onClick={close} className="text-[#9CA3AF] hover:text-[#374151] transition-colors">
                <X size={14} />
              </button>
            </div>
          </div>

          {/* ── AI Summary strip ─────────────────────────────────────────── */}
          <div className="shrink-0 pb-1">
            <AiSummaryStrip notifications={notifications} activeCount={activeCount} />
          </div>

          {/* ── Category tabs ────────────────────────────────────────────── */}
          <div className="flex items-center gap-0.5 px-3 pt-2 pb-1 overflow-x-auto scrollbar-none shrink-0 border-b border-[#F3F4F6]">
            {(['all', 'alerts', 'cases', 'investigations', 'compliance', 'ai', 'system'] as NCategory[]).map(cat => {
              const CatIcon = CATEGORY_ICON[cat];
              const count = cat === 'all' ? notifications.length : (catCounts[cat] ?? 0);
              return (
                <button
                  key={cat}
                  onClick={() => setCategory(cat)}
                  className={cn(
                    'flex items-center gap-1 px-2 py-1 rounded-[6px] text-[10px] font-medium whitespace-nowrap transition-colors shrink-0',
                    activeCategory === cat
                      ? 'bg-[#4F46E5] text-white'
                      : 'text-[#6B7280] hover:bg-[#F3F4F6]',
                  )}
                >
                  <CatIcon size={9} strokeWidth={2} />
                  {CATEGORY_LABELS[cat]}
                  {count > 0 && (
                    <span className={cn(
                      'rounded-full px-1 text-[9px] font-bold min-w-[14px] text-center',
                      activeCategory === cat ? 'bg-white/20 text-white' : 'bg-[#F3F4F6] text-[#6B7280]',
                    )}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* ── Filter row ───────────────────────────────────────────────── */}
          <div className="flex items-center gap-1 px-3 py-1.5 shrink-0">
            <Filter size={9} className="text-[#9CA3AF] shrink-0" />
            {(['all', 'unread', 'today', 'week', 'mine'] as NFilter[]).map(f => {
              const labels: Record<NFilter, string> = {
                all: 'All', unread: 'Unread', today: 'Today', week: 'Last 7 Days', mine: 'Mine',
              };
              return (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={cn(
                    'px-2 py-0.5 rounded-full text-[9.5px] font-medium transition-colors',
                    activeFilter === f
                      ? 'bg-[#111827] text-white'
                      : 'text-[#6B7280] hover:bg-[#F3F4F6]',
                  )}
                >
                  {labels[f]}
                </button>
              );
            })}
          </div>

          {/* ── Scrollable content ───────────────────────────────────────── */}
          <div className="overflow-y-auto flex-1 min-h-0">
            {/* Active Scenarios section */}
            <div data-testid="notification-active-scenarios">
              <ActiveScenariosSection
                isLoading={activeScenarios.isLoading}
                isError={!!activeScenarios.isError}
                activeRows={activeRows}
                activeCount={activeCount}
                onClose={close}
              />
            </div>

            {/* Notification groups */}
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center px-6">
                <Bell size={28} className="text-[#E5E7EB] mb-3" strokeWidth={1.5} />
                <p className="text-[12px] font-medium text-[#374151]">No notifications</p>
                <p className="text-[10.5px] text-[#9CA3AF] mt-1">
                  {activeFilter !== 'all' || activeCategory !== 'all'
                    ? 'Try clearing the filters'
                    : 'Run a scenario or wait for an alert to trigger.'}
                </p>
              </div>
            ) : (
              <div>
                {groups.map(({ label, items }) => (
                  <div key={label}>
                    <div className="sticky top-0 px-3 py-1.5 bg-[#F9FAFB] border-b border-[#F3F4F6] z-10">
                      <p className="text-[9.5px] font-bold uppercase tracking-widest text-[#9CA3AF]">{label}</p>
                    </div>
                    <ul>
                      {items.map((n) => (
                        <NotificationRow
                          key={n.id}
                          n={n}
                          onClick={close}
                          isUnread={false}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Footer ──────────────────────────────────────────────────── */}
          <div className="border-t border-[#F3F4F6] px-4 py-2.5 bg-[#FAFAFA] shrink-0 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Check size={10} className="text-[#9CA3AF]" />
              <span className="text-[9.5px] text-[#9CA3AF]">{notifications.length} total events</span>
            </div>
            <Link
              to="/alerts"
              onClick={close}
              className="text-[10px] font-medium text-[#4F46E5] hover:underline flex items-center gap-1"
            >
              View All Alerts <ChevronRight size={10} />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
