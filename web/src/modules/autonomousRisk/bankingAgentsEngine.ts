/**
 * Banking AI Agents Engine — Credit Risk + Fraud + Collections + Portfolio Risk.
 * Pure-function. Deterministic via FNV-1a + Mulberry32. Phase 18 overlay.
 */

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function dayKey(d: Date): string { return d.toISOString().slice(0, 10); }
function round(v: number, dec = 0): number { return Math.round(v * Math.pow(10, dec)) / Math.pow(10, dec); }
function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
function pick<T>(arr: T[], rng: () => number): T { return arr[Math.floor(rng() * arr.length)]; }

// ---------------------------------------------------------------------------
// 1. Credit Risk Agent
// ---------------------------------------------------------------------------

export interface CreditRiskAgentReport {
  generated_at: string;
  total_monitored_borrowers: number;
  deteriorating_count: number;
  npa_risk_count: number;
  sma_stage_2_count: number;
  sma_stage_3_count: number;
  npa_trend_30d: number;
  provision_gap_cr: number;
  confidence_score: number;
  top_exposures: Array<{
    customer_id: string;
    name: string;
    exposure_cr: number;
    dpd: number;
    risk_level: string;
    recommended_action: string;
  }>;
  key_findings: string[];
  immediate_actions: string[];
}

export function buildCreditRiskReport(tenant: string, asOf: Date): CreditRiskAgentReport {
  const rng = mulberry32(fnv1a(tenant + ':credit_risk:' + dayKey(asOf)));

  const total_monitored_borrowers = Math.floor(45000 + rng() * 20000);
  const deteriorating_count = Math.floor(800 + rng() * 1600);
  const npa_risk_count = Math.floor(200 + rng() * 600);
  const sma_stage_2_count = Math.floor(deteriorating_count * (0.35 + rng() * 0.2));
  const sma_stage_3_count = Math.floor(deteriorating_count * (0.15 + rng() * 0.15));
  const npa_trend_30d = round((rng() * 0.8 - 0.2), 2); // -0.2 to +0.6 pp
  const provision_gap_cr = round(120 + rng() * 480, 1);
  const confidence_score = round(0.82 + rng() * 0.14, 2);

  const companyNames = [
    'Prism Infrastructure Ltd', 'Kaveri Agro Industries', 'Zenith Steel Corporation',
    'Mahalaxmi Textiles Pvt Ltd', 'Deccan Power Projects', 'Ganga Realty Developers',
    'Shree Cement Works Ltd', 'Bharat Auto Components', 'Narmada Chemical Industries',
    'Coastal Shipping Ltd', 'Sunrise Pharma Pvt Ltd', 'Himalayan Tourism Holdings',
  ];
  const riskLevels = ['Critical', 'High', 'High', 'Medium', 'Medium'];
  const actions = [
    'Initiate NPA classification review',
    'Escalate to credit committee — immediate restructuring',
    'Demand additional collateral within 7 days',
    'Upgrade monitoring to weekly cash-flow review',
    'File SARFAESI notice — 60 days outstanding',
    'Place account on special mention list (SMA-2)',
    'Schedule borrower meeting for repayment plan',
  ];

  const top_exposures = Array.from({ length: 5 }, (_, i) => {
    const name = companyNames[Math.floor(rng() * companyNames.length)];
    const exposure_cr = round(8 + rng() * 87, 1);
    const dpd = Math.floor(30 + rng() * 150);
    const risk_level = riskLevels[i] ?? pick(riskLevels, rng);
    const recommended_action = pick(actions, rng);
    return {
      customer_id: `CUST-CR-${String(Math.floor(rng() * 90000) + 10000)}`,
      name,
      exposure_cr,
      dpd,
      risk_level,
      recommended_action,
    };
  });

  const key_findings = [
    `NPA migration accelerating in MSME segment — ${Math.floor(120 + rng() * 200)} accounts moved to SMA-2 in last 30 days`,
    `Infrastructure sector showing elevated stress: ${Math.floor(15 + rng() * 25)}% of portfolio under watch with DPD > 60`,
    `Provision coverage ratio at ${round(62 + rng() * 18, 1)}% — gap of ₹${provision_gap_cr} Cr against RBI mandate of 70%`,
    `Retail loan book (home + auto) remains stable; early-warning triggers elevated in unsecured personal loans`,
  ];

  const immediate_actions = [
    `Initiate restructuring dialogue for top ${Math.floor(8 + rng() * 12)} critical exposures above ₹50 Cr`,
    `Submit enhanced provision plan to board — ₹${round(provision_gap_cr * 0.4, 0)} Cr additional provisioning recommended in Q3`,
    `Activate SMA monitoring protocol: weekly MIS for ${sma_stage_2_count + sma_stage_3_count} accounts in SMA-2 and SMA-3`,
    `Refer ${Math.floor(12 + rng() * 20)} long-overdue accounts to legal for SARFAESI / DRT proceedings`,
  ];

  return {
    generated_at: asOf.toISOString(),
    total_monitored_borrowers,
    deteriorating_count,
    npa_risk_count,
    sma_stage_2_count,
    sma_stage_3_count,
    npa_trend_30d,
    provision_gap_cr,
    confidence_score,
    top_exposures,
    key_findings,
    immediate_actions,
  };
}

// ---------------------------------------------------------------------------
// 2. Fraud Agent
// ---------------------------------------------------------------------------

export interface BankingFraudAgentReport {
  generated_at: string;
  fraud_signals_24h: number;
  active_investigations: number;
  suspicious_transactions_24h: number;
  ml_anomalies_detected: number;
  flagged_accounts: number;
  auto_blocked: number;
  pending_review: number;
  confidence_score: number;
  top_fraud_patterns: Array<{
    pattern: string;
    count: number;
    risk_level: string;
    estimated_loss_cr: number;
  }>;
  key_findings: string[];
  immediate_actions: string[];
}

export function buildFraudAgentReport(tenant: string, asOf: Date): BankingFraudAgentReport {
  const rng = mulberry32(fnv1a(tenant + ':fraud:' + dayKey(asOf)));

  const fraud_signals_24h = Math.floor(45 + rng() * 135);
  const active_investigations = Math.floor(8 + rng() * 27);
  const suspicious_transactions_24h = Math.floor(180 + rng() * 620);
  const ml_anomalies_detected = Math.floor(35 + rng() * 110);
  const flagged_accounts = Math.floor(60 + rng() * 180);
  const auto_blocked = Math.floor(flagged_accounts * (0.25 + rng() * 0.35));
  const pending_review = flagged_accounts - auto_blocked;
  const confidence_score = round(0.85 + rng() * 0.12, 2);

  const fraudPatterns = [
    { pattern: 'Card-not-present (CNP) e-commerce fraud', riskBase: 0.9, countBase: 38 },
    { pattern: 'Account takeover via phishing / SIM-swap', riskBase: 0.95, countBase: 22 },
    { pattern: 'Synthetic identity fraud — new account origination', riskBase: 0.85, countBase: 15 },
    { pattern: 'Mule account money-laundering network', riskBase: 0.95, countBase: 11 },
    { pattern: 'Cheque truncation system (CTS) forgery', riskBase: 0.7, countBase: 8 },
    { pattern: 'ATM card skimming cluster — metro locations', riskBase: 0.75, countBase: 17 },
  ];

  const riskLabels = (score: number) => score >= 0.9 ? 'Critical' : score >= 0.75 ? 'High' : 'Medium';

  const selectedPatterns = fraudPatterns
    .sort(() => rng() - 0.5)
    .slice(0, 4)
    .map((p) => ({
      pattern: p.pattern,
      count: Math.floor(p.countBase + rng() * p.countBase * 0.8),
      risk_level: riskLabels(p.riskBase + rng() * 0.05 - 0.025),
      estimated_loss_cr: round(0.4 + rng() * 8.5, 2),
    }));

  const key_findings = [
    `CNP fraud velocity up ${Math.floor(15 + rng() * 30)}% week-on-week — concentrated in tier-2 city merchant IDs`,
    `ML model flagged ${ml_anomalies_detected} velocity anomalies overnight; ${Math.floor(ml_anomalies_detected * 0.6)} confirmed as suspicious`,
    `${auto_blocked} accounts auto-blocked by rule engine; estimated prevented loss ₹${round(auto_blocked * 0.18, 1)} Cr`,
    `SIM-swap fraud cluster identified: 3 telecom circles, ${Math.floor(18 + rng() * 22)} affected high-value accounts`,
  ];

  const immediate_actions = [
    `Escalate ${active_investigations} active investigations — assign senior analyst to top 5 by estimated loss`,
    `Deploy updated CNP velocity rule: block > ${Math.floor(3 + rng() * 4)} transactions/hr on newly-issued virtual cards`,
    `Notify ${Math.floor(pending_review * 0.4)} high-risk pending accounts via OTP confirmation before next transaction`,
    `Coordinate with 3 telecom operators on SIM-swap alerts — SLA: 2-hour block on account-linking post SIM-change`,
  ];

  return {
    generated_at: asOf.toISOString(),
    fraud_signals_24h,
    active_investigations,
    suspicious_transactions_24h,
    ml_anomalies_detected,
    flagged_accounts,
    auto_blocked,
    pending_review,
    confidence_score,
    top_fraud_patterns: selectedPatterns,
    key_findings,
    immediate_actions,
  };
}

// ---------------------------------------------------------------------------
// 3. Collections Agent
// ---------------------------------------------------------------------------

export interface CollectionsAgentReport {
  generated_at: string;
  total_overdue_accounts: number;
  critical_bucket_count: number;
  total_overdue_cr: number;
  recovery_target_cr: number;
  recovery_achieved_cr: number;
  recovery_rate_pct: number;
  field_visits_scheduled: number;
  legal_actions_pending: number;
  confidence_score: number;
  top_recovery_opportunities: Array<{
    account_id: string;
    borrower_name: string;
    outstanding_cr: number;
    dpd: number;
    probability_of_recovery_pct: number;
    recommended_strategy: string;
  }>;
  key_findings: string[];
  recommended_actions: string[];
}

export function buildCollectionsReport(tenant: string, asOf: Date): CollectionsAgentReport {
  const rng = mulberry32(fnv1a(tenant + ':collections:' + dayKey(asOf)));

  const total_overdue_accounts = Math.floor(8000 + rng() * 17000);
  const critical_bucket_count = Math.floor(total_overdue_accounts * (0.08 + rng() * 0.12));
  const total_overdue_cr = round(680 + rng() * 1420, 1);
  const recovery_rate_pct = round(28 + rng() * 34, 1);
  const recovery_target_cr = round(total_overdue_cr * (0.28 + rng() * 0.18), 1);
  const recovery_achieved_cr = round(recovery_target_cr * (recovery_rate_pct / 100) * (0.9 + rng() * 0.2), 1);
  const field_visits_scheduled = Math.floor(220 + rng() * 480);
  const legal_actions_pending = Math.floor(critical_bucket_count * (0.18 + rng() * 0.22));
  const confidence_score = round(0.79 + rng() * 0.16, 2);

  const borrowerNames = [
    'Suresh Kumar Trading Co', 'Meena Devi Enterprises', 'Ramesh & Sons Construction',
    'Priya Fashion Exports', 'Venkatesh Auto Spares', 'Anand Cold Storage Ltd',
    'Laxmi Rice Mill', 'Shyam Sundar Hotels', 'Deepak Fabrication Works', 'Kavita Logistics',
  ];
  const strategies = [
    'One-time settlement (OTS) — offer 65% waiver on interest overdue',
    'Restructure into 36-month EMI with moratorium — 3 months',
    'Assign dedicated recovery officer — weekly physical visit',
    'File SARFAESI Section 13(2) notice — 60-day cure period',
    'Initiate DRT proceedings — file original application',
    'Refer to ARCs (Asset Reconstruction Company) for portfolio sale',
    'Invoke personal guarantee — serve legal notice to guarantors',
  ];

  const top_recovery_opportunities = Array.from({ length: 5 }, () => {
    const borrower_name = pick(borrowerNames, rng);
    const outstanding_cr = round(1.8 + rng() * 38, 1);
    const dpd = Math.floor(60 + rng() * 540);
    const probability_of_recovery_pct = round(
      clamp(85 - dpd * 0.08 + rng() * 20, 10, 90),
      1,
    );
    return {
      account_id: `COLL-${String(Math.floor(rng() * 900000) + 100000)}`,
      borrower_name,
      outstanding_cr,
      dpd,
      probability_of_recovery_pct,
      recommended_strategy: pick(strategies, rng),
    };
  });

  const key_findings = [
    `Recovery rate of ${recovery_rate_pct}% against target of ${round(recovery_rate_pct * 1.18, 1)}% — gap of ₹${round(recovery_target_cr - recovery_achieved_cr, 1)} Cr this month`,
    `Critical bucket (DPD > 180) accounts: ${critical_bucket_count} with combined outstanding ₹${round(critical_bucket_count * 0.82, 0)} Cr — immediate escalation required`,
    `Field visit conversion rate at ${round(28 + rng() * 22, 1)}% — ${Math.floor(field_visits_scheduled * 0.35)} accounts made partial payments post-visit`,
    `Legal pipeline: ${legal_actions_pending} accounts at DRT/SARFAESI stage; estimated resolution value ₹${round(legal_actions_pending * 1.4, 0)} Cr`,
  ];

  const recommended_actions = [
    `Prioritise OTS campaign for ${Math.floor(critical_bucket_count * 0.3)} accounts DPD 90-180 — limited-time 60% settlement offer valid 30 days`,
    `Increase field visit frequency in tier-2 cities — assign ${Math.floor(15 + rng() * 20)} additional recovery officers`,
    `Fast-track SARFAESI action for top ${Math.floor(legal_actions_pending * 0.4)} accounts with > ₹10 Cr outstanding`,
    `Leverage data analytics to identify ${Math.floor(200 + rng() * 350)} high-propensity-to-pay accounts for soft collections outreach`,
  ];

  return {
    generated_at: asOf.toISOString(),
    total_overdue_accounts,
    critical_bucket_count,
    total_overdue_cr,
    recovery_target_cr,
    recovery_achieved_cr,
    recovery_rate_pct,
    field_visits_scheduled,
    legal_actions_pending,
    confidence_score,
    top_recovery_opportunities,
    key_findings,
    recommended_actions,
  };
}

// ---------------------------------------------------------------------------
// 4. Portfolio Risk Agent
// ---------------------------------------------------------------------------

export interface PortfolioRiskAgentReport {
  generated_at: string;
  portfolio_health_score: number;
  hhi_index: number;
  single_borrower_limit_breaches: number;
  confidence_score: number;
  sector_concentration_breaches: Array<{
    sector: string;
    current_pct: number;
    limit_pct: number;
    breach_pp: number;
    risk_level: string;
  }>;
  emerging_risks: Array<{
    risk_title: string;
    affected_portfolio_pct: number;
    potential_loss_cr: number;
    timeline: string;
    risk_level: string;
  }>;
  key_findings: string[];
  portfolio_recommendations: string[];
}

export function buildPortfolioRiskReport(tenant: string, asOf: Date): PortfolioRiskAgentReport {
  const rng = mulberry32(fnv1a(tenant + ':portfolio:' + dayKey(asOf)));

  const portfolio_health_score = round(55 + rng() * 30, 1);
  const hhi_index = round(0.08 + rng() * 0.10, 3);
  const single_borrower_limit_breaches = Math.floor(rng() * 6);
  const confidence_score = round(0.83 + rng() * 0.13, 2);

  const sectors = [
    { name: 'Infrastructure & Construction', limit_pct: 15 },
    { name: 'Real Estate & Housing', limit_pct: 12 },
    { name: 'Iron & Steel', limit_pct: 10 },
    { name: 'Power & Energy', limit_pct: 12 },
    { name: 'Textiles & Garments', limit_pct: 8 },
    { name: 'Gems & Jewellery', limit_pct: 6 },
  ];

  const sector_concentration_breaches = sectors
    .filter(() => rng() > 0.55)
    .slice(0, 3)
    .map((s) => {
      const breach_pp = round(0.5 + rng() * 4.5, 1);
      const current_pct = round(s.limit_pct + breach_pp, 1);
      return {
        sector: s.name,
        current_pct,
        limit_pct: s.limit_pct,
        breach_pp,
        risk_level: breach_pp >= 3 ? 'Critical' : breach_pp >= 1.5 ? 'High' : 'Medium',
      };
    });

  const emergingRisksPool = [
    { risk_title: 'Global commodity price spike — upstream raw material cost pressure on MSME borrowers', timeline: '3-6 months' },
    { risk_title: 'RBI rate hike cycle — floating-rate MSME book repricing stress on cash flows', timeline: '6-9 months' },
    { risk_title: 'Real estate sector cooling — developer loan book collateral value erosion', timeline: '6-12 months' },
    { risk_title: 'Export slowdown (US/EU demand dip) — textile and gems exporters NPA risk', timeline: '3-6 months' },
    { risk_title: 'Climate risk — kharif season drought impacting agri-lending portfolio', timeline: '1-3 months' },
    { risk_title: 'GST compliance tightening — supply-chain disruption in trading sector borrowers', timeline: '2-4 months' },
  ];

  const emerging_risks = emergingRisksPool
    .sort(() => rng() - 0.5)
    .slice(0, 3)
    .map((r) => ({
      risk_title: r.risk_title,
      affected_portfolio_pct: round(4 + rng() * 18, 1),
      potential_loss_cr: round(85 + rng() * 640, 0),
      timeline: r.timeline,
      risk_level: pick(['High', 'High', 'Critical', 'Medium'], rng),
    }));

  const hhi_label = hhi_index > 0.15 ? 'highly concentrated' : hhi_index > 0.10 ? 'moderately concentrated' : 'adequately diversified';

  const key_findings = [
    `Portfolio health score of ${portfolio_health_score}/100 — ${portfolio_health_score < 65 ? 'below acceptable threshold; board review recommended' : 'within acceptable range; continue monitoring'}`,
    `HHI concentration index at ${hhi_index} (${hhi_label}) — ${sector_concentration_breaches.length} sector(s) breaching internal exposure limits`,
    `Single borrower limit breaches: ${single_borrower_limit_breaches} account(s) — RBI large-exposure framework compliance review required`,
    `Top 20 borrowers constitute ${round(28 + rng() * 22, 1)}% of total credit outstanding — granularity improvement needed`,
  ];

  const portfolio_recommendations = [
    `Reduce infrastructure sector exposure by ${round(sector_concentration_breaches[0]?.breach_pp ?? 1.5, 1)} pp over next 2 quarters via selective repayment and new-approval restrictions`,
    `Increase retail and SME lending share to improve HHI — target HHI below 0.10 by year-end`,
    `Implement enhanced stress-testing framework covering all ${emerging_risks.length} identified emerging risk scenarios`,
    `Present concentration breach remediation plan to risk committee by next board cycle with 90-day reduction milestones`,
  ];

  return {
    generated_at: asOf.toISOString(),
    portfolio_health_score,
    hhi_index,
    single_borrower_limit_breaches,
    confidence_score,
    sector_concentration_breaches,
    emerging_risks,
    key_findings,
    portfolio_recommendations,
  };
}

// ---------------------------------------------------------------------------
// Aggregated Summary
// ---------------------------------------------------------------------------

export interface BankingAgentsSummary {
  credit_risk: CreditRiskAgentReport;
  fraud: BankingFraudAgentReport;
  collections: CollectionsAgentReport;
  portfolio: PortfolioRiskAgentReport;
}

export function buildBankingAgentsSummary(tenant: string, asOf: Date): BankingAgentsSummary {
  return {
    credit_risk: buildCreditRiskReport(tenant, asOf),
    fraud: buildFraudAgentReport(tenant, asOf),
    collections: buildCollectionsReport(tenant, asOf),
    portfolio: buildPortfolioRiskReport(tenant, asOf),
  };
}
