// web/src/components/copilot/copilotEngine.ts
//
// ZorEWS Copilot — client-side enterprise knowledge engine.
// Generates intelligent, structured responses from query patterns + page context.
// All synthesis is deterministic (no external AI call required for demo).
// The existing /v1/copilot/chat API is still used as the primary path;
// this engine enriches the SPA-side experience before/after the API call.
//
// ── Knowledge Intelligence Layer (additive, 100% backward compatible) ──
// Phase 1:  Platform Knowledge Registry  → copilotKnowledgeRegistry.ts
// Phase 2:  Full Module Coverage         → MODULE_REGISTRY (30+ modules)
// Phase 3:  Module Explainability        → module_explain intent
// Phase 4:  Workflow Explainability      → workflow_explain intent
// Phase 5:  Screen Awareness             → pageSummaryResponse uses registry
// Phase 6:  Navigation Assistant         → navigateResponse uses NavCatalog
// Phase 7:  Role-Based Training          → role_training intent
// Phase 8:  Contextual Page Summaries    → smart fallback (no generic responses)
// Phase 9:  Knowledge Graph              → 4 catalog files
// Phase 10: Smart Fallback Engine        → fallbackResponse always meaningful

import type { ChatContext } from '@/store/chat';

// ── Knowledge Intelligence Layer imports ─────────────────────────────────
import {
  MODULE_REGISTRY,
  findModuleByRoute,
  findModuleById,
  searchModules,
} from './copilotKnowledgeRegistry';
import {
  findWorkflow,
  formatWorkflowResponse,
  searchWorkflows,
} from './copilotWorkflowCatalog';
import {
  searchNavEntries,
  NAV_CATALOG,
} from './copilotNavigationCatalog';
import {
  findRoleGuide,
  formatRoleGuideResponse,
} from './copilotRoleGuideCatalog';
// ── Enterprise Brain Layer imports (Phase 1-9) ────────────────────────────
import { detectLanguage, formatConceptResponse } from './copilotLanguageEngine';
import { findConcept } from './copilotConceptDictionary';
import { reasonAndRespond } from './copilotReasoningEngine';

// ─── Types ────────────────────────────────────────────────────────────────

export interface CopilotResponse {
  reply: string;
  suggestions: string[];
  /** Optional structured sections for rich rendering */
  sections?: ResponseSection[];
  /** Navigation actions the user can click */
  actions?: CopilotAction[];
}

export interface ResponseSection {
  title: string;
  items: string[];
  type?: 'bullets' | 'metrics' | 'links' | 'alert';
}

export interface CopilotAction {
  label: string;
  href: string;
  icon?: string;
}

export interface WelcomeSnapshot {
  criticalAlerts: number;
  highRiskAccounts: number;
  activeInvestigations: number;
  complianceGaps: number;
  securityEvents: number;
  recoveryEvents: number;
  priorities: string[];
}

// ─── PRNG (same as commandCenterEngine) ──────────────────────────────────

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
function rngFor(scope: string): () => number {
  return mulberry32(fnv1a(scope));
}
function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Welcome Snapshot ────────────────────────────────────────────────────

export function getWelcomeSnapshot(tenantId = 'BANK_DEMO'): WelcomeSnapshot {
  const rng = rngFor(`cop:snap:${tenantId}:${dayKey()}`);
  return {
    criticalAlerts:       Math.round(3 + rng() * 12),
    highRiskAccounts:     Math.round(18 + rng() * 80),
    activeInvestigations: Math.round(8 + rng() * 35),
    complianceGaps:       Math.round(2 + rng() * 10),
    securityEvents:       Math.round(1 + rng() * 8),
    recoveryEvents:       Math.round(1 + rng() * 6),
    priorities: [
      'Review critical fraud cluster in MSME segment',
      'Approve 2 escalated investigation cases',
      'RBI monthly AML filing — 8 days remaining',
      'NPA early warning: 8 borrowers above threshold',
      'Security anomaly: after-hours admin access detected',
    ],
  };
}

// ─── Intent Detection ────────────────────────────────────────────────────

type Intent =
  | 'executive_summary'
  | 'risk_explain'
  | 'search_customer'
  | 'search_case'
  | 'search_alert'
  | 'search_loan'
  | 'search_policy'
  | 'investigations'
  | 'compliance'
  | 'predictive'
  | 'security'
  | 'governance'
  | 'iam'
  | 'rules'
  | 'recovery'
  | 'data_fabric'
  | 'digital_twin'
  | 'autonomous'
  | 'ai_decisioning'
  | 'integration'
  | 'reporting'
  | 'operations'
  | 'navigate'
  | 'daily_brief'
  | 'forecast'
  | 'tenant_bench'
  | 'alert_radar'
  | 'page_summary'
  | 'capabilities'
  // ── Knowledge Intelligence Layer new intents ──
  | 'module_explain'    // "What is Data Ingestion?" / "Explain Investigation Center"
  | 'workflow_explain'  // "How does alert lifecycle work?" / "Explain maker-checker"
  | 'role_training'     // "I am a Risk Analyst" / "Guide for CRO"
  | 'where_to_find'     // "Where can I manage rules?" / "Where is compliance?"
  // ── Enterprise Brain Layer ──
  | 'concept_explain'   // "What is NPA?" / "NPA kya hai?" / "DPD kya hota hai?"
  | 'fallback';

const INTENT_PATTERNS: Array<{ pattern: RegExp; intent: Intent }> = [
  // Executive
  { pattern: /executive\s+summar|exec\s+brief|board\s+brief|ceo\s+update/i, intent: 'executive_summary' },
  { pattern: /daily\s+brief|morning\s+brief|today'?s?\s+(risk|summar|priorit)/i, intent: 'daily_brief' },
  // Explain risk
  { pattern: /why\s+(is|did|was|are)|explain\s+(this|the|risk|alert|predict|score|increas)/i, intent: 'risk_explain' },
  { pattern: /what\s+(drove|caused|is\s+driving|increased|made)/i, intent: 'risk_explain' },
  // Entity search
  { pattern: /customer\s+[a-z0-9_-]{4,}|cust[omer]*\s*[#:]?\s*[0-9]{3,}/i, intent: 'search_customer' },
  { pattern: /loan\s+[a-z0-9_-]{4,}|ln[-_][0-9]/i, intent: 'search_loan' },
  { pattern: /polic[y]?\s+[a-z0-9_-]{4,}|pol[-_][0-9]/i, intent: 'search_policy' },
  { pattern: /case\s+[a-z0-9_-]{4,}|case[-_#][0-9]/i, intent: 'search_case' },
  { pattern: /alert\s+[a-z0-9_-]{4,}|alt[-_][0-9]/i, intent: 'search_alert' },
  // Investigations
  { pattern: /investigation|open\s+case|pending\s+(invest|case|evidence)|fraud\s+invest/i, intent: 'investigations' },
  // Compliance
  { pattern: /compliance|rbi|basel|aml|kyc|irdai|filing|regulation|audit\s+read/i, intent: 'compliance' },
  // Predictive
  { pattern: /predict|forecast|npa|outlook|30\s*day|90\s*day|risk\s+forecast/i, intent: 'predictive' },
  // Security
  { pattern: /securit|anomal|access\s+(log|event)|threat|breach|intrusion/i, intent: 'security' },
  // Governance
  { pattern: /governance|domain\s+control|tenant\s+govern/i, intent: 'governance' },
  // IAM
  { pattern: /\biam\b|access\s+control|user\s+role|permission|rbac/i, intent: 'iam' },
  // Rules
  { pattern: /rule\s+engine|ews\s+rule|rule\s+fire|trigger\s+rule/i, intent: 'rules' },
  // Recovery
  { pattern: /recover|soft\s+delet|restore|purge|archive/i, intent: 'recovery' },
  // Data Fabric
  { pattern: /data\s+fabric|lineage|catalog|pipeline|etl|dq|data\s+quality/i, intent: 'data_fabric' },
  // Digital Twin
  { pattern: /digital\s+twin|simulat|scenario/i, intent: 'digital_twin' },
  // Autonomous / Agents
  { pattern: /autonomous|agent|auto\s*risk|ai\s+agent/i, intent: 'autonomous' },
  // AI Decisioning
  { pattern: /ai\s+decis|decisioning|decision\s+ai|ml\s+decis/i, intent: 'ai_decisioning' },
  // Integration
  { pattern: /integrat|api\s+market|connector|webhook|adapter/i, intent: 'integration' },
  // Reporting
  { pattern: /report|export|schedule|board\s+pack|exec\s+report/i, intent: 'reporting' },
  // Operations
  { pattern: /operations?\s+center|uptime|incident|deploy|ops/i, intent: 'operations' },
  // Forecast
  { pattern: /forecast|60\s*day|90\s*day|180\s*day/i, intent: 'forecast' },
  // Alert radar
  { pattern: /alert\s+(radar|count|summar)|how\s+many\s+alert/i, intent: 'alert_radar' },
  // Navigate
  { pattern: /open|go\s+to|navigate|show\s+me\s+the?\s+(\w+)\s+(center|page|dashboard)/i, intent: 'navigate' },
  // Page summary
  { pattern: /summar(ise|ize)\s+this|what\s+(is\s+)?this\s+page|explain\s+this\s+page/i, intent: 'page_summary' },
  // Capabilities
  { pattern: /what\s+can\s+you|how\s+do\s+you\s+work|capabilities|help/i, intent: 'capabilities' },
  // Tenant bench
  { pattern: /benchmark|compare\s+(tenant|bank|insurer)|peer\s+comparison/i, intent: 'tenant_bench' },
  // ── Knowledge Intelligence Layer ──────────────────────────────────────
  // Module explainability
  { pattern: /what\s+is\s+(data\s+ingestion|investigation\s+center|data\s+fabric|digital\s+twin|predictive\s+risk|recovery\s+center|audit\s+center|ai\s+governance|autonomous\s+risk|ai\s+decisioning|integration\s+marketplace|event\s+streaming|board\s+reporting|operations\s+center|iam\s+center|rule\s+(engine|center)|governance\s+center|notification|data\s+quality|data\s+profiling|data\s+catalog|executive\s+cockpit|role.based\s+dashboard)/i, intent: 'module_explain' },
  { pattern: /explain\s+(the\s+)?(data\s+ingestion|investigation|data\s+fabric|digital\s+twin|predictive|recovery\s+center|audit|ai\s+governance|autonomous|decisioning|integration|event\s+streaming|board\s+reporting|operations|iam|rule\s+engine|governance|notification|data\s+quality|data\s+profiling|data\s+catalog|executive\s+cockpit|compliance\s+center|security\s+center)/i, intent: 'module_explain' },
  { pattern: /why\s+do\s+we\s+need|what\s+does\s+.+\s+(do|center)\s*\?|purpose\s+of|how\s+does\s+.+\s+center\s+work/i, intent: 'module_explain' },
  { pattern: /tell\s+me\s+about\s+(data|alert|case|invest|compliance|predict|govern|ai|integrat|recovery|audit|rule|security|iam|report|operation|board|event|stream|fabric|twin|autonomous|decisioning|notif)/i, intent: 'module_explain' },
  // Workflow explainability
  { pattern: /how\s+does\s+(alert|case|invest|compliance|recovery|maker.checker|ai\s+decis|npa|data\s+ingestion|model\s+promot)\s+(lifecycle|workflow|work|flow|process)/i, intent: 'workflow_explain' },
  { pattern: /explain\s+(alert|case|investigation|compliance|recovery|maker.checker|npa\s+early.warning|model\s+promot)\s+(lifecycle|workflow|work|flow|process)/i, intent: 'workflow_explain' },
  { pattern: /step.by.step|complete\s+(flow|process|workflow)|walk\s+me\s+through/i, intent: 'workflow_explain' },
  { pattern: /how\s+(maker.checker|4.eyes|four.eyes|segregation)\s+work/i, intent: 'workflow_explain' },
  // Role-based training
  { pattern: /i\s+(am\s+a?|'m\s+a?|work\s+as)\s+(risk\s+analyst|fraud\s+analyst|collection\s+officer|supervisor|cro|executive|compliance\s+officer|auditor|admin|branch\s+manager|recovery\s+manager)/i, intent: 'role_training' },
  { pattern: /guide\s+for\s+(risk\s+analyst|fraud\s+analyst|collection|supervisor|cro|executive|compliance|auditor|admin)/i, intent: 'role_training' },
  { pattern: /training\s+(for|guide)|role\s+guide|what\s+should\s+(a|an)\s+(risk\s+analyst|fraud|collection|supervisor|cro|compliance|auditor)\s+(do|focus|use)/i, intent: 'role_training' },
  // Navigation
  { pattern: /where\s+(can\s+i|do\s+i|is|are)\s+(manage|see|find|view|configure|check|access|navigate|go\s+to)/i, intent: 'where_to_find' },
  { pattern: /where\s+is\s+(compliance|rules|alerts|cases|investigations|dashboard|reports|iam|governance|security|recovery|audit|ai|model|integration|data|operations|notification|streaming)/i, intent: 'where_to_find' },
  // ── Enterprise Brain Layer — multilingual concept detection ───────────
  // Hindi/Hinglish concept queries
  { pattern: /\b(npa|sma|dpd|ews|ltv|dscr|crar|ecl|ifrs9|basel|pd\b|lgd|ead|raroc|ots|sarfaesi|write.off)\b.*(kya|hai|matlab|matlab\s+kya|means|explain)/i, intent: 'concept_explain' },
  { pattern: /(kya\s+(h(ai|ota|oti)|hota|hoti|hote))\s+(npa|sma|dpd|ews|kyc|aml|sar|persistency|lapse|solvency|crar|ecl|ifrs9|claims\s+ratio|shap|psi|rwa|sarfaesi|ots|write.off|fraud\s+ring|channel\s+risk|data\s+lineage|audit\s+trail|maker.checker|rbac)/i, intent: 'concept_explain' },
  // English concept queries (broad)
  { pattern: /what\s+is\s+(an?\s+|the\s+)?(npa|sma|dpd|ews|ltv|dscr|crar|ecl|ifrs9|basel|probability\s+of\s+default|loss\s+given\s+default|exposure\s+at\s+default|ots|sarfaesi|write.off|fraud\s+ring|synthetic\s+identity|aml|kyc|sar|persistency|lapse\s+rate|claims\s+ratio|solvency\s+ratio|reinsurance|irdai|channel\s+risk|underwriting|stress\s+testing|raroc|shap|model\s+drift|psi|data\s+lineage|audit\s+trail|maker.checker|rbac|hash\s+chain|api\s+gateway|operational\s+risk|recovery\s+rate|credit\s+risk|portfolio\s+concentration|data\s+quality|digital\s+twin|autonomous\s+agent|integration\s+pipeline)/i, intent: 'concept_explain' },
  { pattern: /define|meaning\s+of|explain\s+the\s+concept|what\s+does\s+(npa|sma|dpd|ecl|crar|shap|psi|dscr|ltv|ods|ots)\s+(mean|stand|refer)/i, intent: 'concept_explain' },
];

export function detectIntent(query: string): Intent {
  for (const { pattern, intent } of INTENT_PATTERNS) {
    if (pattern.test(query)) return intent;
  }
  return 'fallback';
}

// ─── Dynamic Suggestions by Page ─────────────────────────────────────────

const PAGE_SUGGESTIONS: Record<string, string[]> = {
  dashboard: [
    'Executive summary',
    'Show top emerging risks',
    'Alert radar today',
    'Predictive forecast 90 days',
  ],
  alerts: [
    'Summarise all critical alerts',
    'Why is alert ALT-001 flagged?',
    'Show SLA breach alerts',
    'Open investigation from top alert',
  ],
  customer: [
    'Why is this customer high risk?',
    'Explain the risk score factors',
    'Show linked investigations',
    'What is the NPA probability?',
  ],
  customers: [
    'Show high risk borrowers',
    'Which customer has highest exposure?',
    'Filter by SMA classification',
    'Predictive NPA list',
  ],
  case: [
    'Summarise this case',
    'Show pending evidence',
    'Recommend next action',
    'Check SLA breach status',
  ],
  cases: [
    'Show open investigations',
    'Escalated cases today',
    'Pending maker-checker approvals',
    'SLA breach cases',
  ],
  rules: [
    'Which rules fired today?',
    'Show high-frequency rules',
    'Explain rule logic',
    'Rules for MSME segment',
  ],
  scenario: [
    'Run RBI severely adverse scenario',
    'Compare stress scenarios',
    'Show NPA forecast under shock',
    'Portfolio impact of rate hike',
  ],
  reports: [
    'Generate executive report',
    'Schedule daily risk briefing',
    'Export compliance report',
    'Board pack — this month',
  ],
  unknown: [
    'Executive summary',
    'Show pending investigations',
    'Compliance gaps today',
    'Predictive forecast 90d',
  ],
};

export function getSuggestionsForPage(page: string): string[] {
  return PAGE_SUGGESTIONS[page] ?? PAGE_SUGGESTIONS.unknown;
}

// ─── Response Generation ──────────────────────────────────────────────────

export function generateResponse(
  query: string,
  context: ChatContext,
  lastQuery?: string,
): CopilotResponse {
  const intent = detectIntent(query);
  const tenant = 'BANK_DEMO';
  const day = dayKey();

  // Session memory — if last query set a subject, resolve follow-ups
  const resolvedQuery = resolveFollowUp(query, lastQuery);

  switch (intent) {
    case 'executive_summary':
      return execSummary(tenant, day);
    case 'daily_brief':
      return dailyBriefing(tenant, day);
    case 'risk_explain':
      return riskExplain(resolvedQuery, context, tenant, day);
    case 'search_customer':
      return searchEntity('customer', resolvedQuery, tenant, day);
    case 'search_case':
      return searchEntity('case', resolvedQuery, tenant, day);
    case 'search_alert':
      return searchEntity('alert', resolvedQuery, tenant, day);
    case 'search_loan':
      return searchEntity('loan', resolvedQuery, tenant, day);
    case 'search_policy':
      return searchEntity('policy', resolvedQuery, tenant, day);
    case 'investigations':
      return investigationsResponse(tenant, day);
    case 'compliance':
      return complianceResponse(tenant, day);
    case 'predictive':
    case 'forecast':
      return predictiveResponse(tenant, day);
    case 'security':
      return securityResponse(tenant, day);
    case 'governance':
      return governanceResponse(tenant, day);
    case 'iam':
      return iamResponse(tenant, day);
    case 'rules':
      return rulesResponse(tenant, day);
    case 'recovery':
      return recoveryResponse(tenant, day);
    case 'data_fabric':
      return dataFabricResponse(tenant, day);
    case 'digital_twin':
      return digitalTwinResponse(tenant, day);
    case 'autonomous':
      return autonomousResponse(tenant, day);
    case 'ai_decisioning':
      return aiDecisioningResponse(tenant, day);
    case 'integration':
      return integrationResponse(tenant, day);
    case 'reporting':
      return reportingResponse(tenant, day);
    case 'operations':
      return operationsResponse(tenant, day);
    case 'alert_radar':
      return alertRadarResponse(tenant, day);
    case 'tenant_bench':
      return tenantBenchResponse(tenant, day);
    case 'navigate':
    case 'where_to_find':
      return navigateResponse(resolvedQuery);
    case 'page_summary':
      return pageSummaryResponse(context);
    case 'capabilities':
      return capabilitiesResponse();
    // ── Knowledge Intelligence Layer handlers ──────────────────────────
    case 'module_explain':
      return moduleExplainResponse(resolvedQuery);
    case 'workflow_explain':
      return workflowExplainResponse(resolvedQuery);
    case 'role_training':
      return roleTrainingResponse(resolvedQuery);
    // ── Enterprise Brain Layer ────────────────────────────────────────
    case 'concept_explain':
      return conceptExplainResponse(resolvedQuery);
    default:
      return fallbackResponse(query, context);
  }
}

// ─── Session Memory ───────────────────────────────────────────────────────

function resolveFollowUp(query: string, lastQuery?: string): string {
  // If the follow-up is ambiguous (no entity reference) but last query had one,
  // inherit the subject. E.g. "Which one has highest exposure?" → inject last ID.
  if (!lastQuery) return query;
  const followUpPatterns = /^(which|that|the one|this one|what about|show me|explain|why)/i;
  if (!followUpPatterns.test(query.trim())) return query;
  // Try to extract an ID from the last query
  const idMatch = lastQuery.match(/([a-z]+-[0-9]+|[A-Z]{2,}-[0-9]+|\b[0-9]{6,}\b)/);
  if (idMatch) return `${query} (context: ${idMatch[0]})`;
  return query;
}

// ─── Individual Response Builders ─────────────────────────────────────────

function rng(scope: string, day: string) {
  return rngFor(`cop:${scope}:${day}`);
}

function execSummary(tenant: string, day: string): CopilotResponse {
  const r = rng(`exec:${tenant}`, day);
  const riskScore = Math.round(38 + r() * 30);
  const alerts = Math.round(40 + r() * 120);
  const cases = Math.round(12 + r() * 60);
  return {
    reply: `**Enterprise Risk Summary — ${new Date().toLocaleDateString('en-IN', { weekday: 'long', month: 'long', day: 'numeric' })}**\n\nEnterprise Risk Index: **${riskScore}/100** (Elevated)\n• ${alerts} active alerts — ${Math.round(alerts * 0.08)} critical requiring immediate action\n• ${cases} open investigations — ${Math.round(cases * 0.15)} escalated\n• AML compliance: 79% — filing due in 8 days\n• 1 security anomaly: after-hours admin access\n\n**Top Recommendations:**\n1. Escalate MSME fraud cluster to head of risk\n2. Complete AML filing preparation\n3. Review NPA early-warning accounts`,
    suggestions: ['Show top 3 priorities', 'Compliance gaps detail', 'Predictive 90-day forecast', 'Security events today'],
    sections: [
      { title: 'Risk Metrics', type: 'metrics', items: [`Risk Index: ${riskScore}/100`, `Active Alerts: ${alerts}`, `Open Cases: ${cases}`, `Compliance: 79%`] },
      { title: 'Immediate Actions', type: 'bullets', items: ['Escalate MSME fraud cluster', 'Initiate AML filing preparation', 'Review 8 NPA early-warning accounts', 'Investigate after-hours admin access'] },
    ],
    actions: [
      { label: 'Executive Cockpit', href: '/executive-cockpit', icon: 'gauge' },
      { label: 'Investigation Queue', href: '/investigation-center', icon: 'search' },
      { label: 'Compliance Overview', href: '/regulatory-compliance-center', icon: 'shield' },
    ],
  };
}

function dailyBriefing(tenant: string, day: string): CopilotResponse {
  const r = rng(`brief:${tenant}`, day);
  return {
    reply: `**Good ${new Date().getHours() < 12 ? 'Morning' : 'Afternoon'} — Daily Risk Intelligence**\n\nYesterday's changes:\n• Risk score: +2.3 pts → Elevated band\n• New alerts: +${Math.round(5 + r() * 20)} (${Math.round(2 + r() * 5)} critical)\n• Cases closed: ${Math.round(3 + r() * 8)} · Opened: ${Math.round(2 + r() * 10)}\n• Compliance: No new gaps detected\n\nToday's focus: MSME fraud cluster (9.4 Cr exposure), RBI AML filing (8 days), NPA early warning batch (8 accounts).`,
    suggestions: ['Show MSME fraud cluster', 'AML filing status', 'NPA early warning accounts', 'Full executive summary'],
    actions: [
      { label: 'Today\'s Alerts', href: '/alerts', icon: 'bell' },
      { label: 'Predictive Center', href: '/predictive-risk-center', icon: 'trending-up' },
    ],
  };
}

function riskExplain(query: string, context: ChatContext, tenant: string, day: string): CopilotResponse {
  const r = rng(`explain:${tenant}`, day);
  const custId = context.entity?.id ?? query.match(/[a-z0-9_-]{4,}/i)?.[0] ?? 'c-001234';
  const pd = Math.round(62 + r() * 28);
  return {
    reply: `**Risk Explanation — Customer ${custId}**\n\nRisk Score: **${pd}/100** (High band)\nNPA Probability (90d): ${Math.round(pd - 10 + r() * 15)}%\n\n**Top Risk Drivers:**\n1. DPD-30+ detected: 45 days overdue (+32 pts)\n2. Utilisation: 92% of sanctioned limit (+18 pts)\n3. EMI bounce rate: 3 of last 12 (-15 pts)\n4. Bureau score: 612 — Subprime (-12 pts)\n5. Cash withdrawal velocity: +2.4σ above baseline (+9 pts)\n\nHistorical trend: Score increased from 48 → ${pd} over 90 days.\n\n**Recommended Action:** Initiate NPA early warning, engage relationship manager within 5 days.`,
    suggestions: ['Open investigation for this customer', 'Show linked alerts', 'View 90-day forecast', 'Compare with similar accounts'],
    sections: [
      { title: 'SHAP Risk Factors', type: 'metrics', items: [`DPD-30+: +32 pts`, `Utilisation 92%: +18 pts`, `EMI bounce: +15 pts`, `Bureau 612: +12 pts`, `Cash velocity: +9 pts`] },
    ],
    actions: [
      { label: 'Customer Profile', href: `/customers/${custId}`, icon: 'user' },
      { label: 'Open Investigation', href: '/investigation-center', icon: 'search' },
    ],
  };
}

function searchEntity(type: string, query: string, tenant: string, day: string): CopilotResponse {
  const r = rng(`search:${type}:${tenant}`, day);
  const idMatch = query.match(/([A-Za-z0-9_-]+[-][A-Za-z0-9_-]+|[0-9]{4,})/);
  const id = idMatch?.[0] ?? `${type.toUpperCase().slice(0, 3)}-${Math.round(1000 + r() * 9000)}`;
  const ENTITY_RESPONSES: Record<string, string> = {
    customer: `**Customer ${id}**\nRisk Band: High · PD Score: ${Math.round(62 + r() * 28)}/100\nOutstanding: ₹${Math.round(10 + r() * 90)}L · DPD: ${Math.round(r() * 45)} days\nActive alerts: ${Math.round(1 + r() * 4)} · Open cases: ${Math.round(r() * 3)}`,
    case: `**Case ${id}**\nStatus: ${['INVESTIGATING', 'ESCALATED', 'PENDING_APPROVAL'][Math.floor(r() * 3)]} · Priority: P${Math.round(1 + r() * 3)}\nAssigned: Risk Analyst · SLA: ${Math.round(2 + r() * 12)}h remaining\nInvestigation type: ${['Fraud', 'NPA', 'KYC', 'AML'][Math.floor(r() * 4)]}`,
    alert: `**Alert ${id}**\nSeverity: ${['Critical', 'High', 'Medium'][Math.floor(r() * 3)]} · Rule: MSME-DPD-30\nRaised: ${Math.round(1 + r() * 48)}h ago · Status: Open\nExposure: ₹${Math.round(5 + r() * 95)}L · Customer: C-${Math.round(100000 + r() * 9999)}`,
    loan: `**Loan ${id}**\nProduct: ${['Term Loan', 'Working Capital', 'MSME', 'Auto'][Math.floor(r() * 4)]}\nOutstanding: ₹${Math.round(5 + r() * 200)}L · DPD: ${Math.round(r() * 60)} days\nNPA Classification: ${r() > 0.7 ? 'Sub-standard' : 'Standard'} · LTV: ${Math.round(60 + r() * 35)}%`,
    policy: `**Policy ${id}**\nProduct: ${['Term Life', 'ULIP', 'Health', 'General'][Math.floor(r() * 4)]} · Premium: ₹${Math.round(10 + r() * 90)}K/yr\nStatus: ${['In Force', 'Lapsed', 'Under Review'][Math.floor(r() * 3)]} · Persistency: ${Math.round(70 + r() * 28)}%\nClaims this year: ${Math.round(r() * 3)}`,
  };
  return {
    reply: ENTITY_RESPONSES[type] ?? `No result found for "${id}". Check the ID and try again.`,
    suggestions: [`Show ${type} details`, `Open ${type} in module`, `Linked alerts`, `Risk history`],
    actions: [{ label: `Open in ${type === 'customer' ? 'Customer Profile' : type === 'case' ? 'Investigation Center' : 'Alert Center'}`, href: type === 'customer' ? `/customers/${id}` : type === 'case' ? '/investigation-center' : '/alerts', icon: 'external-link' }],
  };
}

function investigationsResponse(tenant: string, day: string): CopilotResponse {
  const r = rng(`inv:${tenant}`, day);
  const open = Math.round(18 + r() * 40);
  const escalated = Math.round(open * 0.15);
  const pending = Math.round(open * 0.22);
  return {
    reply: `**Investigation Center — Live Status**\n\nOpen: **${open}** · Escalated: **${escalated}** · Pending Approval: **${pending}**\n\nTop priority cases:\n• CMS-0${Math.round(100 + r() * 899)}: MSME fraud cluster — Escalated · P1\n• CMS-0${Math.round(100 + r() * 899)}: Synthetic identity — Investigating · P1\n• CMS-0${Math.round(100 + r() * 899)}: AML alert — Pending review · P2\n\nAvg resolution time: ${Math.round(18 + r() * 36)}h · SLA breaches: ${Math.round(r() * 5)}`,
    suggestions: ['Show escalated cases', 'Pending approvals', 'SLA breaches today', 'Fraud investigations'],
    actions: [{ label: 'Investigation Center', href: '/investigation-center', icon: 'search' }, { label: 'CMS Cases', href: '/cms/cases', icon: 'folder' }],
  };
}

function complianceResponse(tenant: string, day: string): CopilotResponse {
  const r = rng(`comp:${tenant}`, day);
  return {
    reply: `**Regulatory Compliance — Current Status**\n\nOverall readiness: **${Math.round(82 + r() * 14)}%**\n\n• RBI: ${Math.round(86 + r() * 10)}% — Q2 filing due in 14 days ✓\n• AML: **79%** — Monthly filing due in 8 days ⚠️\n• Basel ICAAP: ${Math.round(89 + r() * 8)}% — On track ✓\n• IRDAI H1 Return: ${Math.round(80 + r() * 12)}% — 3 documents pending ⚠️\n• KYC Review: ${Math.round(83 + r() * 10)}% — 420 accounts pending ⚠️\n\nImmediate action: Complete AML filing preparation. IRDAI H1 documents by end of week.`,
    suggestions: ['AML filing checklist', 'IRDAI pending documents', 'KYC review accounts', 'Full compliance dashboard'],
    actions: [{ label: 'Compliance Center', href: '/regulatory-compliance-center', icon: 'shield' }],
  };
}

function predictiveResponse(tenant: string, day: string): CopilotResponse {
  const r = rng(`pred:${tenant}`, day);
  return {
    reply: `**Predictive Risk Intelligence — 90 Day Outlook**\n\nNPA Forecast: **${Math.round(48 + r() * 10) / 10}%** (↑ from 4.2%) — 8 borrowers above 75% threshold\nFraud Exposure: ₹${Math.round(12 + r() * 8)}Cr — MSME cluster accelerating\nClaims Ratio: **${Math.round(72 + r() * 8)}%** — Inflation impact expected Q3\nPortfolio Risk: ${Math.round(48 + r() * 18)}/100 — Elevated\n\nAI model confidence: ${Math.round(82 + r() * 12)}% · Last updated: 2 hours ago\n\nTop predicted high-risk borrowers: 8 accounts · Total exposure: ₹${Math.round(40 + r() * 80)}Cr`,
    suggestions: ['Show 8 high-risk borrowers', 'NPA simulation', 'Fraud cluster details', '180-day forecast'],
    actions: [{ label: 'Predictive Center', href: '/predictive-risk-center', icon: 'trending-up' }, { label: 'NPA Prediction', href: '/banking/npa-prediction', icon: 'activity' }],
  };
}

function securityResponse(tenant: string, day: string): CopilotResponse {
  const r = rng(`sec:${tenant}`, day);
  return {
    reply: `**Security Activity — Today's Events**\n\nSecurity Score: ${Math.round(78 + r() * 16)}/100 · ${Math.round(2 + r() * 8)} events logged\n\n⚠️ **Anomaly Detected:** After-hours admin access — 11:32 PM (3 attempts)\n✓ Login patterns: Normal for ${Math.round(40 + r() * 80)} users\n✓ API key usage: Within limits\n• ${Math.round(1 + r() * 4)} failed authentication attempts (non-admin)\n• Session anomaly: 1 geographic velocity flag\n\nRecommendation: Review after-hours admin activity immediately.`,
    suggestions: ['After-hours access details', 'Failed auth attempts', 'API key audit', 'Full security log'],
    actions: [{ label: 'Security Center', href: '/admin/security', icon: 'shield' }, { label: 'IAM Center', href: '/admin/iam', icon: 'users' }],
  };
}

function governanceResponse(tenant: string, _day: string): CopilotResponse {
  return {
    reply: `**Governance Center — Overview**\n\nDomain Access: Banking + Insurance · Tenant: ${tenant}\nActive policies: 24 · Last governance review: 3 days ago\nCross-domain integrity: ✓ All checks passing\nTenant isolation: ✓ No cross-tenant data leakage detected\nAudit chain: ✓ Intact (SHA-256 hash verified)\n\nPending governance actions: 2 policy updates require sign-off.`,
    suggestions: ['Policy sign-off queue', 'Tenant audit log', 'Domain access review', 'Data governance report'],
    actions: [{ label: 'Governance Center', href: '/admin/governance', icon: 'settings' }],
  };
}

function iamResponse(tenant: string, day: string): CopilotResponse {
  const r = rng(`iam:${tenant}`, day);
  return {
    reply: `**IAM Center — Access Summary**\n\nActive users: ${Math.round(42 + r() * 180)} · Roles: 6 types\nDormant accounts (>90 days): ${Math.round(2 + r() * 8)} ⚠️\nAPI keys: ${Math.round(8 + r() * 20)} active · ${Math.round(1 + r() * 4)} expiring in 30 days\nFailed login attempts (24h): ${Math.round(2 + r() * 10)}\nMFA enrollment: ${Math.round(82 + r() * 14)}% users enrolled\n\nQuarterly access review: Due in ${Math.round(10 + r() * 50)} days.`,
    suggestions: ['Dormant accounts list', 'Expiring API keys', 'Failed logins report', 'Access review checklist'],
    actions: [{ label: 'IAM Center', href: '/admin/iam', icon: 'users' }, { label: 'Access Control', href: '/admin/access-control', icon: 'lock' }],
  };
}

function rulesResponse(tenant: string, day: string): CopilotResponse {
  const r = rng(`rules:${tenant}`, day);
  return {
    reply: `**Rule Engine — Today's Summary**\n\nActive rules: ${Math.round(28 + r() * 15)} · Fired today: ${Math.round(120 + r() * 300)}\nTop firing rule: MSME-DPD-30 (${Math.round(40 + r() * 80)} triggers)\nFalse positive rate: ${Math.round(12 + r() * 8)}% · Below 25% threshold ✓\nNew rule proposals: ${Math.round(1 + r() * 4)} pending approval\n\nHigh-confidence EWS rules: 15 · Model-backed: 8`,
    suggestions: ['Top firing rules today', 'False positive analysis', 'Pending rule approvals', 'Rule performance report'],
    actions: [{ label: 'Rule Center', href: '/rule-center', icon: 'git-branch' }],
  };
}

function recoveryResponse(tenant: string, day: string): CopilotResponse {
  const r = rng(`rec:${tenant}`, day);
  return {
    reply: `**Recovery Management — Status**\n\nDeleted records: ${Math.round(20 + r() * 80)} · Restored today: ${Math.round(1 + r() * 5)}\nPending recovery approvals: ${Math.round(2 + r() * 6)} (maker-checker)\nAuto-purge scheduled: ${Math.round(3 + r() * 12)} records in 30 days\nRecovery rate: ${Math.round(72 + r() * 22)}%\n\nSLA for recovery: ${Math.round(2 + r() * 8)}h average (target: 4h) ✓`,
    suggestions: ['Pending recovery approvals', 'Purge schedule', 'Recovery analytics', 'Audit trail'],
    actions: [{ label: 'Recovery Center', href: '/recovery-center', icon: 'rotate-ccw' }],
  };
}

function dataFabricResponse(tenant: string, day: string): CopilotResponse {
  const r = rng(`df:${tenant}`, day);
  return {
    reply: `**Data Fabric — Pipeline Status**\n\nActive pipelines: ${Math.round(8 + r() * 12)} · Last run: ${Math.round(1 + r() * 4)}h ago\nData quality score: ${Math.round(88 + r() * 10)}% ✓\nLineage tracked: ${Math.round(120 + r() * 80)} datasets\nCatalog entries: ${Math.round(400 + r() * 200)}\nIngestion health: ${Math.round(94 + r() * 5)}% connectors healthy`,
    suggestions: ['Pipeline health status', 'Data quality issues', 'Lineage for customer 360', 'Ingestion failures'],
    actions: [{ label: 'Data Fabric Center', href: '/data-fabric-center', icon: 'database' }],
  };
}

function digitalTwinResponse(_tenant: string, _day: string): CopilotResponse {
  return {
    reply: `**Digital Twin — Simulation Status**\n\nAvailable scenarios: 10 (RBI Baseline, Adverse, Severely Adverse + more)\nLast simulation: RBI Severely Adverse — Portfolio ECL impact: ₹142Cr\nActive simulation sessions: 2\n\nTop stress-test finding: MSME sector shows highest sensitivity under rate-hike scenario (+200bps → ECL +18%).\n\nRun a new simulation or compare scenarios in the Digital Twin Center.`,
    suggestions: ['Run RBI Severely Adverse', 'Compare scenarios', 'Show ECL impact', 'IRDAI stress test'],
    actions: [{ label: 'Digital Twin Center', href: '/digital-twin-center', icon: 'layers' }],
  };
}

function autonomousResponse(tenant: string, day: string): CopilotResponse {
  const r = rng(`auto:${tenant}`, day);
  return {
    reply: `**Autonomous Risk Operations — Agent Status**\n\nActive agents: 13 · Running: ${Math.round(8 + r() * 5)}\nCredit Risk Agent: ✓ Processing 24 accounts\nFraud Detection Agent: ✓ Cluster analysis running\nCompliance Agent: ⚠️ Waiting for AML data refresh\nClaims Agent: ✓ ${Math.round(3 + r() * 8)} claims under review\n\nAgent recommendations generated: ${Math.round(12 + r() * 30)} (${Math.round(3 + r() * 8)} require human review)`,
    suggestions: ['Agent performance metrics', 'Human approval queue', 'Fraud agent alerts', 'Compliance agent status'],
    actions: [{ label: 'Autonomous Risk Center', href: '/autonomous-risk-center', icon: 'cpu' }],
  };
}

function aiDecisioningResponse(tenant: string, day: string): CopilotResponse {
  const r = rng(`aidec:${tenant}`, day);
  return {
    reply: `**AI Decisioning Layer — Today's Decisions**\n\nDecisions made today: ${Math.round(80 + r() * 200)}\nAuto-approved: ${Math.round(60 + r() * 140)} · Escalated: ${Math.round(5 + r() * 20)}\nModel confidence average: ${Math.round(82 + r() * 14)}%\nTop decision type: Credit approval (${Math.round(40 + r() * 60)} decisions)\n\nExplainability available for all decisions. SHAP factors logged.`,
    suggestions: ['Decision audit trail', 'Escalated decisions', 'Model performance', 'Explainability report'],
    actions: [{ label: 'AI Decisioning Center', href: '/ai-decisioning-center', icon: 'brain-circuit' }],
  };
}

function integrationResponse(tenant: string, day: string): CopilotResponse {
  const r = rng(`int:${tenant}`, day);
  return {
    reply: `**Integration Marketplace — Status**\n\nActive integrations: ${Math.round(14 + r() * 10)} · Healthy: ${Math.round(11 + r() * 8)}\nCBS Connector: ✓ Real-time sync · Latency: ${Math.round(120 + r() * 80)}ms\nBureau Integration: ✓ Daily batch · Last run: 6h ago\nAML Watchlist: ✓ Hourly sync\nIFRS9 Feed: ⚠️ Degraded — ${Math.round(2 + r() * 8)}h delay\n\n${Math.round(1 + r() * 3)} integrations need attention.`,
    suggestions: ['IFRS9 degradation details', 'All integration health', 'SLA breaches', 'API usage report'],
    actions: [{ label: 'Integration Marketplace', href: '/integration-marketplace', icon: 'plug' }],
  };
}

function reportingResponse(_tenant: string, _day: string): CopilotResponse {
  return {
    reply: `**Reporting Center — Available Reports**\n\nScheduled reports: 12 active · Next run: Daily batch at 06:00\nAvailable for export: Executive Summary, RBI Q2 Report, AML Monthly, Claims Quarterly\n\nBoard pack: Due in 14 days · Status: 68% complete\nRegulatory reports: 5 types · 2 with upcoming deadlines\n\nExport formats: PDF, Excel, CSV available.`,
    suggestions: ['Generate executive report', 'Schedule daily briefing', 'Download board pack', 'Compliance reports status'],
    actions: [{ label: 'Reports Center', href: '/reports', icon: 'file-bar-chart' }, { label: 'Board Reporting', href: '/board-reporting-center', icon: 'presentation' }],
  };
}

function operationsResponse(tenant: string, day: string): CopilotResponse {
  const r = rng(`ops:${tenant}`, day);
  return {
    reply: `**Production Operations — System Status**\n\nPlatform health: ${Math.round(96 + r() * 3)}% uptime · All core services online\nActive incidents: ${Math.round(r() * 2)} (${r() < 0.3 ? '1 P2' : 'none critical'})\nAPI latency (p95): ${Math.round(180 + r() * 120)}ms ✓\nBFF response: ${Math.round(45 + r() * 30)}ms · DB: ${Math.round(8 + r() * 15)}ms\nDeploy status: v${Math.round(2 + r())}.${ Math.round(r() * 9)}.${Math.round(r() * 9)} — Stable`,
    suggestions: ['Incident details', 'Performance metrics', 'Service health check', 'Deployment history'],
    actions: [{ label: 'Operations Center', href: '/operations-center', icon: 'settings' }],
  };
}

function alertRadarResponse(tenant: string, day: string): CopilotResponse {
  const r = rng(`ar:${tenant}`, day);
  const crit = Math.round(3 + r() * 10);
  const high = Math.round(20 + r() * 40);
  const med  = Math.round(50 + r() * 80);
  const low  = Math.round(80 + r() * 160);
  return {
    reply: `**Alert Radar — Live Status**\n\n🔴 Critical: **${crit}** (↑${Math.round(r() * 3)} vs yesterday)\n🟠 High: **${high}** (↓${Math.round(r() * 5)} vs yesterday)\n🟡 Medium: **${med}**\n🟢 Low: **${low}**\n\nTotal: ${crit + high + med + low} active alerts\nSLA breaches: ${Math.round(r() * 4)} · Escalations: ${Math.round(crit * 0.3)}\n\nTop alert source: MSME-DPD-30 rule (${Math.round(10 + r() * 30)} triggers today)`,
    suggestions: ['Show critical alerts', 'SLA breach details', 'Escalation history', 'Alert rules report'],
    actions: [{ label: 'Alert Center', href: '/alerts', icon: 'bell' }],
  };
}

function tenantBenchResponse(_tenant: string, day: string): CopilotResponse {
  const r = rng(`bench`, day);
  return {
    reply: `**Peer Benchmark — Anonymous Comparison (Banking)**\n\nYour Risk Score: ${Math.round(42 + r() * 20)}/100\nIndustry median: ${Math.round(48 + r() * 15)}/100\nTop quartile: < 38\n\nYour position:\n• Alert rate: ${Math.round((r() * 10 + r() * 5 * 10) / 10) / 10}/1k accounts — Industry avg: 6.2\n• Fraud rate: ${Math.round(r() * 20)} bps — Industry avg: 18 bps ✓\n• Compliance score: ${Math.round(82 + r() * 12)}% — Industry avg: 79% ✓\n• Recovery rate: ${Math.round(60 + r() * 30)}% — Industry avg: 68%`,
    suggestions: ['Insurance peer benchmark', 'Full benchmark report', 'Risk score improvement plan', 'Best practices'],
    actions: [{ label: 'Executive Cockpit', href: '/executive-cockpit', icon: 'bar-chart' }],
  };
}

function navigateResponse(query: string): CopilotResponse {
  // First: try Knowledge Navigation Catalog (comprehensive)
  const navEntries = searchNavEntries(query);
  if (navEntries.length > 0) {
    const primary = navEntries[0]!;
    const others = navEntries.slice(1, 4);
    const otherLinks = others.map(e => `• [${e.label}](${e.route})`).join('\n');
    return {
      reply: `**Navigate to: ${primary.label}**\n\n${primary.description}\n\nRoute: \`${primary.route}\`${others.length > 0 ? `\n\n**Related modules:**\n${otherLinks}` : ''}`,
      suggestions: [
        'What does this module do?',
        'Show me an overview',
        ...navEntries.slice(1, 3).map(e => e.label),
      ],
      actions: [
        { label: primary.label, href: primary.route, icon: 'external-link' },
        ...others.map(e => ({ label: e.label, href: e.route, icon: 'arrow-right' })),
      ],
    };
  }
  // Fallback: show navigation categories
  const categories = ['risk', 'compliance', 'ai', 'data', 'reporting', 'admin'];
  const sample = categories.flatMap(c => NAV_CATALOG.filter(e => e.category === c).slice(0, 2));
  return {
    reply: `I can navigate to any platform module. Which area are you looking for?\n\n**Risk:** Alert Center, Investigation Center, Predictive Risk, CMS\n**Compliance:** Regulatory Compliance, Audit Center, Board Reporting\n**AI/ML:** AI Governance, Autonomous Risk, Digital Twin, AI Decisioning\n**Data:** Data Ingestion, Data Quality, Data Fabric\n**Admin:** IAM Center, Governance, Security, Operations\n\nJust ask "Where is [module name]?" and I'll guide you there.`,
    suggestions: ['Where is compliance?', 'Where can I manage rules?', 'Where are investigations?', 'Where is AI governance?'],
    actions: sample.slice(0, 4).map(e => ({ label: e.label, href: e.route, icon: 'arrow-right' })),
  };
}

function pageSummaryResponse(context: ChatContext): CopilotResponse {
  const path = context.page ?? 'unknown';

  // Phase 5: Try Knowledge Registry first (comprehensive coverage)
  const module = findModuleByRoute(path === 'unknown' ? '' : `/${path}`);
  if (module) {
    const kpis = module.kpis.slice(0, 4).map(k => `• ${k}`).join('\n');
    const actions = module.keyScreens.slice(0, 3);
    const relatedNames = module.relatedModules.slice(0, 3).join(', ');
    return {
      reply: `**${module.name}**\n\n${module.purpose}\n\n**Business Objective:** ${module.businessObjective}\n\n**Key KPIs:**\n${kpis}\n\n**Main Screens:** ${actions.join(' · ')}\n\n**Related modules:** ${relatedNames}\n\n*Users: ${module.users.join(', ')}*`,
      suggestions: module.exampleQuestions.slice(0, 4),
      sections: [
        { title: 'Inputs', type: 'bullets', items: module.inputs.slice(0, 4) },
        { title: 'Outputs', type: 'bullets', items: module.outputs.slice(0, 4) },
      ],
      actions: (Array.isArray(module.route)
        ? [{ label: module.name, href: module.route[0]!, icon: 'external-link' }]
        : [{ label: module.name, href: module.route, icon: 'external-link' }]
      ),
    };
  }

  // Phase 8: Legacy page key fallback (backward compat)
  const PAGE_SUMMARIES: Record<string, string> = {
    dashboard: 'This is the **Enterprise Risk Command Center** — your single view of portfolio-wide risk. It shows the Enterprise Risk Index, executive briefing, emerging risks, heat map, forecast strip, and AI-powered insights across all connected modules.',
    alerts: 'This is the **Alert Management Center**. It shows all risk alerts across the portfolio, filtered by severity (Critical/High/Medium/Low). You can acknowledge alerts, create investigations, and track SLA compliance.',
    customer: 'This is the **Customer Risk Profile** page. It shows the complete risk picture for this borrower: PD score, SHAP explainability, linked alerts, open cases, and predictive outlook.',
    customers: 'This is the **Customer Intelligence Center**. It lists all monitored customers with risk scores, exposure, and DPD metrics. Filter by risk band, segment, or SMA classification.',
    case: 'This is the **Case Management** view for an individual case. It shows the full investigation lifecycle, evidence, timeline, and maker-checker approvals.',
    cases: 'This is the **Case Management System (CMS)**. It shows all open investigations across fraud, NPA, KYC, and compliance categories.',
    rules: 'This is the **Rule Engine Center**. It manages EWS rules — their conditions, firing frequency, and performance metrics.',
    scenario: 'This is the **Scenario Simulation Engine (Digital Twin)**. Run stress tests based on RBI/IRDAI macroeconomic scenarios (GDP shock, rate hike, FX devaluation) and see portfolio impact on ECL and NPA.',
    reports: 'This is the **Enterprise Reporting Center**. Schedule, generate, and export regulatory and executive reports in PDF/Excel/CSV format.',
  };
  const summary = PAGE_SUMMARIES[path];
  if (summary) {
    return {
      reply: summary,
      suggestions: getSuggestionsForPage(path).slice(0, 4),
    };
  }

  // Phase 10: Smart fallback — search catalog by path keywords, never generic
  const pathKeywords = path.replace(/[-_]/g, ' ').replace(/\//g, ' ');
  const matches = searchModules(pathKeywords);
  if (matches.length > 0) {
    const m = matches[0]!;
    return {
      reply: `**${m.name}**\n\n${m.summary}\n\n**Purpose:** ${m.purpose}\n\n**Key users:** ${m.users.join(', ')}\n\n**Main KPIs:** ${m.kpis.slice(0, 3).join(' · ')}`,
      suggestions: m.exampleQuestions.slice(0, 4),
    };
  }

  // Absolute last resort — still meaningful, never "page not supported"
  return {
    reply: `**ZorEWS Platform — Current Page Context**\n\nYou are on: \`${path}\`\n\nI can help you understand any platform module, navigate anywhere, or answer risk questions.\n\nTry:\n• "What is this page?" — I'll explain the current module\n• "Show me navigation options" — I'll list all available centers\n• "Executive summary" — Get today's risk briefing\n• "How does [workflow] work?" — Step-by-step explanations`,
    suggestions: getSuggestionsForPage(path).slice(0, 4),
    actions: [
      { label: 'All Modules', href: '/', icon: 'layout-dashboard' },
      { label: 'Navigation Help', href: '/dashboards/role-based', icon: 'compass' },
    ],
  };
}

function capabilitiesResponse(): CopilotResponse {
  return {
    reply: `**ZorEWS Copilot — Enterprise Risk Intelligence Assistant**\n\nI\'m connected to all 16 enterprise centers. Here\'s what I can do:\n\n🔍 **Universal Search** — Find customers, cases, alerts, loans, policies by ID\n📊 **Executive Intelligence** — Daily briefings, risk summaries, board reports\n🧠 **Risk Explainability** — SHAP factors, why-is-this-high-risk analysis\n🔭 **Predictive Insights** — NPA forecasts, fraud predictions, 90-180 day outlook\n⚡ **Cross-Center Correlation** — Alert → Investigation → Compliance linking\n🚀 **Navigation** — Open any enterprise center instantly\n📋 **Compliance Status** — RBI, Basel, AML, KYC, IRDAI readiness\n🛡️ **Security Events** — Anomalies, access logs, threat indicators\n\nTry: "Executive summary", "customer 100245", "show compliance gaps", or "Why is risk elevated?"`,
    suggestions: ['Executive summary', 'Show open investigations', 'Compliance gaps', 'Predictive forecast'],
    actions: [
      { label: 'Executive Cockpit', href: '/executive-cockpit', icon: 'gauge' },
      { label: 'Predictive Center', href: '/predictive-risk-center', icon: 'trending-up' },
    ],
  };
}

// ─── Enterprise Brain: Concept Explain ───────────────────────────────────

function conceptExplainResponse(query: string): CopilotResponse {
  const lang = detectLanguage(query);
  const concept = findConcept(query);
  if (concept) {
    return {
      reply: formatConceptResponse(concept, lang),
      suggestions: concept.relatedTerms.slice(0, 2).map(t =>
        lang === 'hi' ? `${t} क्या है?` : lang === 'hinglish' ? `${t} kya hai?` : `What is ${t}?`
      ).concat(
        lang === 'hi' ? ['संबंधित मॉड्यूल दिखाएं', 'इसका workflow क्या है?']
        : lang === 'hinglish' ? ['Related modules dikhao', 'Iska workflow kya hai?']
        : ['Show related modules', `How does ${concept.term} work?`]
      ),
      sections: [
        {
          title: lang === 'hi' ? 'संबंधित अवधारणाएं' : 'Related Concepts',
          type: 'bullets',
          items: concept.relatedTerms,
        },
      ],
      actions: concept.relatedModules.slice(0, 2).map(m => {
        const mod = MODULE_REGISTRY.find(mr => mr.name.toLowerCase().includes(m.toLowerCase().split(' ')[0]!));
        return { label: m, href: mod ? (Array.isArray(mod.route) ? mod.route[0]! : mod.route) : '/', icon: 'external-link' };
      }),
    };
  }
  // Use reasoning engine as fallback
  return reasonAndRespond(query);
}

function fallbackResponse(query: string, context: ChatContext): CopilotResponse {
  const page = context.page ?? 'unknown';
  const q = query.toLowerCase();

  // Phase 10 + Enterprise Brain: Smart Fallback — NEVER return generic responses

  // 0. Enterprise Brain — concept dictionary (200+ BFSI terms)
  const concept = findConcept(q);
  if (concept) {
    const lang = detectLanguage(query);
    return {
      reply: formatConceptResponse(concept, lang),
      suggestions: concept.relatedTerms.slice(0, 2).map(t =>
        lang === 'hi' ? `${t} क्या है?` : lang === 'hinglish' ? `${t} kya hai?` : `What is ${t}?`
      ).concat(['Show related modules', 'Executive summary']),
    };
  }

  // 0.5 Enterprise Brain — Reasoning Engine (multilingual + domain inference)
  const reasoned = reasonAndRespond(q, context.page ? `/${context.page}` : undefined);
  if (reasoned && reasoned.reply && !reasoned.reply.includes('ZorEWS Copilot is your enterprise knowledge brain')) {
    return reasoned;
  }

  // 1. Search module catalog
  const moduleMatches = searchModules(q);
  if (moduleMatches.length > 0) {
    const m = moduleMatches[0]!;
    return {
      reply: `**${m.name}**\n\n${m.summary}\n\n**Purpose:** ${m.purpose}\n\n**Users:** ${m.users.join(', ')}\n\n**Key KPIs:** ${m.kpis.slice(0, 3).join(' · ')}`,
      suggestions: m.exampleQuestions.slice(0, 4),
      actions: (Array.isArray(m.route)
        ? [{ label: `Open ${m.name}`, href: m.route[0]!, icon: 'external-link' }]
        : [{ label: `Open ${m.name}`, href: m.route, icon: 'external-link' }]
      ),
    };
  }

  // 2. Search workflow catalog
  const workflowMatches = searchWorkflows(q);
  if (workflowMatches.length > 0) {
    const w = workflowMatches[0]!;
    return {
      reply: formatWorkflowResponse(w),
      suggestions: [`Navigate to ${w.name}`, 'What are the actors?', 'Show related module', 'How long does this take?'],
      actions: [{ label: w.name, href: w.route, icon: 'git-branch' }],
    };
  }

  // 3. Search navigation catalog
  const navMatches = searchNavEntries(q);
  if (navMatches.length > 0) {
    const n = navMatches[0]!;
    return {
      reply: `**I found a relevant module:** ${n.label}\n\n${n.description}\n\nClick below to navigate there, or ask me to explain what this module does.`,
      suggestions: [`What does ${n.label} do?`, 'Executive summary', 'Show all modules', 'Navigation help'],
      actions: [{ label: n.label, href: n.route, icon: 'external-link' }],
    };
  }

  // 4. Context-aware response based on current page
  const pageModule = findModuleByRoute(page === 'unknown' ? '' : `/${page}`);
  if (pageModule) {
    return {
      reply: `I'm on the **${pageModule.name}** page. For your query "${query.slice(0, 60)}${query.length > 60 ? '...' : ''}" — let me help you with what this module offers:\n\n${pageModule.summary}\n\nYou can ask me:\n${pageModule.exampleQuestions.slice(0, 4).map(q => `• "${q}"`).join('\n')}`,
      suggestions: pageModule.exampleQuestions.slice(0, 4),
    };
  }

  // 5. Helpful fallback with specific suggestions — never "I don't know"
  return {
    reply: `I understand you're asking: *"${query.slice(0, 80)}${query.length > 80 ? '...' : ''}"*\n\nLet me help you navigate this. ZorEWS has **30+ enterprise modules** covering:\n\n🔴 **Risk:** Alert Center, Predictive Risk, Investigation Center, CMS\n🟡 **Compliance:** Regulatory Compliance, Audit Center, Board Reporting\n🔵 **AI/ML:** AI Governance, Autonomous Risk, Digital Twin, AI Decisioning\n🟢 **Data:** Data Ingestion, Data Quality, Data Fabric, Data Profiling\n⚙️ **Admin:** IAM, Security, Operations, Integration Marketplace\n\n**Try:**\n• "What is [module name]?" to understand any module\n• "How does [workflow] work?" for step-by-step explanations\n• "I am a [your role]" for personalized guidance\n• "Where can I find [topic]?" for navigation`,
    suggestions: [
      getSuggestionsForPage(page)[0] ?? 'Executive summary',
      'What modules does ZorEWS have?',
      'How does alert lifecycle work?',
      'Navigation help',
    ],
    actions: [
      { label: 'Dashboard', href: '/', icon: 'layout-dashboard' },
      { label: 'Alert Center', href: '/alerts', icon: 'bell' },
    ],
  };
}

// ─── Knowledge Intelligence Layer Response Builders ────────────────────────

function moduleExplainResponse(query: string): CopilotResponse {
  // Search by query
  const matches = searchModules(query);
  if (matches.length === 0) {
    // Try to find by module name keywords
    const q = query.toLowerCase();
    const found = MODULE_REGISTRY.find(m =>
      q.includes(m.name.toLowerCase().replace(' center', '').replace(' management', '').trim()) ||
      m.id.split('_').some(part => q.includes(part))
    );
    if (found) matches.push(found);
  }

  if (matches.length === 0) {
    // Provide a list of all modules as a helpful response
    const moduleList = MODULE_REGISTRY.map(m => `• **${m.name}** — ${m.summary.split('.')[0]}`).join('\n');
    return {
      reply: `I can explain any of the following ZorEWS platform modules. Which one would you like to know about?\n\n${moduleList}`,
      suggestions: ['What is Investigation Center?', 'What is Data Fabric?', 'What is AI Governance?', 'What is Predictive Risk?'],
    };
  }

  const m = matches[0]!;
  const kpis = m.kpis.slice(0, 5).map(k => `• ${k}`).join('\n');
  const inputs = m.inputs.slice(0, 4).map(i => `• ${i}`).join('\n');
  const outputs = m.outputs.slice(0, 4).map(o => `• ${o}`).join('\n');
  const screens = m.keyScreens.slice(0, 4).join(' · ');

  return {
    reply: `**${m.name}**\n\n**Purpose:** ${m.purpose}\n\n**Business Objective:** ${m.businessObjective}\n\n**Users:** ${m.users.join(', ')}\n\n**Key Inputs:**\n${inputs}\n\n**Key Outputs:**\n${outputs}\n\n**Key KPIs:**\n${kpis}\n\n**Main Screens:** ${screens}\n\n**Summary:** ${m.summary}`,
    suggestions: m.exampleQuestions.slice(0, 4),
    sections: [
      { title: 'Related Modules', type: 'bullets', items: m.relatedModules.map(r => findModuleById(r)?.name ?? r) },
    ],
    actions: (Array.isArray(m.route)
      ? [{ label: `Open ${m.name}`, href: m.route[0]!, icon: 'external-link' }]
      : [{ label: `Open ${m.name}`, href: m.route, icon: 'external-link' }]
    ),
  };
}

function workflowExplainResponse(query: string): CopilotResponse {
  const workflow = findWorkflow(query);
  if (!workflow) {
    const list = ['Alert Lifecycle', 'Case Workflow', 'Investigation Workflow', 'Maker-Checker Approval', 'Compliance Workflow', 'NPA Early Warning', 'Data Ingestion Flow', 'AI Model Promotion', 'Recovery Workflow'];
    return {
      reply: `I can explain any of these platform workflows in detail:\n\n${list.map(w => `• ${w}`).join('\n')}\n\nAsk "How does [workflow name] work?" for a step-by-step explanation.`,
      suggestions: ['How does alert lifecycle work?', 'How does maker-checker work?', 'How does investigation workflow work?', 'How does NPA early warning work?'],
    };
  }
  return {
    reply: formatWorkflowResponse(workflow),
    suggestions: [
      `Navigate to ${workflow.name.split(' ')[0]} module`,
      'What are the key actors?',
      'What is the SLA for each step?',
      'Related workflows',
    ],
    actions: [{ label: `Open ${workflow.relatedModule.replace('_', ' ')}`, href: workflow.route, icon: 'external-link' }],
  };
}

function roleTrainingResponse(query: string): CopilotResponse {
  const guide = findRoleGuide(query);
  if (!guide) {
    const roles = ['Risk Analyst', 'Fraud Analyst', 'Collection Officer', 'Supervisor', 'CRO / Executive', 'Compliance Officer', 'Auditor', 'Platform Admin'];
    return {
      reply: `I can provide personalized platform guidance for any of these roles:\n\n${roles.map(r => `• ${r}`).join('\n')}\n\nTell me your role: "I am a [role name]" and I'll guide you through responsibilities, key screens, and daily workflows.`,
      suggestions: ['I am a Risk Analyst', 'I am a Compliance Officer', 'I am a CRO', 'I am an Auditor'],
    };
  }
  return {
    reply: formatRoleGuideResponse(guide),
    suggestions: guide.suggestedQuestions.slice(0, 4),
    actions: guide.primaryScreens.slice(0, 3).map(s => ({ label: s.label, href: s.route, icon: 'external-link' })),
  };
}
