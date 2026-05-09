// services/bff/src/copilot/chat.ts
//
// Templated copilot brain. Context-aware but **not** an LLM call — answers
// are pattern-matched against the message + the entity-summary the SPA passes
// in. Pulls feel grounded because the numbers come from the page the user is
// already looking at; intelligence is bounded by the templates here. To swap
// in a real LLM, replace `respond()` with a function that builds a system
// prompt from `ChatContext` and posts to Anthropic / OpenAI.

export type ChatPage =
  | 'dashboard'
  | 'alerts'
  | 'customer'
  | 'case'
  | 'cases'
  | 'rules'
  | 'scenario'
  | 'unknown';

export interface ChatEntitySummary {
  type: 'customer' | 'case' | 'alert' | 'rule';
  id: string;
  /** Short human label shown on screen (e.g. customer name, case id, alert title). */
  label?: string;
  /** Page-derived numbers the brain can mention (PD, severity, DPD, exposure, etc.). */
  facts?: Record<string, string | number | boolean | null>;
}

export interface ChatContext {
  page?: ChatPage;
  entity?: ChatEntitySummary;
  /** Caller's role — useful to tailor recommended actions. */
  role?: string;
}

export interface ChatRequest {
  message: string;
  context?: ChatContext;
}

export interface ChatResponse {
  reply: string;
  /** Up to 4 suggested follow-ups, tailored to the page context. */
  suggestions: string[];
  /** Echo of which context the brain actually used — useful for debugging the UI. */
  used_context: { page: ChatPage; entity_id?: string; matched_intent: Intent };
}

type Intent =
  | 'greeting'
  | 'help'
  | 'risk_score'
  | 'why_high'
  | 'recommend_action'
  | 'summary'
  | 'thanks'
  | 'fallback'
  | 'llm';

const GREETING_RE = /^\s*(hi|hello|hey|hola|namaste|jambo|good (morning|afternoon|evening))\b/i;
const HELP_RE = /\b(help|what can you do|capabilities|how do you work)\b/i;
const RISK_RE = /\b(pd|probability|risk score|score|risk level)\b/i;
const WHY_RE = /\b(why|reason|explain|driver|cause|because|how come)\b/i;
const ACTION_RE = /\b(action|next|recommend|do|step|what should|advice)\b/i;
const SUMMARY_RE = /\b(summary|summarise|summarize|overview|tl;?dr|brief)\b/i;
const THANKS_RE = /\b(thank|thanks|thx|cheers|appreciate)\b/i;

function classify(message: string): Intent {
  if (GREETING_RE.test(message)) return 'greeting';
  if (HELP_RE.test(message)) return 'help';
  if (THANKS_RE.test(message)) return 'thanks';
  if (WHY_RE.test(message)) return 'why_high';
  if (RISK_RE.test(message)) return 'risk_score';
  if (ACTION_RE.test(message)) return 'recommend_action';
  if (SUMMARY_RE.test(message)) return 'summary';
  return 'fallback';
}

function fmtPct(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return `${(value * 100).toFixed(1)}%`;
}

function fmtNumber(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function entityLabel(e: ChatEntitySummary): string {
  return e.label ? `${e.label} (${e.id})` : e.id;
}

function suggestionsFor(page: ChatPage, entity?: ChatEntitySummary): string[] {
  if (entity?.type === 'customer') {
    return [
      'Why is this customer high risk?',
      'What actions should I take?',
      'Summarise this customer',
      'Explain the SHAP drivers',
    ];
  }
  if (entity?.type === 'case') {
    return [
      'What is the case status?',
      'Suggest a next action',
      'Why is this case high severity?',
      'Summarise the action log',
    ];
  }
  switch (page) {
    case 'dashboard':
      return [
        'Summarise today\'s risk posture',
        'What\'s driving the trend?',
        'Top risk segments',
        'How are alerts split by severity?',
      ];
    case 'alerts':
      return [
        'Which alerts need urgent attention?',
        'What is driving the critical alerts?',
        'How do I triage this list?',
        'Summarise the queue',
      ];
    case 'cases':
      return [
        'How many cases are open?',
        'Which cases are stuck?',
        'Suggest a triage order',
      ];
    case 'rules':
      return [
        'Which rules fire most often?',
        'How is the FP rate looking?',
        'Help me draft a new rule',
      ];
    case 'scenario':
      return [
        'How do I run a what-if?',
        'What does shifting threshold X do?',
        'Summarise the last scenario',
      ];
    default:
      return [
        'What can you do?',
        'Summarise the dashboard',
        'Walk me through an alert',
      ];
  }
}

function answerEntityRisk(entity: ChatEntitySummary): string {
  const facts = entity.facts ?? {};
  const pd = fmtPct(facts.pd);
  const level = typeof facts.level === 'string' ? facts.level : null;
  const dpd = fmtNumber(facts.dpd_max_90d ?? facts.worst_dpd);
  const exposure = fmtNumber(facts.exposure ?? facts.total_outstanding);
  const lines: string[] = [];
  if (pd && level) {
    lines.push(`${entityLabel(entity)} has a current PD of ${pd} (${level} risk).`);
  } else if (pd) {
    lines.push(`${entityLabel(entity)} has a current PD of ${pd}.`);
  } else if (level) {
    lines.push(`${entityLabel(entity)} is at ${level} risk.`);
  } else {
    lines.push(`I don\'t have a numeric PD for ${entityLabel(entity)} on this screen.`);
  }
  if (dpd) lines.push(`Worst DPD over the last 90d: ${dpd} days.`);
  if (exposure) lines.push(`Outstanding exposure: ${exposure}.`);
  return lines.join(' ');
}

function answerWhyHigh(entity: ChatEntitySummary): string {
  const reasons = entity.facts?.top_reasons;
  if (Array.isArray(reasons) && reasons.length > 0) {
    const bullets = (reasons as Array<Record<string, unknown>>)
      .slice(0, 3)
      .map((r, i) => {
        const feat = r.feature ?? r.name ?? `factor ${i + 1}`;
        const dir = r.direction === 'protective' ? '↓' : '↑';
        return `  ${i + 1}. ${dir} ${String(feat)}`;
      })
      .join('\n');
    return `Top SHAP drivers for ${entityLabel(entity)}:\n${bullets}\n\nUpward arrows raise PD, downward arrows are protective.`;
  }
  return `For ${entityLabel(entity)} the page doesn\'t expose SHAP reasons, but the usual drivers are recent DPD, utilisation spikes, drops in inflow, and bureau-score deterioration. Open the customer\'s Risk Profile for the SHAP top-5.`;
}

function answerRecommend(entity: ChatEntitySummary, role?: string): string {
  if (entity.type === 'customer') {
    const isField = role === 'field_officer';
    const isCollection = role === 'collection_officer';
    const lines = [
      `For ${entityLabel(entity)} the next step depends on severity:`,
      `  • If PD ≥ 60% — escalate to a case and assign to ${isCollection ? 'yourself' : 'a Collection officer'}.`,
      `  • If PD 30–60% — open a soft-touch outreach (SMS or call) and monitor for 14 days.`,
      `  • If PD < 30% — keep on watch list; re-score at next refresh.`,
    ];
    if (isField) lines.push('  • Field officer: log a visit + GPS-stamped action note.');
    return lines.join('\n');
  }
  if (entity.type === 'case') {
    return `For case ${entityLabel(entity)}: check the action log, attempt outreach (call → SMS → visit), and only close once outcome is known (cured / cured_temp / defaulted). If the case is in 'monitored' for >14 days without contact, log a follow-up to re-engage.`;
  }
  if (entity.type === 'alert') {
    return `For alert ${entityLabel(entity)}: open the customer profile, review the SHAP drivers, then either acknowledge (if false-positive) or open a case (if action is warranted).`;
  }
  return 'Open the affected entity to see specific recommendations.';
}

function answerSummary(ctx: ChatContext): string {
  const { entity, page } = ctx;
  if (entity?.type === 'customer') {
    const facts = entity.facts ?? {};
    const bits: string[] = [`${entityLabel(entity)} —`];
    const pd = fmtPct(facts.pd);
    if (pd) bits.push(`PD ${pd}.`);
    const dpd = fmtNumber(facts.dpd_max_90d ?? facts.worst_dpd);
    if (dpd) bits.push(`Worst DPD ${dpd}d.`);
    const exposure = fmtNumber(facts.exposure ?? facts.total_outstanding);
    if (exposure) bits.push(`Exposure ${exposure}.`);
    if (typeof facts.product === 'string') bits.push(`Product: ${facts.product}.`);
    return bits.join(' ');
  }
  if (entity?.type === 'case') {
    const facts = entity.facts ?? {};
    const state = typeof facts.state === 'string' ? facts.state : 'unknown';
    const severity = typeof facts.severity === 'string' ? facts.severity : 'unknown';
    const actions = fmtNumber(facts.action_count);
    return `${entityLabel(entity)} — state: ${state}, severity: ${severity}${
      actions ? `, ${actions} actions logged` : ''
    }.`;
  }
  if (entity?.type === 'alert') {
    const facts = entity.facts ?? {};
    const sev = typeof facts.severity === 'string' ? facts.severity : 'unknown';
    return `${entityLabel(entity)} — severity ${sev}. ${
      facts.indicators ? `Triggered indicators: ${facts.indicators}.` : ''
    }`.trim();
  }
  switch (page) {
    case 'dashboard':
      return 'On the dashboard you can see customers monitored, high-risk count, active alerts, open cases, an 8-week PD trend, and the alerts-by-severity split. Click a metric to drill in.';
    case 'alerts':
      return 'The alert list shows newest-first, sortable by severity. Critical/high need triage today; medium can wait 24–48h; low is FYI.';
    case 'cases':
      return 'The case list shows everything open across the team. Filter by state (open / assigned / in_action / monitored) to find what needs your attention.';
    default:
      return 'I don\'t have a specific summary for this page yet — try asking about an alert, case, or customer.';
  }
}

const HELP_TEXT = [
  'I\'m the ZorEWS copilot — a context-aware assistant for risk operations.',
  '',
  'I can:',
  '  • Explain a customer\'s PD and the top SHAP drivers',
  '  • Summarise an alert, case, or the dashboard',
  '  • Recommend next actions tailored to your role',
  '  • Help you triage queues by severity',
  '',
  'My answers are templated and grounded in what\'s on the page you\'re looking at — not a free-form LLM (yet).',
].join('\n');

export function respond(req: ChatRequest): ChatResponse {
  const ctx: ChatContext = req.context ?? {};
  const page: ChatPage = ctx.page ?? 'unknown';
  const intent = classify(req.message ?? '');

  let reply: string;
  switch (intent) {
    case 'greeting':
      reply = `Hi! I\'m the ZorEWS copilot. ${
        ctx.entity
          ? `I can see you\'re looking at ${entityLabel(ctx.entity)}.`
          : `What can I help you with on the ${page === 'unknown' ? 'current page' : page} screen?`
      }`;
      break;
    case 'help':
      reply = HELP_TEXT;
      break;
    case 'thanks':
      reply = 'Anytime. Ping me whenever a number on the page needs unpacking.';
      break;
    case 'risk_score':
      reply = ctx.entity
        ? answerEntityRisk(ctx.entity)
        : 'Open a customer or case and I can give you the PD with the SHAP drivers.';
      break;
    case 'why_high':
      reply = ctx.entity
        ? answerWhyHigh(ctx.entity)
        : 'Open a customer profile and I\'ll walk you through the SHAP drivers.';
      break;
    case 'recommend_action':
      reply = ctx.entity
        ? answerRecommend(ctx.entity, ctx.role)
        : 'Tell me which customer, case, or alert you mean and I\'ll suggest a next step.';
      break;
    case 'summary':
      reply = answerSummary(ctx);
      break;
    case 'fallback':
    default:
      reply = `I don\'t have a templated answer for that yet. Try one of the suggestions below — or ask "help" for what I can do.`;
      break;
  }

  return {
    reply,
    suggestions: suggestionsFor(page, ctx.entity),
    used_context: { page, entity_id: ctx.entity?.id, matched_intent: intent },
  };
}

// ────────────────────────────────────────────────────────────────────
// Async wrapper — tries the real LLM first, falls back to the templated
// brain on any error or when ANTHROPIC_API_KEY is unset. Suggestion
// chips are always generated deterministically by suggestionsFor() so
// the SPA's UX doesn't depend on which brain answered.
// ────────────────────────────────────────────────────────────────────

// Lazy-loaded so unit tests that exercise respond() synchronously
// don't pay the cost of pulling in the SDK.
type LlmModule = typeof import('./llm');
let _llm: LlmModule | null | undefined;
function llm(): LlmModule | null {
  if (_llm !== undefined) return _llm;
  try {
    _llm = require('./llm') as LlmModule;
  } catch {
    _llm = null;
  }
  return _llm;
}

export async function respondAsync(req: ChatRequest): Promise<ChatResponse> {
  const m = llm();
  if (m && m.llmAvailable()) {
    try {
      const out = await m.llmRespond(req);
      const page = req.context?.page ?? 'unknown';
      return {
        reply: out.reply,
        suggestions: suggestionsFor(page, req.context?.entity),
        used_context: { page, entity_id: req.context?.entity?.id, matched_intent: 'llm' },
      };
    } catch (err) {
      // Any LLM error → silently fall through to templates. Log once
      // so operators can spot persistent failure (key rotated, 429s, etc).
      // eslint-disable-next-line no-console
      console.warn(
        '[copilot] LLM error, falling back to templates:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  return respond(req);
}
