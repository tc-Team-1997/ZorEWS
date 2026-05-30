// web/src/modules/rules/RuleCenterPage.tsx
//
// Unified Rule Center landing page.
//
// Single entry-point that consolidates 4 previously-scattered rule
// surfaces (Rules Engine / Rules / EWS Rule Builder / Rule Engine
// Reports) into one navigation tree with 6 sub-sections:
//
//   1. Rule Builder        → wraps EwsRuleWizardPage (existing)
//   2. Rule Library        → wraps RulesEnginePage    (existing)
//   3. Rule Testing        → wraps RulesEnginePage simulator tab
//   4. Rule Reports        → wraps RuleReportsPage    (existing)
//   5. Rule Version History→ wraps EwsRuleBuilderPage (existing)
//   6. Rule Comparison     → wraps EwsRuleDiffPage    (existing)
//
// Zero-duplication design: every sub-route renders the existing
// component at a new URL. The OLD routes (/rules, /rules/ews,
// /rules/engine, /rules/reports, /rules/ews/wizard, /rules/ews/:id/diff)
// remain registered in App.tsx so bookmarks + tests keep working;
// the sidebar now exposes the unified /rule-center/* hierarchy.

import { Link } from 'react-router-dom';
import { Navigate } from 'react-router-dom';
import {
  Layers,
  FlaskConical,
  Library,
  FileBarChart,
  History,
  GitCompare,
  ArrowRight,
  Wand2,
} from 'lucide-react';
import { Badge, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import type { LucideIcon } from 'lucide-react';

interface RuleCenterCard {
  id:
    | 'builder'
    | 'library'
    | 'testing'
    | 'reports'
    | 'history'
    | 'comparison';
  label: string;
  description: string;
  to: string;
  /** Direct-link to the existing page when the user prefers the legacy URL. */
  legacyTo: string;
  icon: LucideIcon;
  tone: 'blue' | 'success' | 'warning' | 'neutral';
  /** Plain-English summary of which existing module backs this card. */
  reuses: string;
}

const RULE_CENTER_CARDS: readonly RuleCenterCard[] = [
  {
    id: 'builder',
    label: 'Rule Builder',
    description: '4-step visual wizard: basics → conditions → action → lifecycle. Built-in dry-run preview.',
    to: '/rule-center/builder',
    legacyTo: '/rules/ews/wizard',
    icon: Wand2,
    tone: 'blue',
    reuses: 'EwsRuleWizardPage',
  },
  {
    id: 'library',
    label: 'Rule Library',
    description: 'Browse + clone the 12-template gallery, custom tenant templates, indicators, scenarios.',
    to: '/rule-center/library',
    legacyTo: '/rules/engine',
    icon: Library,
    tone: 'success',
    reuses: 'RulesEnginePage (5-tab UI)',
  },
  {
    id: 'testing',
    label: 'Rule Testing',
    description: 'Simulate any rule against your portfolio or a single customer; FP/precision/recall report.',
    to: '/rule-center/testing',
    legacyTo: '/rules/engine?tab=simulator',
    icon: FlaskConical,
    tone: 'warning',
    reuses: 'RulesEnginePage Simulator tab',
  },
  {
    id: 'reports',
    label: 'Rule Reports',
    description: 'Fleet-wide engine summary: most-fired rules, FP rate, latency p95, drift over windows.',
    to: '/rule-center/reports',
    legacyTo: '/rules/reports',
    icon: FileBarChart,
    tone: 'blue',
    reuses: 'RuleReportsPage (Phase 9 T10)',
  },
  {
    id: 'history',
    label: 'Version History',
    description: 'Per-rule SemVer ledger with maker–checker approvals + restore-to-previous version.',
    to: '/rule-center/history',
    legacyTo: '/rules/ews',
    icon: History,
    tone: 'neutral',
    reuses: 'EwsRuleBuilderPage versions ledger',
  },
  {
    id: 'comparison',
    label: 'Rule Comparison',
    description: 'Side-by-side semantic diff between two rule versions; shareable via ?from=&to= URL.',
    to: '/rule-center/comparison',
    legacyTo: '/rules/ews',
    icon: GitCompare,
    tone: 'success',
    reuses: 'EwsRuleDiffPage',
  },
] as const;

export function RuleCenterPage() {
  const me = useAuth((s) => s.user);

  // Same role gate as the existing /rules/engine page.
  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor' || r === 'risk_analyst')) {
    return <Navigate to="/" replace />;
  }

  return (
    <div data-testid="rule-center-page">
      <PageHeader
        title="Rule Center"
        subtitle="Unified surface for building, testing, browsing, and reporting on every EWS rule."
      />

      <Panel className="mb-4">
        <div className="flex items-center gap-3 text-sm text-ink">
          <Layers size={18} className="text-action shrink-0" />
          <div>
            <div className="font-medium">One place for the entire rule lifecycle.</div>
            <p className="text-muted text-xs mt-0.5">
              Every existing rule URL still works. This page collapses 4 scattered modules
              (Rules Engine / Rules / EWS Builder / Rule Reports) into a single sidebar entry
              with 6 focused sub-sections.
            </p>
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {RULE_CENTER_CARDS.map((card) => {
          const Icon = card.icon;
          return (
            <Link
              key={card.id}
              to={card.to}
              className="block group"
              data-testid={`rule-center-card-${card.id}`}
            >
              <Panel className="hover:border-action transition-colors h-full">
                <div className="flex items-start gap-3">
                  <div className="h-10 w-10 shrink-0 rounded-md bg-aurora-tint flex items-center justify-center">
                    <Icon size={18} className="text-aurora-indigo" />
                  </div>
                  <div className="flex-1">
                    <h3 className="font-display text-[15px] font-semibold text-ink flex items-center gap-2">
                      {card.label}
                      <ArrowRight size={14} className="opacity-0 group-hover:opacity-100 transition-opacity text-action" />
                    </h3>
                    <p className="text-[11.5px] text-muted mt-0.5 leading-snug">
                      {card.description}
                    </p>
                    <div className="mt-2 flex items-center gap-2 text-[11px]">
                      <Badge tone={card.tone}>reuses {card.reuses}</Badge>
                    </div>
                  </div>
                </div>
              </Panel>
            </Link>
          );
        })}
      </div>

      <Panel className="mt-4" title="Backwards compatibility">
        <p className="caption">
          Every legacy URL still resolves to the same page — the unified Rule
          Center is purely additive navigation. If you have a bookmark to
          {' '}<code>/rules/ews</code>, <code>/rules/engine</code>, <code>/rules/reports</code>, or
          {' '}<code>/rules</code>, nothing changes for you.
        </p>
        <ul className="caption mt-2 space-y-0.5" data-testid="rule-center-legacy-links">
          {RULE_CENTER_CARDS.map((card) => (
            <li key={card.id} className="text-xs">
              <span className="text-ink font-medium">{card.label}</span>:{' '}
              <Link to={card.to} className="text-action underline-offset-2 hover:underline">
                {card.to}
              </Link>
              {card.to !== card.legacyTo && (
                <>
                  {' '}↔{' '}
                  <Link to={card.legacyTo} className="text-muted underline-offset-2 hover:underline">
                    {card.legacyTo}
                  </Link>
                </>
              )}
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

export { RULE_CENTER_CARDS };
