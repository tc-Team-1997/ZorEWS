import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ShieldCheck,
  LogOut,
  Clock,
  ChevronDown,
  Search,
  User,
  Settings,
  KeyRound,
  Building2,
  Menu,
} from 'lucide-react';
import { useAuth } from '@/store/auth';
import { cn } from '@/lib/cn';
import { ChatWidget } from '@/components/copilot/ChatWidget';
import { NotificationBell } from '@/components/notifications/NotificationBell';
import { LanguageToggle } from '@/components/layout/LanguageToggle';
import { ModeToggle } from '@/components/layout/ModeToggle';
import { useIdleTimeout } from '@/lib/useIdleTimeout';
import { useDomain, useTenantContext } from '@/lib/useOnboardingContext';
import { getOrganization } from '@/lib/organizations';
import { Button } from '@/components/ui';
import { CommandPalette } from './CommandPalette';
import { NAV_GROUPS, NAV_HOME, visibleItems, type NavGroup, type NavLeaf } from './navConfig';

// Backward-compat alias retained for callers that imported the old shape.
export type NavItem = NavLeaf;

const COLLAPSE_STORAGE_KEY = 'apex.ews.nav.collapsed';

function readCollapsedFromStorage(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((v) => typeof v === 'string'));
  } catch { /* corrupt blob → ignore */ }
  return new Set();
}

function writeCollapsedToStorage(set: Set<string>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...set]));
  } catch { /* quota or disabled */ }
}

// Flat NAV array for external consumers that previously imported `NAV`.
const NAV: readonly NavLeaf[] = ((): NavLeaf[] => {
  const out: NavLeaf[] = [NAV_HOME];
  for (const group of NAV_GROUPS) {
    for (const leaf of group.items) out.push(leaf);
  }
  return out;
})();
export { NAV };

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
  const [tenantCtx] = useTenantContext();

  // Resolve organisation display name from TenantContext
  const orgName = (() => {
    if (tenantCtx?.organization_id) {
      const org = getOrganization(tenantCtx.organization_id);
      if (org) return org.short_name ?? org.name;
    }
    if (tenantCtx?.tenant_id) {
      const tidMap: Record<string, string> = {
        BANK_DEMO: 'Banking Enterprise',
        BIL: 'BIL Insurance',
      };
      return tidMap[tenantCtx.tenant_id] ?? tenantCtx.tenant_id;
    }
    return 'Enterprise';
  })();

  // Mobile nav drawer — sidebar collapses to a hamburger-triggered drawer < lg.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const location = useLocation();
  // Close the drawer on any route change (covers nav-link clicks).
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);
  // Escape closes + body-scroll lock while the drawer is open.
  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [mobileNavOpen]);
  // Crossing up to ≥ lg (e.g. tablet rotate / window resize) must close the
  // drawer — otherwise the (now-hidden) backdrop would leave the desktop body
  // scroll-locked.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = () => {
      if (mq.matches) setMobileNavOpen(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Enterprise user-menu dropdown — lives in the top navbar
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!userMenuOpen) return;
    const onOutside = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [userMenuOpen]);

  // Domain-scoped sidebar
  const isSuperAdmin = (user?.roles ?? []).includes('admin');
  const visibleGroups = NAV_GROUPS.filter(
    (g) => !g.domain || isSuperAdmin || !domain || g.domain === domain,
  );

  // Collapse state persisted to localStorage
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

  const stayBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (idle.warning) stayBtnRef.current?.focus();
  }, [idle.warning]);

  // ⌘K palette
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Avatar initials — first letter of each dot-separated segment (alice.admin → AA)
  const initials =
    (user?.username ?? '—')
      .split(/[._\s-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]!.toUpperCase())
      .join('') || '—';

  const displayName = user?.display_name ?? user?.username ?? '—';
  const roleLabel = (user?.roles[0] ?? 'guest').replace(/_/g, ' ');

  return (
    <div className="min-h-screen flex bg-[#F5F7FA]">
      {/* Skip-to-content */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:bg-[#4F46E5] focus:text-white focus:px-3 focus:py-1.5 focus:rounded-lg focus:text-[12px] focus:font-medium focus:shadow"
        data-testid="skip-to-main"
      >
        Skip to main content
      </a>

      {/* ── SIDEBAR ──────────────────────────────────────────────────── */}
      {/* Always rendered; on < lg it is fixed + off-canvas (translate, NOT
          display:none, so nav links stay in the a11y tree) and slides in when
          the hamburger is tapped. On ≥ lg it is a static, always-visible rail. */}
      <aside
        data-testid="primary-sidebar"
        className={cn(
          'w-[220px] shrink-0 bg-white flex flex-col border-r border-[#E5E7EB]',
          'fixed inset-y-0 left-0 z-40 transition-transform duration-200',
          'lg:static lg:z-auto lg:translate-x-0',
          mobileNavOpen ? 'translate-x-0 shadow-xl' : '-translate-x-full lg:shadow-none',
        )}
      >

        {/* Logo */}
        <div className="h-[56px] px-4 flex items-center gap-3 border-b border-[#E5E7EB]">
          <div className="w-8 h-8 rounded-[10px] flex items-center justify-center bg-[#4F46E5] shadow-sm">
            <ShieldCheck size={15} className="text-white" strokeWidth={2.25} />
          </div>
          <div>
            <p className="text-[13px] font-semibold text-[#111827] leading-tight tracking-tight">ZorEWS</p>
            <p className="text-[10px] text-[#6B7280] leading-tight">Early Warning System</p>
          </div>
        </div>

        {/* Navigation */}
        <nav
          className="flex-1 overflow-y-auto py-3 px-2"
          aria-label="Primary"
          data-testid="primary-nav"
        >
          {/* Home */}
          <ul className="mb-1" data-testid="nav-home">
            <li>
              <NavLink
                to={NAV_HOME.to}
                end
                data-testid={`nav-link-${NAV_HOME.to}`}
                className={({ isActive }) =>
                  cn(
                    'relative flex items-center gap-2.5 rounded-[8px] px-3 py-[7px] text-[12.5px] transition-all duration-150',
                    isActive
                      ? 'bg-sidebar-hover text-indigo-600 font-medium before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[3px] before:rounded-full before:bg-indigo-600'
                      : 'text-[#374151] hover:bg-[#F9FAFB] hover:text-[#111827]',
                  )
                }
              >
                <NAV_HOME.icon size={15} strokeWidth={1.75} />
                <span>{t(`nav.${NAV_HOME.i18nKey}`)}</span>
              </NavLink>
            </li>
          </ul>

          {/* Category groups */}
          <div className="space-y-0.5">
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
        {/* No sidebar footer — user profile moved to top navbar */}
      </aside>

      {/* Mobile drawer backdrop — only rendered while open, only on < lg. */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileNavOpen(false)}
          data-testid="mobile-nav-backdrop"
          aria-hidden
        />
      )}

      {/* ── MAIN AREA ─────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* Top Navbar */}
        <header className="h-[56px] shrink-0 bg-white border-b border-[#E5E7EB] flex items-center justify-between px-5 gap-4">

          {/* Left: hamburger (mobile) + search */}
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="lg:hidden -ml-1 rounded-[8px] p-2 text-[#6B7280] hover:bg-[#F5F7FA] hover:text-[#4F46E5] transition-colors"
              aria-label="Open navigation"
              data-testid="mobile-nav-toggle"
            >
              <Menu size={18} strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="hidden md:flex items-center gap-2 rounded-[8px] border border-[#E5E7EB] bg-[#F9FAFB] px-3 py-[6px] text-[12px] text-[#6B7280] hover:border-[#4F46E5]/40 hover:text-[#4F46E5] hover:bg-[#F5F7FA] transition-all duration-150"
              aria-label="Open command palette"
              data-testid="open-command-palette"
            >
              <Search size={13} strokeWidth={2} />
              <span>Search…</span>
              <kbd className="ml-1 rounded-[4px] bg-[#EEF2FF] px-1.5 py-0.5 text-[10px] font-semibold text-[#4F46E5]">⌘K</kbd>
            </button>
          </div>

          {/* Right: tools + user menu */}
          <div className="flex items-center gap-1.5">
            {/* Secondary toggles hide on narrow viewports to prevent topbar
                overflow (same precedent as the md-hidden search button). */}
            <div className="hidden sm:flex items-center gap-1.5">
              <ModeToggle />
              <LanguageToggle />
            </div>
            <NotificationBell />

            {/* Divider */}
            <div className="w-px h-5 bg-[#E5E7EB] mx-1" />

            {/* User avatar + dropdown trigger */}
            <div className="relative" ref={userMenuRef}>
              <button
                type="button"
                onClick={() => setUserMenuOpen((o) => !o)}
                aria-haspopup="true"
                aria-expanded={userMenuOpen}
                data-testid="user-menu-trigger"
                className="flex items-center gap-2 rounded-[8px] px-2 py-1.5 hover:bg-[#F5F7FA] transition-colors duration-150 group"
              >
                {/* Avatar */}
                <div className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-white text-[11px] font-semibold bg-[#4F46E5] select-none">
                  {initials}
                </div>
                {/* Name + role — hidden on small screens */}
                <div className="hidden lg:block text-left leading-none">
                  <p className="text-[12px] font-medium text-[#111827] leading-tight">{displayName}</p>
                  <p className="text-[10px] text-[#6B7280] leading-tight capitalize">{roleLabel}</p>
                </div>
                <ChevronDown
                  size={13}
                  strokeWidth={2}
                  className={cn(
                    'text-[#9CA3AF] shrink-0 transition-transform duration-200',
                    userMenuOpen && 'rotate-180',
                  )}
                />
              </button>

              {/* Dropdown panel — opens downward */}
              {userMenuOpen && (
                <div
                  role="menu"
                  data-testid="user-menu-dropdown"
                  className="absolute right-0 top-full mt-1.5 w-[240px] bg-white rounded-[12px] border border-[#E5E7EB] shadow-[0_4px_24px_rgba(0,0,0,0.08)] z-50 overflow-hidden"
                  style={{ animation: 'fadeSlideDown 0.15s ease-out' }}
                >
                  {/* Identity header */}
                  <div className="px-4 py-3.5 bg-[#F9FAFB] border-b border-[#E5E7EB]">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-[13px] font-semibold bg-[#4F46E5] shrink-0 select-none">
                        {initials}
                      </div>
                      <div className="min-w-0">
                        <p className="text-[13px] font-semibold text-[#111827] truncate leading-tight">
                          {displayName}
                        </p>
                        <p className="text-[11px] text-[#6B7280] truncate leading-tight">{user?.username ?? ''}</p>
                        <div className="mt-1 flex items-center gap-1">
                          <Building2 size={10} className="text-[#4F46E5] shrink-0" strokeWidth={2} />
                          <span className="text-[10px] text-[#4F46E5] font-medium truncate">{orgName}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Menu items */}
                  <div className="py-1">
                    <Link
                      to="/profile/sessions"
                      role="menuitem"
                      data-testid="user-menu-profile"
                      onClick={() => setUserMenuOpen(false)}
                      className="flex items-center gap-2.5 px-4 py-2.5 text-[12.5px] text-[#374151] hover:bg-[#F5F7FA] hover:text-[#4F46E5] transition-colors duration-100"
                    >
                      <User size={14} strokeWidth={1.75} className="text-[#9CA3AF]" />
                      <span>{t('common.my_profile')}</span>
                    </Link>
                    <Link
                      to="/admin/users"
                      role="menuitem"
                      data-testid="user-menu-settings"
                      onClick={() => setUserMenuOpen(false)}
                      className="flex items-center gap-2.5 px-4 py-2.5 text-[12.5px] text-[#374151] hover:bg-[#F5F7FA] hover:text-[#4F46E5] transition-colors duration-100"
                    >
                      <Settings size={14} strokeWidth={1.75} className="text-[#9CA3AF]" />
                      <span>{t('common.settings')}</span>
                    </Link>
                    <Link
                      to="/reset-password"
                      role="menuitem"
                      data-testid="user-menu-change-password"
                      onClick={() => setUserMenuOpen(false)}
                      className="flex items-center gap-2.5 px-4 py-2.5 text-[12.5px] text-[#374151] hover:bg-[#F5F7FA] hover:text-[#4F46E5] transition-colors duration-100"
                    >
                      <KeyRound size={14} strokeWidth={1.75} className="text-[#9CA3AF]" />
                      <span>{t('common.change_password')}</span>
                    </Link>
                  </div>

                  {/* Divider + Sign Out */}
                  <div className="border-t border-[#E5E7EB] py-1">
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="user-menu-sign-out"
                      onClick={() => { setUserMenuOpen(false); onLogout(); }}
                      className="w-full flex items-center gap-2.5 px-4 py-2.5 text-[12.5px] text-[#DC2626] hover:bg-red-50 transition-colors duration-100"
                    >
                      <LogOut size={14} strokeWidth={1.75} />
                      <span>{t('common.sign_out')}</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Page content */}
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 min-w-0 overflow-auto p-6 focus:outline-none"
        >
          <Outlet />
        </main>
      </div>

      <ChatWidget />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        roles={user?.roles ?? []}
        domain={domain}
        isSuperAdmin={isSuperAdmin}
      />

      {/* Idle timeout warning modal */}
      {idle.warning && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="idle-warning-title"
          data-testid="idle-warning"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-6"
        >
          <div className="bg-white rounded-[16px] shadow-[0_8px_40px_rgba(0,0,0,0.12)] max-w-sm w-full p-6">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-9 h-9 rounded-full bg-amber-50 flex items-center justify-center shrink-0">
                <Clock size={18} className="text-amber-500" strokeWidth={2} />
              </div>
              <div>
                <h2 id="idle-warning-title" className="text-[15px] font-semibold text-[#111827] leading-snug">
                  {t('idle.title')}
                </h2>
                <p className="text-[13px] text-[#6B7280] mt-1">
                  {t('idle.body', { minutes: Math.round(idleMs / 60000) })}
                </p>
              </div>
            </div>
            <p className="text-[13px] text-[#111827] mb-4">
              {t('idle.countdown_prefix')}{' '}
              <span className="font-semibold tabular-nums text-[#4F46E5]" data-testid="idle-countdown">{idle.remainingSec}</span>{' '}
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
        className="w-full flex items-center justify-between gap-2 px-3 pt-3 pb-1.5 text-[10px] uppercase tracking-[0.08em] font-semibold text-[#9CA3AF] hover:text-[#6B7280] transition-colors"
      >
        <span className="flex items-center gap-2">
          <GroupIcon size={11} strokeWidth={2} />
          <span>{groupLabel}</span>
        </span>
        <ChevronDown
          size={12}
          strokeWidth={2}
          className={cn('transition-transform duration-150', isCollapsed && '-rotate-90')}
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
                    'relative flex items-center gap-2.5 rounded-[8px] px-3 py-[7px] text-[12.5px] transition-all duration-150',
                    isActive
                      ? 'bg-[#EEF2FF] text-[#4F46E5] font-medium before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[3px] before:rounded-full before:bg-[#4F46E5]'
                      : 'text-[#374151] hover:bg-[#F9FAFB] hover:text-[#111827]',
                  )
                }
              >
                <Icon size={15} strokeWidth={1.75} />
                <span>{t(`nav.${i18nKey}`)}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
