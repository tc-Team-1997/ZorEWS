// services/bff/src/copilot/llm.ts
//
// Real LLM path for the copilot. Wraps the Anthropic SDK with prompt
// caching on a static APEX-EWS primer; falls back gracefully when
// ANTHROPIC_API_KEY is unset (caller checks llmAvailable() first) or
// when the API errors (caller catches and reverts to templated brain).
//
// Cache placement:
//   tools → system → messages   (render order — invariant)
// We put one ephemeral breakpoint on the LAST static system block. The
// per-request context block lives AFTER the breakpoint, so changing
// page / entity / role does NOT invalidate the primer cache.

import Anthropic from '@anthropic-ai/sdk';
import type { ChatRequest } from './chat';

// ────────────────────────────────────────────────────────────────────
// STATIC SYSTEM PRIMER — frozen across every request.
//
// MINIMUM CACHEABLE PREFIX (silently won't cache below the floor):
//   Opus 4.7   — 4096 tokens
//   Sonnet 4.6 — 2048 tokens
//   Haiku 4.5  — 4096 tokens
//
// If usage.cache_read_input_tokens stays at 0 across warm requests,
// either pad this primer with more domain detail or switch to Sonnet 4.6
// (lower floor + ~5x cheaper for chat workloads).
// ────────────────────────────────────────────────────────────────────
const SYSTEM_PRIMER = `You are the ZorEWS Copilot — a context-aware assistant embedded in
ZorEWS, an Early Warning System for retail and SME credit risk.

# Domain primer
ZorEWS monitors a portfolio of customers for early signs of credit
distress. Pipeline: indicators (30 across FIN/BEH/TXN/CRD families) →
rules → alerts (severity: low | medium | high | critical) → SmartQueue
→ cases. PD scoring uses calibrated XGBoost with SHAP TreeExplainer; the
UI surfaces the top-5 SHAP reasons per customer. Cases progress through
the lifecycle: open → assigned → in_action ↔ monitored → closed, with
outcomes cured / cured_temp / defaulted at close.

# Roles and what each user can do
- admin: full access, including matrix updates and user management.
- supervisor: case oversight, assignment, approval workflows.
- risk_analyst: rule editing, alert triage, customer profile review.
- collection_officer: case assignment, outreach, status callbacks.
- field_officer: GPS-stamped action logging, customer site visits.

# Severity bands and recommended action
- PD < 30%: Low risk — keep on watch list, re-score at next refresh.
- PD 30-60%: Medium risk — soft-touch outreach (SMS or call), monitor
  for 14 days; escalate if behaviour deteriorates.
- PD >= 60%: High risk — escalate to a case, assign to a Collection
  officer, attempt outreach within 48 hours.

# SHAP reasons — how to interpret
Each reason has a feature name, a value, a SHAP contribution, and a
direction. Direction "risk" means the feature pushed PD up; direction
"protective" means the feature pulled PD down. Common drivers:
- dpd_max_90d: max days past due over 90 days. Higher = riskier.
- utilization: exposure-to-income ratio (capped at 1.5). Higher = riskier.
- bureau_score: 200-900 CRB band. Higher = protective.
- repayment_delay_streak: consecutive months of arrears.
- txn_volume_zscore_90d: transaction-volume z-score over 90 days.
  Negative = inflow drop = riskier.
- tenure_months: months since onboarding. Higher = protective.
- product_type=*: encoded categorical (personal / auto / SME etc.).

# Indicator families
- FIN — financial: income, exposure, leverage, liquidity ratios.
- BEH — behavioural: repayment patterns, channel usage, login cadence.
- TXN — transactional: inflow/outflow, burn ratios, salary regularity.
- CRD — credit: bureau-score moves, hard inquiries, new tradelines.

# Style and constraints
- Be concise — chat-sized answers, 1 to 4 short paragraphs maximum.
- Ground every numeric claim in the page-context facts you are given.
  Never invent a PD, DPD, exposure, severity, SHAP value, or case state.
- If a question cannot be answered from the context provided, say so
  plainly and suggest which page or data the user needs to open.
- Use the user's role to tailor recommendations: a field_officer should
  be told to log a visit, not to update the rule engine.
- Don't reference "your context" or the JSON shape of the input — use
  the facts naturally in prose.
- Don't hedge with "I'm an AI" or "as a copilot" — answer directly.
- Don't ask follow-up questions unless the user's prompt is genuinely
  ambiguous — most prompts are scoped by the page they're on.

# What you must NOT do
- Do not promise to "send" emails, SMS, alerts, or assignments. You can
  only suggest actions the user takes via the UI.
- Do not invent customer names, IDs, or phone numbers — use only what
  the page-context block contains.
- Do not generate suggestion chips. The harness builds them
  deterministically based on the current page; chips you generate will
  be discarded and only confuse the user.

# Output
Return only the reply text. No JSON, no markdown headers, no role
prefixes, no system tags. Plain text the user can read in a chat bubble.
`;

let _client: Anthropic | null | undefined;
function client(): Anthropic | null {
  if (_client !== undefined) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  _client = apiKey ? new Anthropic({ apiKey }) : null;
  return _client;
}

export function llmAvailable(): boolean {
  return client() !== null;
}

function dynamicContextBlock(req: ChatRequest): string {
  const ctx = req.context ?? {};
  const lines: string[] = ['## Page context', `page: ${ctx.page ?? 'unknown'}`];
  if (ctx.role) lines.push(`role: ${ctx.role}`);
  if (ctx.entity) {
    lines.push('entity:', `  type: ${ctx.entity.type}`, `  id: ${ctx.entity.id}`);
    if (ctx.entity.label) lines.push(`  label: ${ctx.entity.label}`);
    const facts = ctx.entity.facts;
    if (facts && Object.keys(facts).length > 0) {
      lines.push('  facts:');
      for (const [k, v] of Object.entries(facts)) {
        lines.push(`    ${k}: ${JSON.stringify(v)}`);
      }
    }
  } else {
    lines.push('entity: (none — user is on a list / dashboard view)');
  }
  return lines.join('\n');
}

export interface LlmResponse {
  reply: string;
  /** Reported by the SDK; exposed so callers can log cache-hit health. */
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export async function llmRespond(req: ChatRequest): Promise<LlmResponse> {
  const c = client();
  if (!c) throw new Error('llm_unavailable');

  const message = await c.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 512,
    output_config: { effort: 'low' },
    system: [
      // Cached prefix — frozen primer.
      {
        type: 'text',
        text: SYSTEM_PRIMER,
        cache_control: { type: 'ephemeral' },
      },
      // Per-request context — sits AFTER the breakpoint so it does
      // not invalidate the primer cache when page / entity changes.
      {
        type: 'text',
        text: dynamicContextBlock(req),
      },
    ],
    messages: [{ role: 'user', content: req.message }],
  });

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  return {
    reply: text || "I don't have an answer for that — try one of the suggestions.",
    cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? 0,
  };
}
