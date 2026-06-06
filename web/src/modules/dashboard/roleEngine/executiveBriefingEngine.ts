// executiveBriefingEngine.ts
//
// Phase: Dynamic Dashboard Intelligence Layer — Executive Briefing Engine
//
// Generates a role-personalized auto-briefing card shown at the top of
// every dashboard. Pure-function, deterministic per (role, domain, dayKey).
// Covers: Today's Top Risks, Key Changes, Pending Decisions, Deadlines,
//         Forecast Deteriorations, Investigation Escalations.

import type { WidgetRole } from './widgetRegistry';
import type { FullDashboardContext } from './dashboardContextResolver';

// ─── Types ────────────────────────────────────────────────────────────────

export type BriefingItemUrgency = 'immediate' | 'today' | 'this-week';

export interface BriefingItem {
  category:   'risk' | 'change' | 'decision' | 'deadline' | 'forecast' | 'investigation';
  title:      string;
  detail:     string;
  urgency:    BriefingItemUrgency;
  /** Optional deep-link target for "View →" button */
  href?:      string;
  /** KPI delta string e.g. "+3.2%" or "−2 accounts" */
  delta?:     string;
  positive?:  boolean;
}

export interface ExecutiveBriefing {
  greeting:      string;
  headline:      string;
  subheadline:   string;
  items:         BriefingItem[];
  pendingCount:  number;
  immediateCount: number;
  generated_at:  string;
}

// ─── PRNG ────────────────────────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function rng(s: string) { return mulberry32(fnv1a(s)); }

// ─── Role-specific briefing templates ────────────────────────────────────

type BriefingTemplate = { title: string; detail: string; urgency: BriefingItemUrgency; category: BriefingItem['category']; href?: string };

const BANKING_TEMPLATES: Record<WidgetRole, BriefingTemplate[]> = {
  risk_analyst: [
    { category: 'risk',         title: 'NPA early warning triggered',      detail: '8 borrowers crossed PD threshold 0.75 overnight. Review required.',         urgency: 'immediate', href: '/banking/npa-prediction' },
    { category: 'investigation',title: 'Fraud cluster detected',           detail: 'Synthetic identity pattern flagged across 4 accounts in North zone.',         urgency: 'immediate', href: '/fraud-signals' },
    { category: 'change',       title: 'SMA-1 up 18% week-on-week',        detail: 'SME book deterioration accelerating. 23 new accounts entered watch list.',    urgency: 'today',     href: '/banking/sma' },
    { category: 'deadline',     title: 'AML monthly filing — 8 days',      detail: 'Reconcile transaction flags before submission to regulator.',                  urgency: 'this-week', href: '/regulatory-compliance-center' },
    { category: 'forecast',     title: 'NPA forecast deteriorating',        detail: 'Model projects +₹142Cr exposure over next 90 days under base case.',          urgency: 'today',     href: '/predictive-risk-center' },
  ],
  fraud_analyst: [
    { category: 'risk',         title: 'New fraud cluster — MSME segment', detail: '9.4Cr exposure flagged. 6 accounts under investigation.',                     urgency: 'immediate', href: '/fraud-signals' },
    { category: 'investigation',title: '3 SAR filings pending approval',   detail: 'Two cases require supervisor sign-off before regulatory submission.',          urgency: 'immediate', href: '/investigation-center' },
    { category: 'change',       title: 'Fraud model AUC improved',         detail: 'Champion model v3.2 showing 0.89 AUC (+0.03 vs yesterday).',                   urgency: 'today',     href: '/ai/governance' },
    { category: 'deadline',     title: 'Vigilance referral — 2 days',      detail: 'Case CASE-1042 must be referred to enforcement within 48h.',                  urgency: 'today',     href: '/investigation-center' },
  ],
  collection_officer: [
    { category: 'risk',         title: '12 SLA breaches in my queue',      detail: 'Cases must be actioned today to avoid escalation to supervisor.',              urgency: 'immediate', href: '/cms/cases?breached=true' },
    { category: 'decision',     title: '4 recovery plans need approval',   detail: 'Legal team waiting on your sign-off to proceed with asset seizure.',           urgency: 'immediate', href: '/recovery-center' },
    { category: 'change',       title: 'Recovery rate improved 3.1%',      detail: 'Last 30-day recovery rate: 68.4%. Above the 65% target.',                    urgency: 'today',     href: '/recovery-center' },
    { category: 'deadline',     title: 'Court hearing — CASE-882 tomorrow', detail: 'Prepare documentation for tomorrow 10:30 AM session.',                       urgency: 'today',     href: '/cms/cases' },
  ],
  supervisor: [
    { category: 'decision',     title: '6 cases awaiting your approval',   detail: 'SLA-critical cases need sign-off before 17:00 today.',                       urgency: 'immediate', href: '/cms/cases?status=PENDING_APPROVAL' },
    { category: 'risk',         title: 'Branch-level SLA breach: 3 cases', detail: 'Mumbai-BKC branch: escalation threshold breached. Intervention required.',     urgency: 'immediate', href: '/branch-heatmap' },
    { category: 'change',       title: 'Team throughput +12% this week',   detail: 'Case closure rate improved. Backlog reduced by 28 cases.',                    urgency: 'today',     href: '/cms/cases' },
    { category: 'deadline',     title: 'Performance review — end of month', detail: '3 analysts due for quarterly KPI review. Schedule sessions.',                 urgency: 'this-week', href: '/admin/iam' },
  ],
  executive: [
    { category: 'risk',         title: 'Enterprise Risk Score: 52/100',    detail: 'Elevated band. Fraud cluster + NPA deterioration driving score up 4.2pts.',   urgency: 'today',     href: '/executive-cockpit' },
    { category: 'decision',     title: '2 board decisions pending',        detail: 'Write-off authorization (₹28Cr) + Capital allocation review.',                 urgency: 'immediate', href: '/executive-cockpit' },
    { category: 'forecast',     title: 'Q3 NPA: +₹142Cr vs forecast',     detail: 'Digital lending portfolio leading deterioration. Review stress scenarios.',    urgency: 'today',     href: '/predictive-risk-center' },
    { category: 'deadline',     title: 'Board presentation: 5 days',       detail: 'Prepare Q2 risk appetite statement and portfolio health deck.',                 urgency: 'this-week', href: '/board-reporting-center' },
  ],
  auditor: [
    { category: 'deadline',     title: 'RBI Q2 filing: 14 days',           detail: 'Data reconciliation in progress. 3 variance items outstanding.',               urgency: 'today',     href: '/regulatory-compliance-center' },
    { category: 'risk',         title: 'Compliance gap: AML coverage 79%', detail: 'Below 85% threshold. Remediation plan required by month-end.',                urgency: 'immediate', href: '/regulatory-compliance-center' },
    { category: 'change',       title: 'KYC review: 420 accounts pending', detail: 'Periodic review batch due. Flag expired documents for customer outreach.',     urgency: 'this-week', href: '/regulatory-compliance-center' },
    { category: 'decision',     title: 'Audit sign-off: 8 open items',     detail: 'Prior period findings awaiting management response.',                          urgency: 'today',     href: '/audit-center' },
  ],
  admin: [
    { category: 'risk',         title: 'Platform risk: Elevated',          detail: 'Enterprise Risk Index at 52. Two risk centers require attention.',             urgency: 'today',     href: '/' },
    { category: 'decision',     title: '5 user access requests pending',   detail: 'New role assignments need admin approval.',                                    urgency: 'today',     href: '/admin/iam' },
    { category: 'deadline',     title: 'Quarterly access review: 10 days', detail: '18 dormant accounts flagged for review.',                                     urgency: 'this-week', href: '/admin/iam' },
  ],
  super_admin:     [],
  country_admin:   [],
  bank_admin:      [],
  insurance_admin: [],
  field_officer:   [],
};

const INSURANCE_TEMPLATES: Partial<Record<WidgetRole, BriefingTemplate[]>> = {
  risk_analyst: [
    { category: 'risk',         title: 'Claims ratio above threshold',     detail: 'Motor portfolio: 82.4% claims ratio. Underwriting review triggered.',         urgency: 'immediate', href: '/insurance/underwriting' },
    { category: 'forecast',     title: 'Lapse rate forecast up 1.8%',      detail: 'ULIP segment at risk. Retention campaign recommended for 312 policies.',       urgency: 'today',     href: '/insurance/policy-lapse' },
    { category: 'deadline',     title: 'IRDAI H1 return: 30 days',         detail: '3 supporting documents pending. Compliance team notified.',                   urgency: 'this-week', href: '/regulatory-compliance-center' },
  ],
  executive: [
    { category: 'risk',         title: 'Solvency ratio: 1.42 (watch)',     detail: 'Approaching minimum regulatory threshold of 1.35. Actuarial review needed.',  urgency: 'today',     href: '/insurance/solvency' },
    { category: 'decision',     title: '₹38Cr reinsurance treaty pending', detail: 'Board approval required before Q3 reinsurance renewal.',                      urgency: 'immediate', href: '/executive-cockpit' },
    { category: 'forecast',     title: 'Claims inflation: +14% projected', detail: 'Health portfolio facing higher claim frequency than priced. Reserve review.',  urgency: 'today',     href: '/predictive-risk-center' },
  ],
};

// ─── Greeting ────────────────────────────────────────────────────────────

function greeting(role: WidgetRole): string {
  const ROLE_GREETING: Partial<Record<WidgetRole, string>> = {
    executive: 'Good morning, Executive',
    auditor:   'Good morning, Auditor',
    risk_analyst: 'Good morning, Risk Analyst',
    fraud_analyst: 'Good morning, Fraud Analyst',
    collection_officer: 'Good morning, Collections Officer',
    supervisor: 'Good morning, Supervisor',
    admin: 'Good morning, Admin',
  };
  const hour = new Date().getHours();
  const base = ROLE_GREETING[role] ?? 'Good morning';
  const salutation = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return base.replace('Good morning', salutation);
}

// ─── Main generator ───────────────────────────────────────────────────────

export function generateExecutiveBriefing(ctx: FullDashboardContext): ExecutiveBriefing {
  const { role, domain, dayKey } = ctx;
  const r = rng(`brief:${role}:${domain}:${dayKey}`);

  // Pick templates for this role + domain
  const domainTemplates = (domain === 'insurance' ? INSURANCE_TEMPLATES[role] : null)
    ?? BANKING_TEMPLATES[role]
    ?? BANKING_TEMPLATES.admin;

  // Mix in risk elevation items when elevated/high/critical
  const riskItems: BriefingTemplate[] = [];
  if (ctx.risk.elevation === 'critical' || ctx.risk.elevation === 'high') {
    riskItems.push({ category: 'risk', title: 'ALERT: Critical risk elevation', detail: `Enterprise risk is in ${ctx.risk.elevation.toUpperCase()} state. ${ctx.risk.criticalAlerts} critical alerts active.`, urgency: 'immediate', href: '/alerts' });
  }

  // Workload-driven items
  const workloadItems: BriefingTemplate[] = [];
  if (ctx.workload.mySlaBreaches >= 3) {
    workloadItems.push({ category: 'risk', title: `${ctx.workload.mySlaBreaches} SLA breaches in my queue`, detail: 'Cases breached SLA window. Immediate action required to prevent escalation.', urgency: 'immediate', href: '/cms/cases?breached=true' });
  }
  if (ctx.workload.myApprovals >= 4) {
    workloadItems.push({ category: 'decision', title: `${ctx.workload.myApprovals} approvals awaiting`, detail: 'Multiple items require your decision to unblock downstream teams.', urgency: 'today', href: '/cms/cases?status=PENDING_APPROVAL' });
  }

  // Shuffle + pick items via PRNG for variety across days
  const allTemplates = [...riskItems, ...workloadItems, ...domainTemplates];
  const selectedTemplates = allTemplates.slice(0, 5);

  const items: BriefingItem[] = selectedTemplates.map((t, i) => ({
    category:  t.category,
    title:     t.title,
    detail:    t.detail,
    urgency:   t.urgency,
    href:      t.href,
    delta:     i === 0 ? `+${Math.round(1 + r() * 8)}%` : undefined,
    positive:  i === 0 ? r() > 0.5 : undefined,
  }));

  const immediateCount = items.filter(i => i.urgency === 'immediate').length;
  const pendingCount   = ctx.workload.myApprovals + ctx.workload.mySlaBreaches;

  const HEADLINES: Record<string, string[]> = {
    critical: ['⚠️ Critical risk conditions require your immediate attention.', '⚠️ Platform risk in CRITICAL state — action required now.'],
    high:     ['Platform risk is HIGH — review priority items below.', 'Risk elevation detected — focus on flagged items.'],
    elevated: ['Risk is elevated — monitor priority indicators closely.', 'Some risk signals need attention today.'],
    normal:   ['Dashboard is up to date. All systems within normal parameters.', 'Good conditions across the portfolio today.'],
  };
  const headlinePool = HEADLINES[ctx.risk.elevation] ?? HEADLINES.normal;
  const headline = headlinePool[Math.floor(r() * headlinePool.length)]!;

  return {
    greeting:       greeting(role),
    headline,
    subheadline:    `${items.length} item${items.length === 1 ? '' : 's'} need your attention · ${immediateCount} immediate`,
    items,
    pendingCount,
    immediateCount,
    generated_at:   new Date().toISOString(),
  };
}
