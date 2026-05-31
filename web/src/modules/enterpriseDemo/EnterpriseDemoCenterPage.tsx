// web/src/modules/enterpriseDemo/EnterpriseDemoCenterPage.tsx
//
// Enterprise Demo Foundation — landing page.
//
// 15th IA overlay this session. Additive — every existing module untouched
// (Governance / IAM / Rule / Audit / Recovery / AI Governance / Security
// Activity / Role-Based Dashboard / Executive Cockpit / Predictive Risk /
// Investigation / Regulatory Compliance / Data Fabric). Mounted at
// /enterprise-demo-center. Gated inside the page; sidebar entry visible to
// admin / supervisor / risk_analyst.
//
// Sections rendered (10):
//   1.  Banking Portfolio Inventory   (50 branches × 10k customers × 50k accounts × 20k loans across 5 banks)
//   2.  Loan Health Distribution      (SMA / NPA / DPD bucket split + sector exposure)
//   3.  Insurance Portfolio Inventory (3 insurers × 20k customers × 5k policies × 3k claims × 500 fraud)
//   4.  Claims + Fraud Hot-list       (recent claims + fraud cases breakdown)
//   5.  Enterprise Alert Operations   (2000 alerts across 5 banking + 5 insurance kinds)
//   6.  Investigation Operations      (800 cases across 6 case types with status mix + closure breakdown)
//   7.  Executive KPIs                (banking + insurance composite KPI tiles + 30-day trends)
//   8.  Predictive Risk Forecasts     (24 forecasts across 6 kinds × 4 horizons)
//   9.  Compliance Posture            (40 obligations + 80 findings across 7 frameworks)
//  10.  Data Fabric Integration       (12 sources + 15 pipelines + AI readiness for the demo entities)
//
// Production wire-up: each engine resolver becomes a `/v1/enterprise-demo/*`
// BFF route with the same shape; page is contract-stable.

import { useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  Activity, AlertTriangle, Award, BarChart3, Briefcase, Building2,
  Clock, Coins, CreditCard, Crown, Database, DollarSign, FileText,
  Filter, FlaskConical, Gauge, Heart, Home, Layers, LineChart,
  ListChecks, Lock, LucideIcon, Network, PiggyBank, Plug, Radar,
  Shield, ShieldAlert, Sparkles, Target, TrendingDown, TrendingUp,
  Users, Wallet, Zap,
} from 'lucide-react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Badge, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import {
  BANK_CATALOG, DPD_BUCKETS, LOAN_STATUSES, LOAN_TYPES,
  listLoans, summarizeBankWise, summarizeBankingPortfolio,
  type LoanStatus,
} from './enterpriseBankingEngine';
import {
  INSURER_CATALOG, POLICY_TYPES,
  listClaims, listFraudCases, summarizeInsurancePortfolio,
  summarizeInsurerWise,
} from './enterpriseInsuranceEngine';
import {
  ALERT_SEVERITIES, BANKING_ALERT_KINDS, CASE_STATUSES,
  INSURANCE_ALERT_KINDS, listEnterpriseAlerts, listEnterpriseCases,
  summarizeAlertOps, summarizeInvestigationOps,
  type AlertSeverity,
} from './enterpriseRiskOpsEngine';
import {
  BANKING_FORECAST_KINDS, FORECAST_HORIZONS, INSURANCE_FORECAST_KINDS,
  buildBankingExecutiveKpi, buildInsuranceExecutiveKpi,
  listComplianceObligations, listEnterpriseForecasts,
  summarizeCompliancePosture, type ForecastHorizon,
} from './enterpriseAnalyticsEngine';
import {
  listDemoPipelines, listDemoReadinessScores, listDemoSources,
  summarizeDataFabricDemoIntegration,
} from './enterpriseDataFabricIntegration';

// Role gate — applied at the page entry. Sidebar already filters by role.
const ENTERPRISE_DEMO_ROLES: ReadonlyArray<string> = [
  'admin', 'supervisor', 'risk_analyst',
  'super_admin', 'country_admin', 'cdo', 'cro', 'ceo', 'cfo', 'coo',
  'data_engineer', 'data_steward', 'compliance_officer', 'auditor',
  'fraud_analyst', 'executive', 'board_member', 'country_head',
];

function canAccessEnterpriseDemoCenter(roles: readonly string[] | undefined): boolean {
  if (!roles || roles.length === 0) return false;
  return roles.some((r) => ENTERPRISE_DEMO_ROLES.includes(r));
}

const ACTIVE_TENANT = 'BANK_DEMO';

const LOAN_STATUS_TONE: Record<LoanStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  watchlist: 'warning',
  sma0: 'warning',
  sma1: 'warning',
  sma2: 'danger',
  npa: 'danger',
};

const SEVERITY_TONE: Record<AlertSeverity, 'success' | 'warning' | 'danger' | 'neutral'> = {
  low: 'neutral',
  medium: 'warning',
  high: 'danger',
  critical: 'danger',
};

function titleWithIcon(label: string, icon: LucideIcon, sub?: string): ReactNode {
  const Icon = icon;
  return (
    <span className="flex items-center gap-2">
      <Icon className="size-4 text-amber-400" aria-hidden />
      <span>{label}</span>
      {sub && <span className="text-xs font-normal text-slate-400 ml-2">{sub}</span>}
    </span>
  );
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-IN');
}

function fmtCrores(inr: number): string {
  const crores = inr / 10_000_000;
  if (crores >= 1) return `₹${crores.toFixed(1)}Cr`;
  const lakhs = inr / 100_000;
  if (lakhs >= 1) return `₹${lakhs.toFixed(1)}L`;
  return `₹${inr.toLocaleString('en-IN')}`;
}

function fmtPct(v: number): string {
  return `${Math.round(v)}%`;
}

function fmtPct01(v: number): string {
  return `${Math.round(v * 100)}%`;
}

// ───────────────────────────────────────────────────────────────────────────
// Page
// ───────────────────────────────────────────────────────────────────────────

export function EnterpriseDemoCenterPage() {
  const user = useAuth((s) => s.user);
  if (user && !canAccessEnterpriseDemoCenter(user.roles)) {
    return <Navigate to="/" replace />;
  }

  const asOf = useMemo(() => new Date(), []);

  const [forecastHorizon, setForecastHorizon] = useState<ForecastHorizon | 'all'>('all');

  // Engines
  const bankingSummary = useMemo(() => summarizeBankingPortfolio(ACTIVE_TENANT, asOf), [asOf]);
  const bankWise = useMemo(() => summarizeBankWise(ACTIVE_TENANT, asOf), [asOf]);
  const npaLoans = useMemo(() => listLoans(ACTIVE_TENANT, asOf, { status: 'npa' }, 0, 8), [asOf]);

  const insuranceSummary = useMemo(() => summarizeInsurancePortfolio(ACTIVE_TENANT, asOf), [asOf]);
  const insurerWise = useMemo(() => summarizeInsurerWise(ACTIVE_TENANT, asOf), [asOf]);
  const recentClaims = useMemo(() => listClaims(ACTIVE_TENANT, asOf, undefined, 0, 8), [asOf]);
  const fraudCases = useMemo(() => listFraudCases(ACTIVE_TENANT, asOf, 0, 6), [asOf]);

  const alertSummary = useMemo(() => summarizeAlertOps(ACTIVE_TENANT, asOf), [asOf]);
  const recentAlerts = useMemo(() => listEnterpriseAlerts(ACTIVE_TENANT, asOf, undefined, 0, 10), [asOf]);
  const caseSummary = useMemo(() => summarizeInvestigationOps(ACTIVE_TENANT, asOf), [asOf]);
  const recentCases = useMemo(() => listEnterpriseCases(ACTIVE_TENANT, asOf, undefined, 0, 8), [asOf]);

  const bankingKpi = useMemo(() => buildBankingExecutiveKpi(ACTIVE_TENANT, asOf), [asOf]);
  const insuranceKpi = useMemo(() => buildInsuranceExecutiveKpi(ACTIVE_TENANT, asOf), [asOf]);

  const allForecasts = useMemo(() => listEnterpriseForecasts(ACTIVE_TENANT, asOf), [asOf]);
  const filteredForecasts = useMemo(
    () => (forecastHorizon === 'all' ? allForecasts : allForecasts.filter((f) => f.horizon === forecastHorizon)),
    [allForecasts, forecastHorizon],
  );

  const obligations = useMemo(() => listComplianceObligations(ACTIVE_TENANT, asOf), [asOf]);
  const compliancePosture = useMemo(() => summarizeCompliancePosture(ACTIVE_TENANT, asOf), [asOf]);

  const fabricSources = useMemo(() => listDemoSources(ACTIVE_TENANT, asOf), [asOf]);
  const fabricPipelines = useMemo(() => listDemoPipelines(ACTIVE_TENANT, asOf), [asOf]);
  const fabricReadiness = useMemo(() => listDemoReadinessScores(ACTIVE_TENANT, asOf), [asOf]);
  const fabricSummary = useMemo(() => summarizeDataFabricDemoIntegration(ACTIVE_TENANT, asOf), [asOf]);

  // Chart data
  const loanTypeBars = useMemo(
    () => LOAN_TYPES.map((t) => ({ name: t, count: bankingSummary.by_loan_type[t] ?? 0 })),
    [bankingSummary],
  );
  const dpdBucketBars = useMemo(
    () => DPD_BUCKETS.map((b) => ({ name: b, count: bankingSummary.by_dpd_bucket[b] ?? 0 })),
    [bankingSummary],
  );
  const policyTypeBars = useMemo(
    () => POLICY_TYPES.map((t) => ({ name: t, count: insuranceSummary.by_policy_type[t] ?? 0 })),
    [insuranceSummary],
  );
  const alertSeverityBars = useMemo(
    () => ALERT_SEVERITIES.map((s) => ({ name: s, count: alertSummary.by_severity[s] ?? 0 })),
    [alertSummary],
  );
  const SEV_COLORS: Record<string, string> = {
    low: '#64748b', medium: '#f59e0b', high: '#ef4444', critical: '#dc2626',
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Enterprise Demo Foundation"
        subtitle="Realistic banking + insurance demo data — 10k bank customers, 20k loans, 5k policies, 3k claims, 2000 alerts, 800 cases, 24 forecasts, 40 obligations — fully populated, deterministic, no empty grids."
        actions={
          <div className="flex items-center gap-2">
            <Badge tone="warning"><Sparkles className="size-3 mr-1 inline" />Demo Foundation</Badge>
            <Badge tone="neutral">Tenant: {ACTIVE_TENANT}</Badge>
            <Badge tone="success">{fmtInt(bankingSummary.total_loans + insuranceSummary.total_policies)} financial instruments</Badge>
          </div>
        }
      />

      {/* 1. Banking portfolio inventory */}
      <Panel
        title={titleWithIcon('Banking portfolio inventory', Building2, `${BANK_CATALOG.length} banks × ${fmtInt(bankingSummary.total_customers)} customers × ${fmtInt(bankingSummary.total_accounts)} accounts × ${fmtInt(bankingSummary.total_loans)} loans`)}
        data-testid="edf-section-banking-inventory"
      >
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-3">
          <MetricCard label="Banks" value={String(BANK_CATALOG.length)} testId="edf-kpi-banks" />
          <MetricCard label="Customers" value={fmtInt(bankingSummary.total_customers)} testId="edf-kpi-customers" />
          <MetricCard label="Accounts" value={fmtInt(bankingSummary.total_accounts)} testId="edf-kpi-accounts" />
          <MetricCard label="Loans" value={fmtInt(bankingSummary.total_loans)} testId="edf-kpi-loans" />
          <MetricCard label="Portfolio (INR)" value={fmtCrores(bankingSummary.total_portfolio_inr)} testId="edf-kpi-portfolio" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
              <tr>
                <th className="text-left py-2 px-3">Bank</th>
                <th className="text-right py-2 px-3">Customers</th>
                <th className="text-right py-2 px-3">Loans</th>
                <th className="text-right py-2 px-3">Outstanding</th>
                <th className="text-right py-2 px-3">NPA count</th>
                <th className="text-right py-2 px-3">NPA %</th>
              </tr>
            </thead>
            <tbody>
              {bankWise.map((row) => (
                <tr key={row.bank_id} data-testid={`bank-row-${row.bank_id}`} className="border-b border-slate-900/50">
                  <td className="py-1.5 px-3 text-slate-200">{row.bank_name}</td>
                  <td className="py-1.5 px-3 text-right text-slate-300 tabular-nums">{fmtInt(row.customers)}</td>
                  <td className="py-1.5 px-3 text-right text-slate-300 tabular-nums">{fmtInt(row.loans)}</td>
                  <td className="py-1.5 px-3 text-right text-slate-300 tabular-nums">{fmtCrores(row.total_outstanding_inr)}</td>
                  <td className="py-1.5 px-3 text-right text-red-300 tabular-nums">{fmtInt(row.npa_count)}</td>
                  <td className="py-1.5 px-3 text-right">
                    <Badge tone={row.npa_pct > 5 ? 'danger' : row.npa_pct > 3 ? 'warning' : 'success'}>{row.npa_pct.toFixed(1)}%</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* 2. Loan health distribution */}
      <Panel
        title={titleWithIcon('Loan health distribution', Heart, `${fmtInt(bankingSummary.npa_count)} NPA · ${fmtInt(bankingSummary.sma_count)} SMA · ${fmtInt(bankingSummary.watchlist_count)} watchlist · NPA exposure ${fmtCrores(bankingSummary.npa_outstanding_inr)}`)}
        data-testid="edf-section-loan-health"
      >
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-2 mb-3">
          {LOAN_STATUSES.map((s) => (
            <div key={s} data-testid={`loan-status-${s}`} className="rounded border border-slate-700 bg-slate-900/30 p-2 text-center">
              <div className="text-slate-500 uppercase tracking-wider font-mono text-[10px]">{s}</div>
              <div className={`text-xl font-bold tabular-nums ${LOAN_STATUS_TONE[s] === 'danger' ? 'text-red-300' : LOAN_STATUS_TONE[s] === 'warning' ? 'text-amber-300' : 'text-emerald-300'}`}>
                {fmtInt(bankingSummary.by_loan_status[s] ?? 0)}
              </div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/30 p-3">
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">By loan type</div>
            <div className="h-40 w-full">
              <ResponsiveContainer>
                <BarChart data={loanTypeBars} margin={{ top: 4, right: 8, bottom: 4, left: -8 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="name" stroke="rgba(255,255,255,0.45)" fontSize={10} />
                  <YAxis stroke="rgba(255,255,255,0.45)" fontSize={11} width={36} />
                  <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(245,158,11,0.5)', color: '#fff', borderRadius: 8 }} />
                  <Bar dataKey="count" fill="#F59E0B" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/30 p-3">
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">DPD buckets</div>
            <div className="h-40 w-full">
              <ResponsiveContainer>
                <BarChart data={dpdBucketBars} margin={{ top: 4, right: 8, bottom: 4, left: -8 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="name" stroke="rgba(255,255,255,0.45)" fontSize={10} />
                  <YAxis stroke="rgba(255,255,255,0.45)" fontSize={11} width={36} />
                  <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(239,68,68,0.5)', color: '#fff', borderRadius: 8 }} />
                  <Bar dataKey="count" fill="#EF4444" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/30 p-3">
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Top sectors by exposure</div>
            <ul className="text-xs space-y-1.5">
              {bankingSummary.top_sectors_by_exposure.slice(0, 6).map((row) => (
                <li key={row.sector} data-testid={`sector-${row.sector}`} className="flex justify-between items-center border-b border-slate-900/50 py-1">
                  <span className="text-slate-200 capitalize">{row.sector}</span>
                  <span className="text-amber-300 font-mono tabular-nums">{fmtCrores(row.exposure_inr)} · {row.share_pct.toFixed(1)}%</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="mt-3">
          <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Recent NPA loans (top 8)</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
                <tr>
                  <th className="text-left py-1.5 px-2">Loan</th>
                  <th className="text-left py-1.5 px-2">Type</th>
                  <th className="text-left py-1.5 px-2">Sector</th>
                  <th className="text-right py-1.5 px-2">Outstanding</th>
                  <th className="text-right py-1.5 px-2">DPD</th>
                  <th className="text-right py-1.5 px-2">Missed EMI</th>
                </tr>
              </thead>
              <tbody>
                {npaLoans.map((l) => (
                  <tr key={l.loan_id} data-testid={`npa-loan-${l.loan_id}`} className="border-b border-slate-900/50">
                    <td className="py-1 px-2 font-mono text-[11px] text-slate-300">{l.loan_id}</td>
                    <td className="py-1 px-2 text-slate-400 capitalize text-xs">{l.loan_type}</td>
                    <td className="py-1 px-2 text-slate-400 capitalize text-xs">{l.sector.replace('_', ' ')}</td>
                    <td className="py-1 px-2 text-right text-slate-300 tabular-nums">{fmtCrores(l.outstanding_inr)}</td>
                    <td className="py-1 px-2 text-right text-red-300 tabular-nums">{l.dpd_days}d</td>
                    <td className="py-1 px-2 text-right text-amber-300 tabular-nums">{l.missed_emi_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Panel>

      {/* 3. Insurance inventory */}
      <Panel
        title={titleWithIcon('Insurance portfolio inventory', Shield, `${INSURER_CATALOG.length} insurers · ${fmtInt(insuranceSummary.total_policies)} policies · ${fmtInt(insuranceSummary.total_claims)} claims · ${fmtInt(insuranceSummary.total_fraud_cases)} fraud cases`)}
        data-testid="edf-section-insurance-inventory"
      >
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 mb-3">
          <MetricCard label="Insurers" value={String(INSURER_CATALOG.length)} testId="edf-kpi-insurers" />
          <MetricCard label="Customers" value={fmtInt(insuranceSummary.total_customers)} testId="edf-kpi-ins-customers" />
          <MetricCard label="Policies" value={fmtInt(insuranceSummary.total_policies)} testId="edf-kpi-policies" />
          <MetricCard label="Claims" value={fmtInt(insuranceSummary.total_claims)} testId="edf-kpi-claims" />
          <MetricCard label="Fraud cases" value={fmtInt(insuranceSummary.total_fraud_cases)} tone="danger" testId="edf-kpi-fraud" />
          <MetricCard label="Claim ratio" value={fmtPct01(insuranceSummary.claim_ratio)} tone={insuranceSummary.claim_ratio > 0.7 ? 'warning' : 'success'} testId="edf-kpi-claim-ratio" />
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
                  <tr>
                    <th className="text-left py-1.5 px-2">Insurer</th>
                    <th className="text-right py-1.5 px-2">Policies</th>
                    <th className="text-right py-1.5 px-2">Claims</th>
                    <th className="text-right py-1.5 px-2">Premium</th>
                    <th className="text-right py-1.5 px-2">Fraud</th>
                  </tr>
                </thead>
                <tbody>
                  {insurerWise.map((row) => (
                    <tr key={row.insurer_id} data-testid={`insurer-row-${row.insurer_id}`} className="border-b border-slate-900/50">
                      <td className="py-1 px-2 text-slate-200">{row.insurer_name}</td>
                      <td className="py-1 px-2 text-right text-slate-300 tabular-nums">{fmtInt(row.policies)}</td>
                      <td className="py-1 px-2 text-right text-slate-300 tabular-nums">{fmtInt(row.claims)}</td>
                      <td className="py-1 px-2 text-right text-slate-300 tabular-nums">{fmtCrores(row.total_premium_inr)}</td>
                      <td className="py-1 px-2 text-right text-red-300 tabular-nums">{fmtInt(row.fraud_count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/30 p-3">
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Policies by type</div>
            <div className="h-40 w-full">
              <ResponsiveContainer>
                <BarChart data={policyTypeBars} margin={{ top: 4, right: 8, bottom: 4, left: -8 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="name" stroke="rgba(255,255,255,0.45)" fontSize={10} />
                  <YAxis stroke="rgba(255,255,255,0.45)" fontSize={11} width={36} />
                  <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(16,185,129,0.5)', color: '#fff', borderRadius: 8 }} />
                  <Bar dataKey="count" fill="#10B981" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </Panel>

      {/* 4. Claims + fraud */}
      <Panel
        title={titleWithIcon('Claims + fraud hot-list', AlertTriangle, `${fmtInt(insuranceSummary.fraud_claim_count)} flagged claims · ${fmtInt(insuranceSummary.total_fraud_cases)} fraud cases under investigation`)}
        data-testid="edf-section-claims-fraud"
      >
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Recent claims (top 8)</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
                  <tr>
                    <th className="text-left py-1.5 px-2">Claim</th>
                    <th className="text-left py-1.5 px-2">Status</th>
                    <th className="text-right py-1.5 px-2">Amount</th>
                    <th className="text-right py-1.5 px-2">Fraud Score</th>
                  </tr>
                </thead>
                <tbody>
                  {recentClaims.map((c) => (
                    <tr key={c.claim_id} data-testid={`claim-${c.claim_id}`} className="border-b border-slate-900/50">
                      <td className="py-1 px-2 font-mono text-[11px] text-slate-300">{c.claim_id}</td>
                      <td className="py-1 px-2"><Badge tone={c.status === 'paid' ? 'success' : c.status === 'rejected' ? 'danger' : c.status === 'investigating' ? 'warning' : 'blue'}>{c.status}</Badge></td>
                      <td className="py-1 px-2 text-right text-slate-300 tabular-nums">{fmtCrores(c.claim_amount_inr)}</td>
                      <td className="py-1 px-2 text-right">
                        <Badge tone={c.fraud_score >= 70 ? 'danger' : c.fraud_score >= 40 ? 'warning' : 'success'}>{c.fraud_score.toFixed(0)}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Top fraud types</div>
            <ul className="text-xs space-y-1.5">
              {insuranceSummary.top_fraud_types.slice(0, 5).map((t) => (
                <li key={t.fraud_type} data-testid={`fraud-type-${t.fraud_type}`} className="border-b border-slate-900/50 py-1.5">
                  <div className="flex justify-between items-center">
                    <span className="text-slate-200 capitalize">{t.fraud_type.replace('_', ' ')}</span>
                    <span className="text-red-300 font-mono tabular-nums">{fmtInt(t.count)} · {fmtCrores(t.estimated_loss_inr)}</span>
                  </div>
                </li>
              ))}
            </ul>
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mt-3 mb-2">Recent fraud cases</div>
            <ul className="text-xs space-y-1">
              {fraudCases.map((f) => (
                <li key={f.fraud_id} data-testid={`fraud-case-${f.fraud_id}`} className="border-b border-slate-900/50 py-1 flex justify-between">
                  <span className="font-mono text-slate-300 text-[10px]">{f.fraud_id}</span>
                  <span className="capitalize text-slate-400 text-[10px]">{f.fraud_type.replace('_', ' ')}</span>
                  <Badge tone={f.status === 'confirmed' ? 'danger' : f.status === 'cleared' ? 'success' : 'warning'}>{f.status}</Badge>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Panel>

      {/* 5. Enterprise alert operations */}
      <Panel
        title={titleWithIcon('Enterprise alert operations', ShieldAlert, `${fmtInt(alertSummary.total_alerts)} total · ${fmtInt(alertSummary.open_count)} open · ${fmtInt(alertSummary.critical_open_count)} critical-open · 5 banking + 5 insurance alert kinds`)}
        data-testid="edf-section-alerts"
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
          <MetricCard label="Total alerts" value={fmtInt(alertSummary.total_alerts)} testId="edf-kpi-alerts" />
          <MetricCard label="Banking" value={fmtInt(alertSummary.by_domain.banking ?? 0)} testId="edf-kpi-banking-alerts" />
          <MetricCard label="Insurance" value={fmtInt(alertSummary.by_domain.insurance ?? 0)} testId="edf-kpi-insurance-alerts" />
          <MetricCard label="Critical open" value={fmtInt(alertSummary.critical_open_count)} tone="danger" testId="edf-kpi-critical-open" />
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
          <div className="xl:col-span-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
                <tr>
                  <th className="text-left py-1.5 px-2">Alert</th>
                  <th className="text-left py-1.5 px-2">Domain</th>
                  <th className="text-left py-1.5 px-2">Kind</th>
                  <th className="text-left py-1.5 px-2">Severity</th>
                  <th className="text-right py-1.5 px-2">Score</th>
                  <th className="text-left py-1.5 px-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {recentAlerts.map((a) => (
                  <tr key={a.alert_id} data-testid={`alert-${a.alert_id}`} className="border-b border-slate-900/50">
                    <td className="py-1 px-2 font-mono text-[11px] text-slate-300">{a.alert_id}</td>
                    <td className="py-1 px-2 text-slate-400 capitalize text-xs">{a.domain}</td>
                    <td className="py-1 px-2 text-slate-400 text-xs">{a.kind.replace(/_/g, ' ')}</td>
                    <td className="py-1 px-2"><Badge tone={SEVERITY_TONE[a.severity]}>{a.severity}</Badge></td>
                    <td className="py-1 px-2 text-right text-slate-300 tabular-nums">{a.risk_score.toFixed(0)}</td>
                    <td className="py-1 px-2 text-slate-400 text-xs">{a.status.replace('_', ' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/30 p-3">
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">By severity</div>
            <div className="h-40 w-full">
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={alertSeverityBars} dataKey="count" nameKey="name" outerRadius={60} label={false}>
                    {alertSeverityBars.map((s) => (
                      <Cell key={s.name} fill={SEV_COLORS[s.name] ?? '#94a3b8'} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(245,158,11,0.5)', color: '#fff', borderRadius: 8 }} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
        <div className="mt-3 text-xs text-slate-500">
          Banking alert kinds: {BANKING_ALERT_KINDS.length} · Insurance alert kinds: {INSURANCE_ALERT_KINDS.length}
        </div>
      </Panel>

      {/* 6. Investigation operations */}
      <Panel
        title={titleWithIcon('Investigation operations', Briefcase, `${fmtInt(caseSummary.total_cases)} cases · ${fmtInt(caseSummary.open_count)} open · ${fmtInt(caseSummary.in_progress_count)} in-progress · ${fmtInt(caseSummary.escalated_count)} escalated · ${fmtInt(caseSummary.closed_count)} closed`)}
        data-testid="edf-section-cases"
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mb-3 text-xs">
          {CASE_STATUSES.map((s) => (
            <div key={s} data-testid={`case-status-${s}`} className="rounded border border-slate-700 bg-slate-900/30 p-2 text-center">
              <div className="text-slate-500 uppercase tracking-wider font-mono text-[10px]">{s.replace('_', ' ')}</div>
              <div className="text-xl font-bold text-white tabular-nums">{fmtInt(caseSummary.by_status[s] ?? 0)}</div>
            </div>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
              <tr>
                <th className="text-left py-1.5 px-2">Case</th>
                <th className="text-left py-1.5 px-2">Type</th>
                <th className="text-left py-1.5 px-2">Severity</th>
                <th className="text-left py-1.5 px-2">Status</th>
                <th className="text-left py-1.5 px-2">Investigator</th>
                <th className="text-right py-1.5 px-2">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {recentCases.map((c) => (
                <tr key={c.case_id} data-testid={`case-${c.case_id}`} className="border-b border-slate-900/50">
                  <td className="py-1 px-2 font-mono text-[11px] text-slate-300">{c.case_id}</td>
                  <td className="py-1 px-2 text-slate-400 text-xs">{c.case_type.replace(/_/g, ' ')}</td>
                  <td className="py-1 px-2"><Badge tone={SEVERITY_TONE[c.severity]}>{c.severity}</Badge></td>
                  <td className="py-1 px-2 text-slate-400 text-xs">{c.status.replace('_', ' ')}</td>
                  <td className="py-1 px-2 text-slate-300 font-mono text-xs">{c.assigned_investigator}</td>
                  <td className="py-1 px-2 text-right text-slate-300 tabular-nums">{c.total_evidence_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 text-xs text-slate-500 font-mono">
          Mean age open: {caseSummary.mean_age_open_days.toFixed(1)}d · Total evidence: {fmtInt(caseSummary.total_evidence)}
        </div>
      </Panel>

      {/* 7. Executive KPIs */}
      <Panel
        title={titleWithIcon('Executive KPIs', Crown, 'banking + insurance — composite executive tiles with 30-day trend')}
        data-testid="edf-section-kpis"
      >
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-amber-400 font-mono mb-2">Banking executive KPIs</div>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
              <MetricCard label="Portfolio" value={fmtCrores(bankingKpi.portfolio_exposure_inr)} testId="kpi-bk-portfolio" />
              <MetricCard label="NPA exposure" value={fmtCrores(bankingKpi.npa_exposure_inr)} tone="danger" testId="kpi-bk-npa" />
              <MetricCard label="NPA ratio" value={`${bankingKpi.npa_ratio_pct.toFixed(2)}%`} tone={bankingKpi.npa_ratio_pct > 5 ? 'danger' : 'warning'} testId="kpi-bk-npa-ratio" />
              <MetricCard label="SMA accounts" value={fmtInt(bankingKpi.sma_accounts_count)} testId="kpi-bk-sma" />
              <MetricCard label="Fraud alerts 30d" value={fmtInt(bankingKpi.fraud_alerts_30d)} testId="kpi-bk-fraud" />
              <MetricCard label="Recovery rate" value={`${bankingKpi.recovery_rate_pct.toFixed(1)}%`} tone="success" testId="kpi-bk-recovery" />
            </div>
            <div className="mt-3 h-32">
              <ResponsiveContainer>
                <AreaChart data={bankingKpi.growth_trend_30d}>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="day_offset" stroke="rgba(255,255,255,0.45)" fontSize={10} />
                  <YAxis stroke="rgba(255,255,255,0.45)" fontSize={10} hide />
                  <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(245,158,11,0.5)', color: '#fff', borderRadius: 8 }} />
                  <Area type="monotone" dataKey="portfolio_inr" stroke="#10B981" fill="rgba(16,185,129,0.15)" name="Portfolio" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-emerald-400 font-mono mb-2">Insurance executive KPIs</div>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
              <MetricCard label="Active policies" value={fmtInt(insuranceKpi.active_policies_count)} tone="success" testId="kpi-ins-policies" />
              <MetricCard label="Claim ratio" value={`${insuranceKpi.claim_ratio_pct.toFixed(1)}%`} testId="kpi-ins-claim-ratio" />
              <MetricCard label="Fraud claims" value={fmtInt(insuranceKpi.fraud_claims_count)} tone="danger" testId="kpi-ins-fraud" />
              <MetricCard label="Persistency" value={`${insuranceKpi.persistency_ratio_pct.toFixed(1)}%`} testId="kpi-ins-persistency" />
              <MetricCard label="Solvency" value={`${insuranceKpi.solvency_ratio_pct.toFixed(0)}%`} tone={insuranceKpi.solvency_ratio_pct > 150 ? 'success' : 'warning'} testId="kpi-ins-solvency" />
            </div>
            <div className="mt-3 h-32">
              <ResponsiveContainer>
                <AreaChart data={insuranceKpi.growth_trend_30d}>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="day_offset" stroke="rgba(255,255,255,0.45)" fontSize={10} />
                  <YAxis stroke="rgba(255,255,255,0.45)" fontSize={10} hide />
                  <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(16,185,129,0.5)', color: '#fff', borderRadius: 8 }} />
                  <Area type="monotone" dataKey="active_policies" stroke="#3B82F6" fill="rgba(59,130,246,0.15)" name="Active policies" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </Panel>

      {/* 8. Predictive forecasts */}
      <Panel
        title={titleWithIcon('Predictive risk forecasts', Radar, `${allForecasts.length} forecasts · 6 kinds × 4 horizons (banking NPA growth / collections / sector stress · insurance lapse / fraud / persistency)`)}
        action={
          <div className="flex gap-1.5 flex-wrap text-xs">
            <span className="text-slate-500 self-center mr-1">Horizon:</span>
            {(['all', ...FORECAST_HORIZONS] as const).map((h) => (
              <button
                key={h}
                type="button"
                data-testid={`forecast-horizon-${h}`}
                onClick={() => setForecastHorizon(h)}
                className={`px-2 py-0.5 rounded font-medium transition border ${
                  h === forecastHorizon ? 'bg-amber-500/15 text-amber-300 border-amber-500' : 'bg-slate-900/40 text-slate-400 border-slate-700 hover:border-amber-500/60'
                }`}
              >
                {h}
              </button>
            ))}
          </div>
        }
        data-testid="edf-section-forecasts"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
              <tr>
                <th className="text-left py-1.5 px-2">Forecast</th>
                <th className="text-left py-1.5 px-2">Domain</th>
                <th className="text-left py-1.5 px-2">Kind</th>
                <th className="text-left py-1.5 px-2">Horizon</th>
                <th className="text-right py-1.5 px-2">Baseline</th>
                <th className="text-right py-1.5 px-2">Forecast</th>
                <th className="text-right py-1.5 px-2">Δ %</th>
                <th className="text-right py-1.5 px-2">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {filteredForecasts.slice(0, 12).map((f) => (
                <tr key={f.forecast_id} data-testid={`forecast-${f.forecast_id}`} className="border-b border-slate-900/50">
                  <td className="py-1 px-2 font-mono text-[11px] text-slate-300">{f.forecast_id}</td>
                  <td className="py-1 px-2 text-slate-400 capitalize text-xs">{f.domain}</td>
                  <td className="py-1 px-2 text-slate-400 text-xs">{f.kind.replace(/_/g, ' ')}</td>
                  <td className="py-1 px-2"><Badge tone="blue">{f.horizon}</Badge></td>
                  <td className="py-1 px-2 text-right text-slate-300 tabular-nums">{f.baseline_value.toFixed(1)}</td>
                  <td className="py-1 px-2 text-right text-slate-300 tabular-nums">{f.forecast_value.toFixed(1)}</td>
                  <td className={`py-1 px-2 text-right tabular-nums ${f.delta_pct > 0 ? 'text-red-300' : 'text-emerald-300'}`}>
                    {f.delta_pct > 0 ? '+' : ''}{f.delta_pct.toFixed(2)}%
                  </td>
                  <td className="py-1 px-2 text-right">
                    <Badge tone={f.confidence_score > 0.75 ? 'success' : f.confidence_score > 0.6 ? 'warning' : 'danger'}>{fmtPct01(f.confidence_score)}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2 text-xs text-slate-500">
          Banking forecast kinds: {BANKING_FORECAST_KINDS.length} · Insurance forecast kinds: {INSURANCE_FORECAST_KINDS.length} · Horizons: {FORECAST_HORIZONS.join(' / ')}
        </div>
      </Panel>

      {/* 9. Compliance posture */}
      <Panel
        title={titleWithIcon('Regulatory compliance posture', Lock, `${fmtInt(compliancePosture.total_obligations)} obligations · ${fmtInt(compliancePosture.open_findings)} open findings · ${fmtInt(compliancePosture.critical_open_findings)} critical · health ${fmtPct(compliancePosture.compliance_health_score)}`)}
        data-testid="edf-section-compliance"
      >
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 mb-3">
          {Object.entries(compliancePosture.by_status).map(([status, count]) => (
            <div key={status} data-testid={`compliance-status-${status}`} className="rounded border border-slate-700 bg-slate-900/30 p-2 text-center">
              <div className="text-slate-500 uppercase tracking-wider font-mono text-[10px]">{status.replace('_', ' ')}</div>
              <div className={`text-xl font-bold tabular-nums ${status === 'breach' || status === 'overdue' ? 'text-red-300' : status === 'due_soon' ? 'text-amber-300' : 'text-emerald-300'}`}>{fmtInt(count)}</div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
                <tr>
                  <th className="text-left py-1.5 px-2">Obligation</th>
                  <th className="text-left py-1.5 px-2">Framework</th>
                  <th className="text-left py-1.5 px-2">Status</th>
                  <th className="text-right py-1.5 px-2">Days to due</th>
                </tr>
              </thead>
              <tbody>
                {obligations.slice(0, 10).map((o) => (
                  <tr key={o.obligation_id} data-testid={`obligation-${o.obligation_id}`} className="border-b border-slate-900/50">
                    <td className="py-1 px-2 text-slate-200 text-xs">{o.title}</td>
                    <td className="py-1 px-2 text-slate-400 uppercase font-mono text-[10px]">{o.framework}</td>
                    <td className="py-1 px-2"><Badge tone={o.status === 'compliant' ? 'success' : o.status === 'breach' || o.status === 'overdue' ? 'danger' : 'warning'}>{o.status.replace('_', ' ')}</Badge></td>
                    <td className={`py-1 px-2 text-right tabular-nums ${o.days_to_due < 0 ? 'text-red-300' : o.days_to_due < 30 ? 'text-amber-300' : 'text-slate-300'}`}>{o.days_to_due}d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/30 p-3">
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">By framework</div>
            <ul className="text-xs space-y-1.5">
              {Object.entries(compliancePosture.by_framework).map(([fw, count]) => (
                <li key={fw} data-testid={`compliance-fw-${fw}`} className="flex justify-between items-center border-b border-slate-900/50 py-1">
                  <span className="text-slate-200 uppercase font-mono text-[11px]">{fw}</span>
                  <span className="text-amber-300 font-mono tabular-nums">{fmtInt(count)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 text-xs uppercase tracking-wider text-slate-400 font-mono mb-1">Domain health</div>
            <div className="grid grid-cols-2 gap-2">
              <div data-testid="domain-health-banking" className="rounded border border-slate-700 bg-slate-900/40 p-2 text-center">
                <div className="text-slate-500 text-[10px]">Banking</div>
                <div className="text-lg font-bold text-emerald-300 tabular-nums">{fmtPct(compliancePosture.domain_health_scores.banking)}</div>
              </div>
              <div data-testid="domain-health-insurance" className="rounded border border-slate-700 bg-slate-900/40 p-2 text-center">
                <div className="text-slate-500 text-[10px]">Insurance</div>
                <div className="text-lg font-bold text-emerald-300 tabular-nums">{fmtPct(compliancePosture.domain_health_scores.insurance)}</div>
              </div>
            </div>
          </div>
        </div>
      </Panel>

      {/* 10. Data fabric integration */}
      <Panel
        title={titleWithIcon('Data Fabric integration', Network, `${fmtInt(fabricSummary.total_sources)} demo sources · ${fmtInt(fabricSummary.total_pipelines)} pipelines · avg quality ${fmtPct(fabricSummary.avg_quality_score)} · AI readiness ${fmtPct(fabricSummary.readiness_health_pct)}`)}
        data-testid="edf-section-fabric"
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
          <MetricCard label="Sources" value={fmtInt(fabricSummary.total_sources)} testId="edf-kpi-fabric-sources" />
          <MetricCard label="Pipelines" value={fmtInt(fabricSummary.total_pipelines)} testId="edf-kpi-fabric-pipelines" />
          <MetricCard label="Avg quality" value={fmtPct(fabricSummary.avg_quality_score)} tone="success" testId="edf-kpi-fabric-quality" />
          <MetricCard label="AI readiness" value={fmtPct(fabricSummary.readiness_health_pct)} testId="edf-kpi-fabric-readiness" />
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Demo sources</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
                  <tr>
                    <th className="text-left py-1.5 px-2">Name</th>
                    <th className="text-left py-1.5 px-2">Kind</th>
                    <th className="text-right py-1.5 px-2">Records</th>
                    <th className="text-left py-1.5 px-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {fabricSources.map((s) => (
                    <tr key={s.source_id} data-testid={`fabric-source-${s.source_id}`} className="border-b border-slate-900/50">
                      <td className="py-1 px-2 text-slate-200 text-xs">{s.name}</td>
                      <td className="py-1 px-2 text-slate-400 font-mono text-[10px]">{s.kind}</td>
                      <td className="py-1 px-2 text-right text-slate-300 tabular-nums text-xs">{fmtInt(s.record_count_estimate)}</td>
                      <td className="py-1 px-2"><Badge tone={s.status === 'live' ? 'success' : s.status === 'lagging' ? 'warning' : 'danger'}>{s.status}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">AI readiness per dataset</div>
            <ul className="text-xs space-y-1.5">
              {fabricReadiness.map((r) => (
                <li key={r.readiness_id} data-testid={`readiness-${r.readiness_id}`} className="border-b border-slate-900/50 py-1.5">
                  <div className="flex justify-between items-center">
                    <span className="text-slate-200">{r.dataset_name}</span>
                    <Badge tone={r.grade === 'production_ready' ? 'success' : r.grade === 'training_only' ? 'warning' : 'danger'}>{r.grade.replace('_', ' ')}</Badge>
                  </div>
                  <div className="text-slate-500 text-[10px] font-mono">{r.ai_workload} · readiness: {fmtPct(r.readiness_pct)}</div>
                </li>
              ))}
            </ul>
            <div className="mt-3 text-xs uppercase tracking-wider text-slate-400 font-mono mb-1">Pipelines: {fabricPipelines.length}</div>
          </div>
        </div>
      </Panel>

      {/* Cross-IA footer */}
      <div className="flex items-center gap-3 flex-wrap text-xs text-slate-400 pt-1">
        <span>Cross-IA:</span>
        <Link className="hover:text-amber-300 underline decoration-dotted" to="/executive-cockpit">Executive Cockpit</Link>
        <Link className="hover:text-amber-300 underline decoration-dotted" to="/predictive-risk-center">Predictive Risk</Link>
        <Link className="hover:text-amber-300 underline decoration-dotted" to="/investigation-center">Investigations</Link>
        <Link className="hover:text-amber-300 underline decoration-dotted" to="/regulatory-compliance-center">Regulatory</Link>
        <Link className="hover:text-amber-300 underline decoration-dotted" to="/data-fabric-center">Data Fabric</Link>
        <Link className="hover:text-amber-300 underline decoration-dotted" to="/dashboards/role-based">Role Dashboard</Link>
      </div>
    </div>
  );
}

// silence unused-import warnings for icons reserved for future expansion
void Activity; void Award; void BarChart3; void Clock; void Coins; void CreditCard;
void Database; void DollarSign; void FileText; void Filter; void FlaskConical;
void Gauge; void Home; void Layers; void LineChart; void ListChecks;
void PiggyBank; void Plug; void Sparkles; void Target; void TrendingDown;
void TrendingUp; void Users; void Wallet; void Zap;

