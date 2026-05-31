// web/src/modules/demoReadiness/DemoReadinessCenterPage.tsx
//
// Demo Readiness & UAT Validation Center — landing page (16th IA overlay).
//
// Additive — every existing module untouched. Gated to admin / supervisor /
// risk_analyst at the sidebar; page-level gate covers 16 personas via
// canAccessDemoReadinessCenter.
//
// Composes 5 deterministic validator engines:
//   - readinessEngine.ts          overall scoring + UAT coverage rollup
//   - flowAndRoleValidator.ts     banking + insurance flow + 9-persona × 5-axis access
//   - dashboardAndDataValidator.ts dashboard QA + data quality
//   - alertCaseComplianceValidator.ts alert + investigation + compliance validations
//   - securityAndReleaseReporter.ts security posture + release readiness report
//
// 10 sections rendered, each behind a data-testid="drc-section-<name>".

import { useMemo, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  Activity, AlertTriangle, Award, BookOpenCheck, CheckCircle2,
  ClipboardCheck, ClipboardList, Crown, Database, FileBarChart, FileCheck,
  GitBranch, KeyRound, LineChart, ListChecks, Lock, LucideIcon, Network,
  PackageCheck, Radar, Rocket, ShieldAlert, ShieldCheck, Sparkles, Target,
  TrendingDown, TrendingUp, Users, XCircle,
} from 'lucide-react';
import {
  Cell, Pie, PieChart, ResponsiveContainer, Tooltip,
} from 'recharts';
import { Badge, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import {
  READINESS_DIMENSIONS,
  buildOverallReadiness, canAccessDemoReadinessCenter,
  listUatScenarioCoverage, summarizeUatCoverage,
  type ReadinessStatus,
} from './readinessEngine';
import {
  summarizeFlowAndRoles, validateFlows, validateRoleAccess,
} from './flowAndRoleValidator';
import {
  summarizeDashboardAndData, validateDashboards, validateDataQuality,
} from './dashboardAndDataValidator';
import {
  summarizeAlertCaseCompliance, validateAlerts, validateCompliance,
  validateInvestigations,
} from './alertCaseComplianceValidator';
import {
  buildReleaseReadinessReport, summarizeSecurityAndRelease, validateSecurity,
} from './securityAndReleaseReporter';

const ACTIVE_TENANT = 'BANK_DEMO';

const STATUS_TONE: Record<ReadinessStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  critical: 'danger',
  at_risk: 'warning',
  ready: 'success',
  production_ready: 'success',
};

const STATUS_COLOR: Record<string, string> = {
  passed: '#10B981',
  warning: '#F59E0B',
  failed: '#EF4444',
};

function titleWithIcon(label: string, icon: LucideIcon, sub?: string): ReactNode {
  const Icon = icon;
  return (
    <span className="flex items-center gap-2">
      <Icon className="size-4 text-violet-400" aria-hidden />
      <span>{label}</span>
      {sub && <span className="text-xs font-normal text-slate-400 ml-2">{sub}</span>}
    </span>
  );
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-IN');
}

function fmtPct(n: number): string {
  return `${Math.round(n)}%`;
}

function scoreTone(score: number): 'success' | 'warning' | 'danger' | 'neutral' {
  if (score >= 90) return 'success';
  if (score >= 70) return 'success';
  if (score >= 50) return 'warning';
  return 'danger';
}

// ───────────────────────────────────────────────────────────────────────────
// Page
// ───────────────────────────────────────────────────────────────────────────

export function DemoReadinessCenterPage() {
  const user = useAuth((s) => s.user);
  if (user && !canAccessDemoReadinessCenter(user.roles)) {
    return <Navigate to="/" replace />;
  }

  const asOf = useMemo(() => new Date(), []);

  // Run validators FIRST so we can feed real numbers into the overall scorer.
  const flowSummary = useMemo(() => summarizeFlowAndRoles(ACTIVE_TENANT, asOf), [asOf]);
  const flowReport = useMemo(() => validateFlows(ACTIVE_TENANT, asOf), [asOf]);
  const roleReport = useMemo(() => validateRoleAccess(ACTIVE_TENANT, asOf), [asOf]);

  const dashDataSummary = useMemo(() => summarizeDashboardAndData(ACTIVE_TENANT, asOf), [asOf]);
  const dashReport = useMemo(() => validateDashboards(ACTIVE_TENANT, asOf), [asOf]);
  const dqReport = useMemo(() => validateDataQuality(ACTIVE_TENANT, asOf), [asOf]);

  const opsSummary = useMemo(() => summarizeAlertCaseCompliance(ACTIVE_TENANT, asOf), [asOf]);
  const alertReport = useMemo(() => validateAlerts(ACTIVE_TENANT, asOf), [asOf]);
  const investReport = useMemo(() => validateInvestigations(ACTIVE_TENANT, asOf), [asOf]);
  const complianceReport = useMemo(() => validateCompliance(ACTIVE_TENANT, asOf), [asOf]);

  const securityReport = useMemo(() => validateSecurity(ACTIVE_TENANT, asOf), [asOf]);

  const uatRollup = useMemo(() => summarizeUatCoverage(ACTIVE_TENANT, asOf), [asOf]);
  const uatScenarios = useMemo(() => listUatScenarioCoverage(ACTIVE_TENANT, asOf), [asOf]);

  // Compose dimension inputs for the readiness engine
  const dimensionInputs = useMemo(
    () => ({
      functional: {
        score: flowSummary.combined_functional_score,
        passed: flowReport.passed_count + roleReport.passed_count,
        failed: flowReport.failed_count + roleReport.failed_count,
        warning: flowReport.warning_count + roleReport.warning_count,
      },
      data: {
        score: Math.round((dqReport.data_health_score + dqReport.data_quality_score) / 2),
        passed: dqReport.total_checks - (dqReport.null_count + dqReport.missing_reference_count + dqReport.orphan_count + dqReport.duplicate_count + dqReport.invalid_relationship_count),
        failed: dqReport.invalid_relationship_count + dqReport.orphan_count,
        warning: dqReport.null_count + dqReport.duplicate_count + dqReport.missing_reference_count,
      },
      security: {
        score: securityReport.security_readiness_score,
        passed: securityReport.passed_count,
        failed: securityReport.failed_count,
        warning: securityReport.warning_count,
      },
      compliance: {
        score: complianceReport.compliance_readiness_score,
        passed: complianceReport.passed_count,
        failed: complianceReport.failed_count,
        warning: complianceReport.warning_count,
      },
      integration: {
        score: dashDataSummary.integration_score,
        passed: dashReport.passed_count,
        failed: dashReport.failed_count,
        warning: dashReport.warning_count,
      },
      uat_coverage: {
        score: uatRollup.coverage_pct,
        passed: uatRollup.passed,
        failed: uatRollup.failed,
        warning: uatRollup.warning,
      },
      release: {
        score: Math.round((opsSummary.alert_health_score + opsSummary.investigation_quality_score) / 2),
        passed: alertReport.passed_count + investReport.passed_count,
        failed: alertReport.failed_count + investReport.failed_count,
        warning: alertReport.warning_count + investReport.warning_count,
      },
    }),
    [flowSummary, flowReport, roleReport, dqReport, securityReport, complianceReport, dashDataSummary, dashReport, uatRollup, opsSummary, alertReport, investReport],
  );

  const overall = useMemo(
    () => buildOverallReadiness(ACTIVE_TENANT, asOf, dimensionInputs),
    [asOf, dimensionInputs],
  );

  const releaseInputs = useMemo(
    () => ({
      functional_score: dimensionInputs.functional.score,
      data_score: dimensionInputs.data.score,
      security_score: dimensionInputs.security.score,
      compliance_score: dimensionInputs.compliance.score,
      integration_score: dimensionInputs.integration.score,
      uat_coverage_score: dimensionInputs.uat_coverage.score,
      release_score: dimensionInputs.release.score,
    }),
    [dimensionInputs],
  );

  const releaseReport = useMemo(
    () => buildReleaseReadinessReport(ACTIVE_TENANT, asOf, releaseInputs),
    [asOf, releaseInputs],
  );

  const secSummary = useMemo(() => summarizeSecurityAndRelease(ACTIVE_TENANT, asOf), [asOf]);

  // Chart data
  const uatPie = useMemo(
    () => [
      { name: 'passed', value: uatRollup.passed },
      { name: 'warning', value: uatRollup.warning },
      { name: 'failed', value: uatRollup.failed },
    ],
    [uatRollup],
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Demo Readiness & UAT Validation"
        subtitle="Real-time readiness scoring across functional / data / security / compliance / integration / UAT-coverage / release dimensions. Drives demo-day and UAT sign-off."
        actions={
          <div className="flex items-center gap-2">
            <Badge tone="warning"><ClipboardCheck className="size-3 mr-1 inline" />Readiness</Badge>
            <Badge tone="neutral">Tenant: {ACTIVE_TENANT}</Badge>
            <Badge tone={STATUS_TONE[overall.overall_status]}>
              {fmtPct(overall.overall_score)} · {overall.overall_status.replace('_', ' ')}
            </Badge>
            <Badge tone={releaseReport.release_status === 'production_ready' ? 'success' : releaseReport.release_status === 'demo_ready' ? 'success' : releaseReport.release_status === 'uat_ready' ? 'warning' : 'danger'}>
              {releaseReport.release_status.replace('_', ' ')}
            </Badge>
          </div>
        }
      />

      {/* 1. Demo Readiness Center — Overall + 7 dimensions */}
      <Panel
        title={titleWithIcon('Overall readiness', Award, `${fmtPct(overall.overall_score)} composite · ${fmtInt(overall.total_checks)} checks · ${fmtInt(overall.critical_issues_count)} critical · ${fmtInt(overall.warnings_count)} warnings`)}
        data-testid="drc-section-overall"
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-2 mb-3">
          {overall.dimensions.map((d) => (
            <div
              key={d.dimension}
              data-testid={`drc-dim-${d.dimension}`}
              className="rounded-xl border border-slate-700 bg-slate-900/40 p-3"
            >
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-mono">{d.dimension.replace('_', ' ')}</div>
              <div className={`text-2xl font-bold tabular-nums ${
                d.score >= 80 ? 'text-emerald-300' : d.score >= 60 ? 'text-amber-300' : 'text-red-300'
              }`}>
                {fmtPct(d.score)}
              </div>
              <div className="text-[10px] text-slate-500">
                ✓ {d.checks_passed} · ⚠ {d.checks_warning} · ✕ {d.checks_failed}
              </div>
              <div className="mt-1"><Badge tone={STATUS_TONE[d.status]}>{d.status.replace('_', ' ')}</Badge></div>
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-slate-700/60 bg-slate-900/30 p-3">
          <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Recommended next steps</div>
          <ul className="text-xs space-y-1.5">
            {overall.recommended_next_steps.length === 0 ? (
              <li className="text-emerald-300">All dimensions look healthy.</li>
            ) : (
              overall.recommended_next_steps.map((rec, i) => (
                <li key={i} data-testid={`drc-rec-${i}`} className="text-slate-300 flex items-start gap-2">
                  <span className="text-violet-400 mt-0.5">→</span>
                  <span>{rec}</span>
                </li>
              ))
            )}
          </ul>
        </div>
      </Panel>

      {/* 2. Flow validation */}
      <Panel
        title={titleWithIcon('Flow validation', GitBranch, `${fmtInt(flowReport.total_checks)} checks · ${fmtInt(flowReport.orphan_records_count)} orphans · ${fmtInt(flowReport.broken_flows_count)} broken flows · ${fmtInt(flowReport.missing_links_count)} missing links · health ${fmtPct(flowReport.flow_health_score)}`)}
        data-testid="drc-section-flows"
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
          <MetricCard label="Total flow checks" value={fmtInt(flowReport.total_checks)} testId="drc-kpi-flow-total" />
          <MetricCard label="Passed" value={fmtInt(flowReport.passed_count)} tone="success" testId="drc-kpi-flow-passed" />
          <MetricCard label="Warnings" value={fmtInt(flowReport.warning_count)} tone="warning" testId="drc-kpi-flow-warning" />
          <MetricCard label="Failed" value={fmtInt(flowReport.failed_count)} tone={flowReport.failed_count > 0 ? 'danger' : 'success'} testId="drc-kpi-flow-failed" />
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Banking flow (borrower → alert → investigation → action → resolution)</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
                  <tr>
                    <th className="text-left py-1.5 px-2">Stage</th>
                    <th className="text-left py-1.5 px-2">Subject</th>
                    <th className="text-left py-1.5 px-2">Outcome</th>
                    <th className="text-left py-1.5 px-2">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {flowReport.banking_flow_checks.slice(0, 10).map((c) => (
                    <tr key={c.check_id} data-testid={`flow-banking-${c.check_id}`} className="border-b border-slate-900/50">
                      <td className="py-1 px-2 text-slate-400 capitalize text-xs">{c.stage}</td>
                      <td className="py-1 px-2 font-mono text-[10px] text-slate-300">{c.subject_id}</td>
                      <td className="py-1 px-2"><Badge tone={c.outcome === 'passed' ? 'success' : c.outcome === 'warning' ? 'warning' : 'danger'}>{c.outcome}</Badge></td>
                      <td className="py-1 px-2 text-slate-500 text-[11px]">{c.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Insurance flow (policy → risk detection → investigation → resolution)</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
                  <tr>
                    <th className="text-left py-1.5 px-2">Stage</th>
                    <th className="text-left py-1.5 px-2">Subject</th>
                    <th className="text-left py-1.5 px-2">Outcome</th>
                    <th className="text-left py-1.5 px-2">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {flowReport.insurance_flow_checks.slice(0, 10).map((c) => (
                    <tr key={c.check_id} data-testid={`flow-insurance-${c.check_id}`} className="border-b border-slate-900/50">
                      <td className="py-1 px-2 text-slate-400 capitalize text-xs">{c.stage.replace('_', ' ')}</td>
                      <td className="py-1 px-2 font-mono text-[10px] text-slate-300">{c.subject_id}</td>
                      <td className="py-1 px-2"><Badge tone={c.outcome === 'passed' ? 'success' : c.outcome === 'warning' ? 'warning' : 'danger'}>{c.outcome}</Badge></td>
                      <td className="py-1 px-2 text-slate-500 text-[11px]">{c.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        {flowSummary.recommendation_hints.length > 0 && (
          <div className="mt-3 rounded border border-violet-500/30 bg-violet-500/5 p-2 text-xs text-violet-200">
            <strong className="font-mono uppercase text-[10px] tracking-wider">Hints:</strong>{' '}
            {flowSummary.recommendation_hints.join(' · ')}
          </div>
        )}
      </Panel>

      {/* 3. Role validation */}
      <Panel
        title={titleWithIcon('Role validation', Users, `${fmtInt(roleReport.total_personas)} personas × 5 access axes = ${fmtInt(roleReport.total_checks)} checks · health ${fmtPct(roleReport.role_health_score)}`)}
        data-testid="drc-section-roles"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
              <tr>
                <th className="text-left py-1.5 px-2">Persona</th>
                <th className="text-left py-1.5 px-2">Menu</th>
                <th className="text-left py-1.5 px-2">Routes</th>
                <th className="text-left py-1.5 px-2">Dashboards</th>
                <th className="text-left py-1.5 px-2">Data</th>
                <th className="text-left py-1.5 px-2">Permissions</th>
                <th className="text-right py-1.5 px-2">Score</th>
                <th className="text-left py-1.5 px-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {roleReport.persona_rows.map((p) => {
                const axisMap = new Map(p.axes.map((a) => [a.axis, a]));
                const tone = (axis: string) => {
                  const row = axisMap.get(axis as never);
                  if (!row) return 'neutral' as const;
                  return row.outcome === 'passed' ? 'success' : row.outcome === 'warning' ? 'warning' : 'danger';
                };
                const text = (axis: string) => {
                  const row = axisMap.get(axis as never);
                  if (!row) return '—';
                  return `${row.granted_count}/${row.required_count}`;
                };
                return (
                  <tr key={p.persona} data-testid={`role-row-${p.persona}`} className="border-b border-slate-900/50">
                    <td className="py-1.5 px-2 text-slate-200 font-mono text-xs">{p.persona.replace('_', ' ')}</td>
                    <td className="py-1.5 px-2"><Badge tone={tone('menu_visibility')}>{text('menu_visibility')}</Badge></td>
                    <td className="py-1.5 px-2"><Badge tone={tone('route_access')}>{text('route_access')}</Badge></td>
                    <td className="py-1.5 px-2"><Badge tone={tone('dashboard_access')}>{text('dashboard_access')}</Badge></td>
                    <td className="py-1.5 px-2"><Badge tone={tone('data_access')}>{text('data_access')}</Badge></td>
                    <td className="py-1.5 px-2"><Badge tone={tone('permission_alignment')}>{text('permission_alignment')}</Badge></td>
                    <td className="py-1.5 px-2 text-right text-slate-300 tabular-nums">{fmtPct(p.persona_score)}</td>
                    <td className="py-1.5 px-2"><Badge tone={STATUS_TONE[p.persona_status]}>{p.persona_status.replace('_', ' ')}</Badge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* 4. Dashboard validation */}
      <Panel
        title={titleWithIcon('Dashboard validation', FileBarChart, `${fmtInt(dashReport.total_dashboards_scanned)} dashboards · ${fmtInt(dashReport.total_widgets_scanned)} widgets · ${fmtInt(dashReport.total_checks)} checks · quality ${fmtPct(dashReport.overall_dashboard_quality_score)}`)}
        data-testid="drc-section-dashboards"
      >
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 mb-3 text-xs">
          {Object.entries(dashReport.by_kind).map(([kind, count]) => (
            <div key={kind} data-testid={`drc-dash-kind-${kind}`} className="rounded border border-slate-700 bg-slate-900/30 p-2 text-center">
              <div className="text-slate-500 uppercase tracking-wider font-mono text-[10px]">{kind.replace('_', ' ')}</div>
              <div className={`text-xl font-bold tabular-nums ${count > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>{fmtInt(count)}</div>
            </div>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
              <tr>
                <th className="text-left py-1.5 px-2">Dashboard</th>
                <th className="text-right py-1.5 px-2">Passed</th>
                <th className="text-right py-1.5 px-2">Warning</th>
                <th className="text-right py-1.5 px-2">Failed</th>
                <th className="text-right py-1.5 px-2">Quality</th>
              </tr>
            </thead>
            <tbody>
              {dashReport.dashboards.slice(0, 14).map((d) => (
                <tr key={d.dashboard_id} data-testid={`drc-dashboard-${d.dashboard_id}`} className="border-b border-slate-900/50">
                  <td className="py-1 px-2 text-slate-200 text-xs">{d.dashboard_name}</td>
                  <td className="py-1 px-2 text-right text-emerald-300 tabular-nums">{d.checks_passed}</td>
                  <td className="py-1 px-2 text-right text-amber-300 tabular-nums">{d.checks_warning}</td>
                  <td className="py-1 px-2 text-right text-red-300 tabular-nums">{d.checks_failed}</td>
                  <td className="py-1 px-2 text-right">
                    <Badge tone={scoreTone(d.quality_score)}>{fmtPct(d.quality_score)}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* 5. Data quality */}
      <Panel
        title={titleWithIcon('Data quality validation', Database, `${fmtInt(dqReport.total_entities_scanned)} entities scanned · health ${fmtPct(dqReport.data_health_score)} · quality ${fmtPct(dqReport.data_quality_score)}`)}
        data-testid="drc-section-data-quality"
      >
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 mb-3 text-xs">
          <div data-testid="drc-dq-null" className="rounded border border-slate-700 bg-slate-900/30 p-2 text-center">
            <div className="text-slate-500 uppercase tracking-wider font-mono text-[10px]">null values</div>
            <div className={`text-xl font-bold tabular-nums ${dqReport.null_count > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>{fmtInt(dqReport.null_count)}</div>
          </div>
          <div data-testid="drc-dq-missing-ref" className="rounded border border-slate-700 bg-slate-900/30 p-2 text-center">
            <div className="text-slate-500 uppercase tracking-wider font-mono text-[10px]">missing refs</div>
            <div className={`text-xl font-bold tabular-nums ${dqReport.missing_reference_count > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>{fmtInt(dqReport.missing_reference_count)}</div>
          </div>
          <div data-testid="drc-dq-orphan" className="rounded border border-slate-700 bg-slate-900/30 p-2 text-center">
            <div className="text-slate-500 uppercase tracking-wider font-mono text-[10px]">orphans</div>
            <div className={`text-xl font-bold tabular-nums ${dqReport.orphan_count > 0 ? 'text-red-300' : 'text-emerald-300'}`}>{fmtInt(dqReport.orphan_count)}</div>
          </div>
          <div data-testid="drc-dq-duplicate" className="rounded border border-slate-700 bg-slate-900/30 p-2 text-center">
            <div className="text-slate-500 uppercase tracking-wider font-mono text-[10px]">duplicates</div>
            <div className={`text-xl font-bold tabular-nums ${dqReport.duplicate_count > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>{fmtInt(dqReport.duplicate_count)}</div>
          </div>
          <div data-testid="drc-dq-invalid-rel" className="rounded border border-slate-700 bg-slate-900/30 p-2 text-center">
            <div className="text-slate-500 uppercase tracking-wider font-mono text-[10px]">invalid rels</div>
            <div className={`text-xl font-bold tabular-nums ${dqReport.invalid_relationship_count > 0 ? 'text-red-300' : 'text-emerald-300'}`}>{fmtInt(dqReport.invalid_relationship_count)}</div>
          </div>
        </div>
        <div className="text-xs text-slate-500">
          Top issues across dashboard + data quality checks ({dashDataSummary.top_issues.length}):{' '}
          {dashDataSummary.top_issues.slice(0, 5).map((i) => (
            <span key={i.kind} className="font-mono ml-1">
              <Badge tone="warning">{i.kind}</Badge> {i.count}
            </span>
          ))}
        </div>
      </Panel>

      {/* 6. Alert validation */}
      <Panel
        title={titleWithIcon('Alert validation', ShieldAlert, `${fmtInt(alertReport.total_alerts_scanned)} alerts scanned · banking ${fmtInt(alertReport.banking_alerts_scanned)} · insurance ${fmtInt(alertReport.insurance_alerts_scanned)} · health ${fmtPct(alertReport.alert_health_score)}`)}
        data-testid="drc-section-alert-validation"
      >
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 mb-3 text-xs">
          {Object.entries(alertReport.by_kind).map(([kind, count]) => (
            <div key={kind} data-testid={`drc-alert-kind-${kind}`} className="rounded border border-slate-700 bg-slate-900/30 p-2 text-center">
              <div className="text-slate-500 uppercase tracking-wider font-mono text-[10px]">{kind.replace(/_/g, ' ')}</div>
              <div className={`text-xl font-bold tabular-nums ${count > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>{fmtInt(count)}</div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
          {Object.entries(alertReport.severity_distribution).map(([sev, count]) => (
            <div key={sev} data-testid={`drc-alert-sev-${sev}`} className="rounded border border-slate-700 bg-slate-900/30 p-2 text-center">
              <div className="text-slate-500 uppercase tracking-wider font-mono text-[10px]">{sev}</div>
              <div className="text-xl font-bold text-white tabular-nums">{fmtInt(count)}</div>
            </div>
          ))}
        </div>
      </Panel>

      {/* 7. Investigation validation */}
      <Panel
        title={titleWithIcon('Investigation validation', ClipboardList, `${fmtInt(investReport.total_cases_scanned)} cases · open ${fmtInt(investReport.open_count)} · escalated ${fmtInt(investReport.escalated_count)} · closed ${fmtInt(investReport.closed_count)} · quality ${fmtPct(investReport.investigation_quality_score)}`)}
        data-testid="drc-section-investigation-validation"
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
          <MetricCard label="Evidence integrity" value={fmtPct(investReport.evidence_integrity_score)} tone={scoreTone(investReport.evidence_integrity_score)} testId="drc-kpi-evidence" />
          <MetricCard label="Timeline completeness" value={fmtPct(investReport.timeline_completeness_score)} tone={scoreTone(investReport.timeline_completeness_score)} testId="drc-kpi-timeline" />
          <MetricCard label="Investigation quality" value={fmtPct(investReport.investigation_quality_score)} tone={scoreTone(investReport.investigation_quality_score)} testId="drc-kpi-investigation-quality" />
          <MetricCard label="Total checks" value={fmtInt(investReport.total_checks)} testId="drc-kpi-investigation-checks" />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 text-xs">
          {Object.entries(investReport.by_kind).map(([kind, count]) => (
            <div key={kind} data-testid={`drc-invest-kind-${kind}`} className="rounded border border-slate-700 bg-slate-900/30 p-2 text-center">
              <div className="text-slate-500 uppercase tracking-wider font-mono text-[10px]">{kind.replace(/_/g, ' ')}</div>
              <div className={`text-xl font-bold tabular-nums ${count > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>{fmtInt(count)}</div>
            </div>
          ))}
        </div>
      </Panel>

      {/* 8. Compliance validation */}
      <Panel
        title={titleWithIcon('Compliance validation', Lock, `${fmtInt(complianceReport.total_obligations_scanned)} obligations · ${fmtInt(complianceReport.total_findings_scanned)} findings · regulatory coverage ${fmtPct(complianceReport.regulatory_coverage_pct)} · readiness ${fmtPct(complianceReport.compliance_readiness_score)}`)}
        data-testid="drc-section-compliance-validation"
      >
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 mb-3 text-xs">
          {Object.entries(complianceReport.by_kind).map(([kind, count]) => (
            <div key={kind} data-testid={`drc-compliance-kind-${kind}`} className="rounded border border-slate-700 bg-slate-900/30 p-2 text-center">
              <div className="text-slate-500 uppercase tracking-wider font-mono text-[10px]">{kind.replace(/_/g, ' ')}</div>
              <div className={`text-xl font-bold tabular-nums ${count > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>{fmtInt(count)}</div>
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-slate-700/60 bg-slate-900/30 p-3">
          <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">By framework</div>
          <div className="flex flex-wrap gap-1.5 text-xs">
            {Object.entries(complianceReport.by_framework).map(([fw, count]) => (
              <span key={fw} data-testid={`drc-compliance-fw-${fw}`} className="rounded border border-slate-700 bg-slate-900/30 px-2 py-1">
                <span className="text-slate-500 uppercase font-mono">{fw}</span>{' '}
                <span className="text-slate-200 font-bold tabular-nums">{fmtInt(count)}</span>
              </span>
            ))}
          </div>
        </div>
      </Panel>

      {/* 9. Security validation */}
      <Panel
        title={titleWithIcon('Security validation', KeyRound, `${fmtInt(securityReport.total_users_scanned)} users · ${fmtInt(securityReport.total_sessions_scanned)} sessions · ${fmtInt(securityReport.total_login_audits_30d)} login audits 30d · MFA ${fmtPct(securityReport.mfa_adoption_pct)} · readiness ${fmtPct(securityReport.security_readiness_score)}`)}
        data-testid="drc-section-security-validation"
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
          <MetricCard label="Users scanned" value={fmtInt(securityReport.total_users_scanned)} testId="drc-kpi-users" />
          <MetricCard label="Sessions" value={fmtInt(securityReport.total_sessions_scanned)} testId="drc-kpi-sessions" />
          <MetricCard label="Orphan sessions" value={fmtInt(securityReport.orphan_session_count)} tone={securityReport.orphan_session_count > 0 ? 'warning' : 'success'} testId="drc-kpi-orphan-sessions" />
          <MetricCard label="Over-privileged" value={fmtInt(securityReport.over_privileged_count)} tone={securityReport.over_privileged_count > 0 ? 'danger' : 'success'} testId="drc-kpi-over-priv" />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 text-xs">
          {Object.entries(securityReport.by_kind).map(([kind, count]) => (
            <div key={kind} data-testid={`drc-security-kind-${kind}`} className="rounded border border-slate-700 bg-slate-900/30 p-2 text-center">
              <div className="text-slate-500 uppercase tracking-wider font-mono text-[10px]">{kind.replace(/_/g, ' ')}</div>
              <div className={`text-xl font-bold tabular-nums ${count > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>{fmtInt(count)}</div>
            </div>
          ))}
        </div>
      </Panel>

      {/* 10. Release readiness + UAT coverage */}
      <Panel
        title={titleWithIcon('Release readiness + UAT coverage', Rocket, `${releaseReport.release_status.replace('_', ' ')} · ${fmtInt(releaseReport.passed_checks)}/${fmtInt(releaseReport.total_checks)} checks passed · UAT ${fmtPct(uatRollup.coverage_pct)} · ${fmtInt(releaseReport.estimated_uat_completion_days)}d to completion`)}
        data-testid="drc-section-release"
      >
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
          <div className="xl:col-span-2">
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Recommended actions ({releaseReport.recommendations.length})</div>
            <ul className="text-xs space-y-1.5">
              {releaseReport.recommendations.length === 0 ? (
                <li className="text-emerald-300">No critical actions outstanding.</li>
              ) : (
                releaseReport.recommendations.map((r, i) => (
                  <li key={i} data-testid={`drc-release-rec-${i}`} className="border-b border-slate-900/50 py-1.5">
                    <div className="flex justify-between items-center gap-2">
                      <span className="text-slate-200 font-medium">{r.title}</span>
                      <Badge tone={r.severity === 'critical' ? 'danger' : r.severity === 'error' ? 'danger' : r.severity === 'warning' ? 'warning' : 'success'}>{r.severity}</Badge>
                    </div>
                    <div className="text-slate-500 text-[11px]">{r.detail}</div>
                    <div className="text-slate-500 font-mono text-[10px]">Priority {r.priority} · Owner: {r.owner}</div>
                  </li>
                ))
              )}
            </ul>
            {releaseReport.sign_off_required_from.length > 0 && (
              <div className="mt-3 text-xs text-slate-500">
                <strong className="font-mono uppercase text-[10px] tracking-wider">Sign-off required from:</strong>{' '}
                {releaseReport.sign_off_required_from.join(' · ')}
              </div>
            )}
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">UAT scenario coverage ({uatScenarios.length})</div>
            <div className="rounded-xl border border-slate-700/60 bg-slate-900/30 p-3 mb-2">
              <div className="h-32 w-full">
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={uatPie} dataKey="value" nameKey="name" outerRadius={50} label={false}>
                      {uatPie.map((s) => (
                        <Cell key={s.name} fill={STATUS_COLOR[s.name] ?? '#94a3b8'} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(139,92,246,0.5)', color: '#fff', borderRadius: 8 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="text-[10px] text-slate-400 text-center font-mono">
                ✓ {fmtInt(uatRollup.passed)} · ⚠ {fmtInt(uatRollup.warning)} · ✕ {fmtInt(uatRollup.failed)}
              </div>
            </div>
            <ul className="text-xs space-y-1 max-h-56 overflow-y-auto">
              {uatScenarios.slice(0, 12).map((s) => (
                <li key={s.scenario_id} data-testid={`drc-uat-${s.scenario_id}`} className="border-b border-slate-900/50 py-1 flex justify-between gap-2">
                  <span className="text-slate-200 text-[11px] truncate flex-1">{s.name}</span>
                  <Badge tone={s.outcome === 'passed' ? 'success' : s.outcome === 'warning' ? 'warning' : 'danger'}>{s.outcome}</Badge>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="mt-3 text-xs text-slate-500 font-mono">
          Security: {fmtPct(secSummary.security_readiness_score)} · Release composite: {fmtPct(secSummary.release_score)} · Top recommendations: {secSummary.top_recommendations.length}
        </div>
      </Panel>

      {/* Cross-IA footer */}
      <div className="flex items-center gap-3 flex-wrap text-xs text-slate-400 pt-1">
        <span>Cross-IA:</span>
        <Link className="hover:text-violet-300 underline decoration-dotted" to="/enterprise-demo-center">Enterprise Demo</Link>
        <Link className="hover:text-violet-300 underline decoration-dotted" to="/data-fabric-center">Data Fabric</Link>
        <Link className="hover:text-violet-300 underline decoration-dotted" to="/regulatory-compliance-center">Regulatory</Link>
        <Link className="hover:text-violet-300 underline decoration-dotted" to="/investigation-center">Investigations</Link>
        <Link className="hover:text-violet-300 underline decoration-dotted" to="/predictive-risk-center">Predictive Risk</Link>
        <Link className="hover:text-violet-300 underline decoration-dotted" to="/executive-cockpit">Executive Cockpit</Link>
      </div>
    </div>
  );
}

// silence unused-import warnings (icons reserved for future expansion)
void Activity; void AlertTriangle; void BookOpenCheck; void CheckCircle2;
void Crown; void FileCheck; void LineChart; void ListChecks; void Network;
void PackageCheck; void Radar; void ShieldCheck; void Sparkles; void Target;
void TrendingDown; void TrendingUp; void XCircle; void READINESS_DIMENSIONS;
