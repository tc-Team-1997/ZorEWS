// services/bff/src/copilot/ews_intents.ts
//
// Copilot-2 — EWS-specific intent layer.
//
// Adds 4 intents on top of the existing chat.ts brain (which is left
// untouched per the additive-only rule):
//
//   why_flagged        — "Why is customer X flagged as high risk?"
//   summarize_alert    — "Summarize this alert in 2 lines"
//   suggest_case_steps — "Suggest next steps for this case"
//   explain_kri        — "Explain the KRI breakdown for this score"
//
// Pure functions only. The route handler in server.ts decides whether
// to fall through to the legacy chat.ts brain (when none of the new
// intents fire) or to use this module's typed responses.
//
// Each intent has:
//   - a regex matcher
//   - a "context fetcher" that pulls structured data from the request
//     (entity facts) and renders a human-readable reply
//   - a list of suggested follow-ups for the SPA's quick-action chips

import type { ChatContext, ChatEntitySummary } from './chat';

export type EwsIntent =
  | 'why_flagged'
  | 'summarize_alert'
  | 'suggest_case_steps'
  | 'explain_kri';

export interface EwsIntentMatch {
  intent: EwsIntent;
  reply: string;
  suggestions: string[];
}

// ─── Pattern matchers ────────────────────────────────────────────────

// Permissive: lazy `[^.?!\n]{0,80}` body lets multi-word subjects sit
// between "why" and "high risk" (e.g. "why is this customer high risk").
const WHY_FLAGGED_RE =
  /(\bwhy\b[^.?!\n]{0,80}\b(flagged|high\s+risk|risky|elevated)|\bexplain\b[^.?!\n]{0,80}\brisk\b|\breason\b[^.?!\n]{0,80}\b(flag|risk))/i;
const SUMMARIZE_ALERT_RE =
  /\b(summari[sz]e\s+(the\s+|this\s+)?alert|alert\s+summary|tl;?dr\s+(of\s+)?(the\s+|this\s+)?alert|2[\s-]?line\s+summary)\b/i;
// Match "next steps" (plural), "what should I do for this case",
// and "recommended actions for the case".
const NEXT_STEPS_RE =
  /(\bnext\s+steps?\b|\bsuggest[^.?!\n]{0,40}\b(steps?|actions?)\b|\bwhat[^.?!\n]{0,40}\bdo[^.?!\n]{0,40}\bcase\b|\brecommended\s+actions?\s+for[^.?!\n]{0,40}\bcase\b|\bhow[^.?!\n]{0,40}\bclose[^.?!\n]{0,40}\bcase\b)/i;
const KRI_RE =
  /\b(kri\s+(breakdown|score|explanation)|explain\s+(the\s+)?kri|what\s+(kris?|indicators?)\s+(drove|caused|fired)|breakdown\s+of\s+(the\s+)?score)\b/i;

export function classifyEwsIntent(message: string): EwsIntent | null {
  if (typeof message !== 'string' || !message.trim()) return null;
  if (WHY_FLAGGED_RE.test(message)) return 'why_flagged';
  if (SUMMARIZE_ALERT_RE.test(message)) return 'summarize_alert';
  if (NEXT_STEPS_RE.test(message)) return 'suggest_case_steps';
  if (KRI_RE.test(message)) return 'explain_kri';
  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function fact(entity: ChatEntitySummary | undefined, key: string): string | null {
  if (!entity?.facts) return null;
  const v = entity.facts[key];
  if (v === undefined || v === null) return null;
  return String(v);
}

function pdToBand(pd: number): 'low' | 'medium' | 'high' {
  if (pd >= 0.6) return 'high';
  if (pd >= 0.3) return 'medium';
  return 'low';
}

// ─── Per-intent renderers ────────────────────────────────────────────

function renderWhyFlagged(ctx: ChatContext): EwsIntentMatch {
  const e = ctx.entity;
  const lines: string[] = [];
  const suggestions: string[] = [
    'Show top SHAP drivers',
    'Which KRIs are red?',
    'What is the recommended action?',
  ];

  if (!e || e.type !== 'customer') {
    lines.push(
      "I can explain why a customer is flagged once you open one — try the **Customers** page and pick a name. I'll then walk you through the SHAP drivers and KRI breaches.",
    );
    return { intent: 'why_flagged', reply: lines.join('\n'), suggestions };
  }

  const label = e.label ?? e.id;
  const pdRaw = fact(e, 'pd') ?? fact(e, 'risk_score');
  const pdNum = pdRaw ? Number(pdRaw) : null;
  const dpd = fact(e, 'dpd_max_90d') ?? fact(e, 'dpd');
  const utilization = fact(e, 'utilization');
  const exposure = fact(e, 'exposure_kes') ?? fact(e, 'exposure');
  const topDriver = fact(e, 'top_driver') ?? fact(e, 'shap_top') ?? null;

  lines.push(`**${label}** is flagged as ${pdNum !== null ? pdToBand(pdNum) : 'elevated'} risk.`);

  const drivers: string[] = [];
  if (pdNum !== null) drivers.push(`PD = ${(pdNum * 100).toFixed(0)}%`);
  if (dpd) drivers.push(`max DPD over 90d = ${dpd}`);
  if (utilization) drivers.push(`utilization = ${utilization}`);
  if (exposure) drivers.push(`exposure = ${exposure}`);
  if (topDriver) drivers.push(`top SHAP driver = ${topDriver}`);

  if (drivers.length > 0) {
    lines.push(`Drivers: ${drivers.join(' · ')}`);
  } else {
    lines.push(
      "I don't have the SHAP / KRI facts in scope yet — open the customer's risk profile and try again.",
    );
  }

  if (pdNum !== null) {
    if (pdNum >= 0.6) {
      lines.push(
        '**Recommended:** escalate to a case, assign to Collection, attempt outreach within 48 hours.',
      );
    } else if (pdNum >= 0.3) {
      lines.push(
        '**Recommended:** soft-touch outreach (SMS or call), monitor for 14 days; escalate if behaviour deteriorates.',
      );
    } else {
      lines.push('**Recommended:** keep on watchlist, re-score at next refresh.');
    }
  }

  return { intent: 'why_flagged', reply: lines.join('\n'), suggestions };
}

function renderSummarizeAlert(ctx: ChatContext): EwsIntentMatch {
  const e = ctx.entity;
  const suggestions = [
    'Why was it flagged?',
    'What rule fired?',
    'Suggest next steps',
  ];

  if (!e || e.type !== 'alert') {
    return {
      intent: 'summarize_alert',
      reply:
        'Open an alert and I can give you a 2-line summary. From the **Alerts** page click any row.',
      suggestions,
    };
  }

  const label = e.label ?? e.id;
  const severity = fact(e, 'severity') ?? fact(e, 'bil_class') ?? 'unknown';
  const customer = fact(e, 'customer_id') ?? fact(e, 'customer_name') ?? null;
  const ruleName = fact(e, 'rule_name') ?? fact(e, 'rule_id') ?? null;
  const reason = fact(e, 'reason_summary') ?? fact(e, 'reason') ?? null;

  const line1 = `**${label}** (${severity}${customer ? ` · ${customer}` : ''}${
    ruleName ? ` · rule: ${ruleName}` : ''
  })`;
  const line2 = reason
    ? `Reason: ${reason}`
    : 'No reason summary attached — open the alert details to see the indicators that fired.';

  return {
    intent: 'summarize_alert',
    reply: `${line1}\n${line2}`,
    suggestions,
  };
}

function renderSuggestCaseSteps(ctx: ChatContext): EwsIntentMatch {
  const e = ctx.entity;
  const suggestions = [
    'Explain the KRI breakdown',
    'Why was it flagged?',
    'Show the SLA timer',
  ];

  if (!e || e.type !== 'case') {
    return {
      intent: 'suggest_case_steps',
      reply:
        'Open a case from the **Case Management** page and I can suggest next steps tailored to its current state and SLA.',
      suggestions,
    };
  }

  const label = e.label ?? e.id;
  const status = fact(e, 'status') ?? fact(e, 'state') ?? 'unknown';
  const priority = fact(e, 'priority') ?? null;
  const assignee = fact(e, 'assigned_to') ?? null;
  const slaProgress = fact(e, 'sla_progress_pct');
  const slaBreached = fact(e, 'sla_breached') === 'true';

  const lines: string[] = [`**${label}** — status: ${status}${priority ? ` · ${priority}` : ''}`];

  switch (status.toUpperCase()) {
    case 'OPEN':
      lines.push(
        '1. Assign to an analyst (or `POST /v1/cms/cases/:id/assign-from-pool` for round-robin).',
      );
      lines.push('2. Move to **INVESTIGATING** once the analyst starts reviewing.');
      break;
    case 'ASSIGNED':
      lines.push(
        `1. Reach out to ${assignee ?? 'the assignee'} for status — may have been parked.`,
      );
      lines.push('2. Transition to **INVESTIGATING** when investigation begins.');
      break;
    case 'INVESTIGATING':
      lines.push('1. Add notes documenting the customer interaction + evidence.');
      lines.push('2. When ready, transition to **PENDING_APPROVAL** for supervisor sign-off.');
      lines.push('3. If risk worsens, **escalate** with a reason (one click).');
      break;
    case 'PENDING_APPROVAL':
      lines.push(
        '1. Supervisor reviews resolution; if accepted, **close** with a resolution category.',
      );
      lines.push(
        '2. If more work needed, transition back to **INVESTIGATING** with a comment.',
      );
      break;
    case 'ESCALATED':
      lines.push('1. Supervisor / risk committee triage. Document the escalation reason.');
      lines.push('2. De-escalate to **INVESTIGATING** once resolution path is clear.');
      break;
    case 'CLOSED':
      lines.push(
        'Case is **locked** — no further mutations. If new evidence emerges, reopen via `POST /transition` with `target: "OPEN"`.',
      );
      break;
    default:
      lines.push('No next-step playbook for this state — escalate if unsure.');
  }

  if (slaBreached) {
    lines.push('⚠ **SLA breached.** Escalate to supervisor + document the delay.');
  } else if (slaProgress) {
    const pct = Number(slaProgress);
    if (Number.isFinite(pct) && pct >= 80) {
      lines.push(`⏰ SLA at ${pct}% — close out within the next few hours.`);
    }
  }

  return {
    intent: 'suggest_case_steps',
    reply: lines.join('\n'),
    suggestions,
  };
}

function renderExplainKri(ctx: ChatContext): EwsIntentMatch {
  const e = ctx.entity;
  const suggestions = [
    'Why is this customer flagged?',
    'What rule fired?',
    'Suggest next steps',
  ];

  if (!e || (e.type !== 'customer' && e.type !== 'alert')) {
    return {
      intent: 'explain_kri',
      reply:
        'Open a **customer** or **alert** and I can break down the KRI scores driving the risk band.',
      suggestions,
    };
  }

  const label = e.label ?? e.id;
  const lines: string[] = [`KRI breakdown for **${label}**:`];

  // Read up to 5 KRI facts. The page is expected to surface them as
  // facts.kri_<id> = value or facts.red_count / facts.orange_count.
  const red = fact(e, 'red_count');
  const orange = fact(e, 'orange_count');
  const yellow = fact(e, 'yellow_count');
  const green = fact(e, 'green_count');
  const top = fact(e, 'top_driver') ?? fact(e, 'shap_top');

  const tally: string[] = [];
  if (red) tally.push(`red ${red}`);
  if (orange) tally.push(`orange ${orange}`);
  if (yellow) tally.push(`yellow ${yellow}`);
  if (green) tally.push(`green ${green}`);
  if (tally.length > 0) {
    lines.push(`- Breach classes: ${tally.join(' · ')}`);
  }
  if (top) {
    lines.push(`- Top contributor: ${top}`);
  }

  // Look for individual KRI facts: kri_FIN-001=0.6 etc.
  const kris: string[] = [];
  if (e.facts) {
    for (const [k, v] of Object.entries(e.facts)) {
      if (k.toLowerCase().startsWith('kri_') && v !== null && v !== undefined) {
        kris.push(`${k.slice(4)}=${v}`);
        if (kris.length >= 5) break;
      }
    }
  }
  if (kris.length > 0) {
    lines.push(`- Individual KRIs: ${kris.join(', ')}`);
  } else if (tally.length === 0) {
    lines.push(
      "- I don't have KRI facts in scope yet — try refreshing the page or opening a specific customer.",
    );
  }

  lines.push(
    'For the full per-customer breach scan call `POST /v1/indicators/scan-customer { customer_id }`.',
  );

  return {
    intent: 'explain_kri',
    reply: lines.join('\n'),
    suggestions,
  };
}

// ─── Public entry ────────────────────────────────────────────────────

/**
 * Try to handle the message as one of the 4 EWS-specific intents.
 * Returns null when none of the patterns match — caller falls through
 * to the legacy chat.ts brain or the LLM.
 */
export function tryHandleEwsIntent(
  message: string,
  ctx: ChatContext,
): EwsIntentMatch | null {
  const intent = classifyEwsIntent(message);
  if (!intent) return null;
  switch (intent) {
    case 'why_flagged':
      return renderWhyFlagged(ctx);
    case 'summarize_alert':
      return renderSummarizeAlert(ctx);
    case 'suggest_case_steps':
      return renderSuggestCaseSteps(ctx);
    case 'explain_kri':
      return renderExplainKri(ctx);
  }
}
