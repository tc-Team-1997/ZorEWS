import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ShieldCheck,
  LogOut,
  Clock,
  ChevronDown,
  Search,
} from 'lucide-react';
import { useAuth } from '@/store/auth';
import { cn } from '@/lib/cn';
import { ChatWidget } from '@/components/copilot/ChatWidget';
import { NotificationBell } from '@/components/notifications/NotificationBell';
import { LanguageToggle } from '@/components/layout/LanguageToggle';
import { ModeToggle } from '@/components/layout/ModeToggle';
import { useIdleTimeout } from '@/lib/useIdleTimeout';
import { useDomain } from '@/lib/useOnboardingContext';
import { Button } from '@/components/ui';
import { NAV_GROUPS, NAV_HOME, visibleItems, type NavGroup, type NavLeaf } from './navConfig';

// Backward-compat alias retained for callers that imported the old shape.
// New code should import from ./navConfig.
export type NavItem = NavLeaf;

const COLLAPSE_STORAGE_KEY = 'apex.ews.nav.collapsed';

function readCollapsedFromStorage(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((v) => typeof v === 'string'));
  } catch {
    /* corrupt blob → ignore + fall through to default */
  }
  return new Set();
}

function writeCollapsedToStorage(set: Set<string>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    /* quota or disabled — ignore */
  }
}

// Backward-compat: assemble the flat NAV array from the new grouped config
// for any external consumer that previously imported `NAV`. Order matches
// the rendered sidebar (home → groups → items in declared order).
const NAV: readonly NavLeaf[] = ((): NavLeaf[] => {
  const out: NavLeaf[] = [NAV_HOME];
  for (const group of NAV_GROUPS) {
    for (const leaf of group.items) out.push(leaf);
  }
  return out;
})();
export { NAV };

// 15-min idle limit, 2-min warning window — banking standard.
// Read at render time (not module load) so test environments can override
// VITE_IDLE_MS / VITE_IDLE_WARN_MS in beforeEach.
function readIdleConfig() {
  return {
    idleMs: Number(import.meta.env.VITE_IDLE_MS ?? 15 * 60 * 1000),
    warnMs: Number(import.meta.env.VITE_IDLE_WARN_MS ?? 2 * 60 * 1000),
  };
}

export function AppShell() {
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const { idleMs, warnMs } = readIdleConfig();
  const { t } = useTranslation();
  const [domain] = useDomain();

  // Domain-scoped sidebar: a domain-tagged group is shown only when it
  // matches the active domain. Super-admins (the canonical `admin` backend
  // role) see BOTH domains. When no domain is chosen yet (e.g. a test that
  // renders AppShell directly, or pre-onboarding), show everything — the
  // RequireOnboarding gate handles forcing a choice in normal use.
  const isSuperAdmin = (user?.roles ?? []).includes('admin');
  const visibleGroups = NAV_GROUPS.filter(
    (g) => !g.domain || isSuperAdmin || !domain || g.domain === domain,
  );

  // Collapse state — persisted to localStorage so the operator's preference
  // survives reloads. Default: every group expanded.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() =>
    readCollapsedFromStorage(),
  );
  const toggleGroup = useCallback((id: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeCollapsedToStorage(next);
      return next;
    });
  }, []);

  const onLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  const idle = useIdleTimeout({
    idleMs,
    warnBeforeMs: warnMs,
    onTimeout: () => {
      logout();
      navigate('/login?reason=idle', { replace: true });
    },
  });

  // When the warning modal opens, move focus to its primary action so
  // screen-reader and keyboard users land on the "Stay signed in" button.
  // The ref is attached on the button below.
  const stayBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (idle.warning) stayBtnRef.current?.focus();
  }, [idle.warning]);

  // Avatar initials for the sidebar footer — first letter of each
  // dot-separated username segment (alice.admin → "AA"), capped at 2.
  const initials =
    (user?.username ?? '—')
      .split(/[._\s-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]!.toUpperCase())
      .join('') || '—';

  return (
    <div className="min-h-screen flex aurora-canvas">
      {/* Skip-to-content link — only visible when keyboard-focused. Lets
          screen-reader and keyboard-only users bypass the sidebar nav and
          jump straight to the main work area. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:bg-action focus:text-white focus:px-3 focus:py-1.5 focus:rounded focus:text-[12px] focus:font-medium focus:shadow"
        data-testid="skip-to-main"
      >
        Skip to main content
      </a>
      {/* Sidebar — Aurora deep-indigo glass surface */}
      <aside className="w-60 shrink-0 bg-sidebar text-sidebar-text flex flex-col bg-gradient-to-b from-aurora-ink to-[#161334] border-r border-white/[0.06]">
        <div className="px-5 py-5 flex items-center gap-2.5 border-b border-white/[0.07]">
          <div className="relative w-9 h-9 rounded-xl flex items-center justify-center bg-gradient-to-br from-aurora-indigo to-aurora-violet shadow-glow aurora-pulse">
            <ShieldCheck size={16} className="text-white" strokeWidth={2.25} />
          </div>
          <div>
            <p className="text-white text-[13px] font-semibold leading-tight tracking-tight">ZorEWS</p>
            <p className="text-white/55 text-[10px] leading-tight">Early Warning System</p>
          </div>
        </div>

        <nav
          className="flex-1 overflow-y-auto py-3"
          aria-label="Primary"
          data-testid="primary-nav"
        >
          {/* Home — always visible above the categories */}
          <ul className="px-2" data-testid="nav-home">
            <li>
              <NavLink
                to={NAV_HOME.to}
                end
                data-testid={`nav-link-${NAV_HOME.to}`}
                className={({ isActive }) =>
                  cn(
                    'relative flex items-center gap-2.5 rounded-input px-3 py-2 text-[13px] transition-colors',
                    isActive
                      ? 'bg-sidebar-hover text-white before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-full before:bg-aurora-lilac'
                      : 'text-sidebar-text hover:bg-sidebar-hover/60 hover:text-white',
                  )
                }
              >
                <NAV_HOME.icon size={16} strokeWidth={1.75} />
                <span>{t(`nav.${NAV_HOME.i18nKey}`)}</span>
              </NavLink>
            </li>
          </ul>

          {/* 6 enterprise category groups (collapsible) */}
          <div className="mt-2 space-y-1 px-2">
            {visibleGroups.map((group) => (
              <NavGroupSection
                key={group.id}
                group={group}
                isCollapsed={collapsedGroups.has(group.id)}
                onToggle={() => toggleGroup(group.id)}
                userRoles={user?.roles ?? []}
              />
            ))}
          </div>
        </nav>

        <div className="px-3 py-3 border-t border-white/[0.07]">
          <div className="px-2 pb-2 flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-white text-[11px] font-semibold bg-gradient-to-br from-aurora-indigo to-aurora-violet shadow-glow">
              {initials}
            </div>
            <div className="min-w-0">
              <p className="text-white text-xs font-medium leading-tight truncate">{user?.username ?? '—'}</p>
              <p className="text-white/50 text-[10px] leading-tight truncate">
                {user?.roles.join(', ') ?? 'guest'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="w-full flex items-center gap-2 rounded-input px-3 py-2 text-[12px] text-sidebar-text hover:bg-sidebar-hover/60 hover:text-white transition-colors"
          >
            <LogOut size={14} strokeWidth={1.75} />
            <span>{t('common.sign_out')}</span>
          </button>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 shrink-0 bg-white/70 backdrop-blur-xl border-b border-aurora-line flex items-center justify-between px-6">
          <div className="flex items-center gap-4 min-w-0">
            <span className="module-label text-xs text-aurora-ink-sub">{t('nav.risk_operations')}</span>
            <button
              type="button"
              className="hidden md:flex items-center gap-2 rounded-full border border-aurora-line bg-white/60 px-3 py-1.5 text-[12px] text-aurora-ink-sub hover:border-aurora-indigo/40 hover:text-aurora-indigo transition-colors"
              aria-label="Search"
              title="Search (coming soon)"
            >
              <Search size={13} strokeWidth={2} />
              <span>Search…</span>
              <kbd className="ml-1 rounded bg-aurora-tint px-1.5 py-0.5 text-[10px] font-semibold text-aurora-indigo">⌘K</kbd>
            </button>
          </div>
          <div className="flex items-center gap-3">
            <ModeToggle />
            <LanguageToggle />
            <NotificationBell />
            <span className="text-xs text-aurora-ink-sub">
              {t('nav.tenant')} · <span className="text-aurora-ink font-medium">apex-prototype</span>
            </span>
          </div>
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 overflow-y-auto p-6 focus:outline-none"
        >
          <Outlet />
        </main>
      </div>
      <ChatWidget />

      {idle.warning && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="idle-warning-title"
          data-testid="idle-warning"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-6"
        >
          <div className="bg-white rounded-xl shadow-2xl max-w-sm w-full p-6">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-9 h-9 rounded-full bg-amber-50 flex items-center justify-center shrink-0">
                <Clock size={18} className="text-amber-600" strokeWidth={2} />
              </div>
              <div>
                <h2 id="idle-warning-title" className="text-base font-semibold text-ink leading-snug">
                  {t('idle.title')}
                </h2>
                <p className="text-[13px] text-sub mt-1">
                  {t('idle.body', { minutes: Math.round(idleMs / 60000) })}
                </p>
              </div>
            </div>
            <p className="text-[13px] text-ink mb-4">
              {t('idle.countdown_prefix')}{' '}
              <span className="font-semibold tabular-nums" data-testid="idle-countdown">{idle.remainingSec}</span>{' '}
              {t('idle.countdown_suffix')}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                className="flex-1"
                onClick={onLogout}
                data-testid="idle-signout-now"
              >
                {t('idle.sign_out_now')}
              </Button>
              <Button
                type="button"
                className="flex-1"
                onClick={idle.extend}
                data-testid="idle-stay"
                ref={stayBtnRef}
              >
                {t('idle.stay_signed_in')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Category group — header + collapsible body
// ──────────────────────────────────────────────────────────────────────

interface NavGroupSectionProps {
  group: NavGroup;
  isCollapsed: boolean;
  onToggle: () => void;
  userRoles: ReadonlyArray<string>;
}

function NavGroupSection({ group, isCollapsed, onToggle, userRoles }: NavGroupSectionProps) {
  const { t } = useTranslation();
  const items = useMemo(() => visibleItems(group, userRoles), [group, userRoles]);

  // Hide the entire group when role-gating leaves zero items.
  if (items.length === 0) return null;

  const GroupIcon = group.icon;
  const groupLabel = t(`nav.${group.i18nKey}`);

  return (
    <div data-testid={`nav-group-${group.id}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!isCollapsed}
        aria-controls={`nav-group-${group.id}-items`}
        data-testid={`nav-group-header-${group.id}`}
        className="w-full flex items-center justify-between gap-2 px-3 pt-3 pb-1.5 text-[10px] uppercase tracking-[0.08em] font-semibold text-white/40 hover:text-white/70 transition-colors"
      >
        <span className="flex items-center gap-2">
          <GroupIcon size={11} strokeWidth={2} />
          <span>{groupLabel}</span>
        </span>
        <ChevronDown
          size={12}
          strokeWidth={2}
          className={cn(
            'transition-transform duration-150',
            isCollapsed && '-rotate-90',
          )}
          aria-hidden="true"
        />
      </button>
      {!isCollapsed && (
        <ul
          id={`nav-group-${group.id}-items`}
          className="space-y-0.5"
          data-testid={`nav-group-${group.id}-items`}
        >
          {items.map(({ to, i18nKey, icon: Icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={to === '/'}
                data-testid={`nav-link-${to}`}
                className={({ isActive }) =>
                  cn(
                    'relative flex items-center gap-2.5 rounded-input px-3 py-2 text-[13px] transition-colors',
                    isActive
                      ? 'bg-sidebar-hover text-white before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-full before:bg-aurora-lilac'
                      : 'text-sidebar-text hover:bg-sidebar-hover/60 hover:text-white',
                  )
                }
              >
                <Icon size={16} strokeWidth={1.75} />
                <span>{t(`nav.${i18nKey}`)}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
