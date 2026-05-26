import { useEffect, useRef } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  LayoutDashboard,
  Bell,
  Users,
  UsersRound,
  SlidersHorizontal,
  Briefcase,
  FlaskConical,
  FileBarChart,
  Plug,
  ShieldCheck,
  Shield,
  LogOut,
  Clock,
  Smartphone,
  ScrollText,
  History,
  Webhook,
  Building2,
  Key,
  Mail,
  ArrowUpFromLine,
  Zap,
  Send,
  PlayCircle,
  Trash2,
  BarChart3,
  Database,
  Gauge,
  BrainCircuit,
  TrendingUp,
  Activity,
  Sigma,
  ShieldAlert,
  GitBranch,
  Bot,
  Boxes,
  Microscope,
  Library,
  Cog,
} from 'lucide-react';
import { useAuth } from '@/store/auth';
import { cn } from '@/lib/cn';
import { ChatWidget } from '@/components/copilot/ChatWidget';
import { NotificationBell } from '@/components/notifications/NotificationBell';
import { LanguageToggle } from '@/components/layout/LanguageToggle';
import { ModeToggle } from '@/components/layout/ModeToggle';
import { useIdleTimeout } from '@/lib/useIdleTimeout';
import { Button } from '@/components/ui';

interface NavItem {
  to: string;
  /** Translation key under the `nav.*` namespace. */
  i18nKey: string;
  icon: typeof LayoutDashboard;
  /** When set, only users whose roles include one of these see the entry. */
  requireRole?: ReadonlyArray<string>;
}

const NAV: readonly NavItem[] = [
  { to: '/', i18nKey: 'dashboard', icon: LayoutDashboard },
  { to: '/alerts', i18nKey: 'alerts', icon: Bell },
  { to: '/customers', i18nKey: 'customers', icon: Users },
  { to: '/borrower-watch', i18nKey: 'borrower_watch', icon: TrendingUp },
  { to: '/account-behaviour', i18nKey: 'account_behaviour', icon: Activity },
  { to: '/financial-ratios', i18nKey: 'financial_ratios', icon: Sigma },
  { to: '/fraud-signals', i18nKey: 'fraud_signals', icon: ShieldAlert },
  { to: '/rules', i18nKey: 'rules', icon: SlidersHorizontal },
  { to: '/rules/ews', i18nKey: 'ews_rules', icon: SlidersHorizontal },
  { to: '/cms/cases', i18nKey: 'cms_cases', icon: Briefcase },
  { to: '/cms/workflow', i18nKey: 'case_workflow', icon: GitBranch, requireRole: ['admin', 'supervisor', 'risk_analyst', 'case_owner'] },
  { to: '/ai/workbench', i18nKey: 'ai_workbench', icon: Bot, requireRole: ['admin', 'supervisor', 'risk_analyst'] },
  { to: '/ai/registry', i18nKey: 'model_registry', icon: Boxes, requireRole: ['admin', 'supervisor', 'risk_analyst'] },
  { to: '/ai/explainability', i18nKey: 'explainability', icon: Microscope, requireRole: ['admin', 'supervisor', 'risk_analyst', 'collection_officer', 'field_officer'] },
  { to: '/admin/master-setup', i18nKey: 'master_setup', icon: Library, requireRole: ['admin'] },
  { to: '/rules/engine', i18nKey: 'rules_engine', icon: Cog, requireRole: ['admin', 'supervisor', 'risk_analyst'] },
  { to: '/banking/npa-prediction', i18nKey: 'npa_prediction', icon: BrainCircuit, requireRole: ['admin', 'supervisor', 'risk_analyst'] },
  { to: '/banking/sma', i18nKey: 'sma_classification', icon: TrendingUp, requireRole: ['admin', 'supervisor', 'risk_analyst'] },
  { to: '/banking/sectors', i18nKey: 'sector_watch', icon: BarChart3, requireRole: ['admin', 'supervisor', 'risk_analyst'] },
  { to: '/scenario', i18nKey: 'scenario', icon: FlaskConical },
  { to: '/reports', i18nKey: 'reports', icon: FileBarChart },
  { to: '/reports/builder', i18nKey: 'report_builder', icon: FileBarChart, requireRole: ['admin', 'supervisor', 'risk_analyst'] },
  { to: '/analytics', i18nKey: 'analytics', icon: FileBarChart, requireRole: ['admin', 'supervisor', 'risk_analyst'] },
  { to: '/admin/feature-store', i18nKey: 'feature_store', icon: Database, requireRole: ['admin', 'supervisor', 'risk_analyst'] },
  { to: '/admin/streaming-latency', i18nKey: 'streaming_latency', icon: Gauge, requireRole: ['admin', 'supervisor'] },
  { to: '/profile/sessions', i18nKey: 'my_sessions', icon: Smartphone },
  { to: '/profile/activity', i18nKey: 'my_activity', icon: History },
  { to: '/admin/users', i18nKey: 'users', icon: UsersRound, requireRole: ['admin'] },
  { to: '/admin/integrations', i18nKey: 'integrations', icon: Plug, requireRole: ['admin', 'supervisor'] },
  { to: '/admin/audit-log', i18nKey: 'audit_log', icon: ScrollText, requireRole: ['admin', 'supervisor'] },
  { to: '/admin/audit-trail', i18nKey: 'audit_trail', icon: Shield, requireRole: ['admin', 'supervisor'] },
  { to: '/admin/ingestion', i18nKey: 'data_ingestion', icon: Database, requireRole: ['admin', 'supervisor'] },
  { to: '/admin/data-profiling', i18nKey: 'data_profiling', icon: BrainCircuit, requireRole: ['admin', 'supervisor'] },
  { to: '/admin/anomalies', i18nKey: 'anomaly_detection', icon: Activity, requireRole: ['admin', 'supervisor'] },
  { to: '/admin/reconciliation', i18nKey: 'reconciliation', icon: Database, requireRole: ['admin', 'supervisor'] },
  { to: '/admin/dq-score', i18nKey: 'dq_score', icon: Gauge, requireRole: ['admin', 'supervisor'] },
  { to: '/admin/activity', i18nKey: 'admin_activity', icon: ScrollText, requireRole: ['admin', 'supervisor'] },
  { to: '/admin/webhooks', i18nKey: 'webhooks', icon: Webhook, requireRole: ['admin'] },
  { to: '/admin/tenants', i18nKey: 'tenants', icon: Building2, requireRole: ['admin'] },
  { to: '/admin/service-clients', i18nKey: 'service_clients', icon: Key, requireRole: ['admin'] },
  { to: '/admin/user-access-override', i18nKey: 'user_access_override', icon: ShieldCheck, requireRole: ['admin', 'supervisor'] },
  { to: '/admin/sla-config', i18nKey: 'sla_config', icon: Clock, requireRole: ['admin', 'supervisor'] },
  { to: '/admin/notification-templates', i18nKey: 'notification_templates', icon: Mail, requireRole: ['admin', 'supervisor'] },
  { to: '/admin/notification-dispatches', i18nKey: 'notification_dispatches', icon: Send, requireRole: ['admin', 'supervisor'] },
  { to: '/admin/escalation-matrix', i18nKey: 'escalation_matrix', icon: ArrowUpFromLine, requireRole: ['admin', 'supervisor'] },
  { to: '/admin/escalation-worker', i18nKey: 'escalation_worker', icon: PlayCircle, requireRole: ['admin', 'supervisor'] },
  { to: '/admin/case-scenarios', i18nKey: 'case_scenarios', icon: Zap, requireRole: ['admin', 'supervisor'] },
  { to: '/admin/recycle-bin', i18nKey: 'recycle_bin', icon: Trash2, requireRole: ['admin'] },
  { to: '/admin/recovery-analytics', i18nKey: 'recovery_analytics', icon: BarChart3, requireRole: ['admin'] },
] as const;

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

  return (
    <div className="min-h-screen flex bg-page">
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
      {/* Sidebar */}
      <aside className="w-60 shrink-0 bg-sidebar text-sidebar-text flex flex-col">
        <div className="px-5 py-5 flex items-center gap-2.5 border-b border-white/10">
          <div className="w-9 h-9 bg-brand-blue rounded-lg flex items-center justify-center shadow-lg shadow-brand-blue/30">
            <ShieldCheck size={16} className="text-white" strokeWidth={2.25} />
          </div>
          <div>
            <p className="text-white text-[13px] font-semibold leading-tight">ZorEWS</p>
            <p className="text-white/60 text-[10px] leading-tight">Early Warning System</p>
          </div>
        </div>

        <nav className="flex-1 py-3" aria-label="Primary">
          <ul className="space-y-0.5 px-2">
            {NAV.filter(
              (item) =>
                !item.requireRole ||
                item.requireRole.some((r) => user?.roles.includes(r as never)),
            ).map(({ to, i18nKey, icon: Icon }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end={to === '/'}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-2.5 rounded-input px-3 py-2 text-[13px] transition-colors',
                      isActive
                        ? 'bg-sidebar-hover text-white'
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
        </nav>

        <div className="px-3 py-3 border-t border-white/10">
          <div className="px-2 pb-2">
            <p className="text-white text-xs font-medium leading-tight">{user?.username ?? '—'}</p>
            <p className="text-white/50 text-[10px] leading-tight">
              {user?.roles.join(', ') ?? 'guest'}
            </p>
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
        <header className="h-12 bg-surface border-b border-divider flex items-center justify-between px-6">
          <div className="text-xs text-muted">
            <span className="module-label">{t('nav.risk_operations')}</span>
          </div>
          <div className="flex items-center gap-3">
            <ModeToggle />
            <LanguageToggle />
            <NotificationBell />
            <span className="text-xs text-muted">
              {t('nav.tenant')} · <span className="text-ink-sub">apex-prototype</span>
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
