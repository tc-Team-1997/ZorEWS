// services/bff/src/ai_prompts.ts
//
// AI Workbench prompt library — closes §2.4 #23 of
// ZorEWS_Pending_Gap_Analysis.md.
//
//   GET    /v1/ai/prompts/library         (per-tenant + curated platform prompts)
//   GET    /v1/ai/prompts/:prompt_id
//   POST   /v1/ai/prompts                 (create custom prompt)
//   PATCH  /v1/ai/prompts/:prompt_id
//   DELETE /v1/ai/prompts/:prompt_id
//
// Distinct from M7 model registry (model versions + promotions). This is
// the "saved prompts" library the Copilot v2 panel uses.

export type PromptCategory = 'risk_analysis' | 'reporting' | 'investigation' | 'compliance' | 'modelling' | 'data_quality' | 'other';
export const ALL_PROMPT_CATEGORIES: readonly PromptCategory[] = [
  'risk_analysis', 'reporting', 'investigation', 'compliance', 'modelling', 'data_quality', 'other',
];

export interface AiPrompt {
  prompt_id: string;
  tenant_id: string;
  name: string;
  category: PromptCategory;
  body: string;
  description: string;
  is_platform: boolean;
  created_at: string;
  updated_at: string;
  created_by: string;
  tags: string[];
}

// Platform-wide curated prompts (read-only, replicated per tenant in list)
const PLATFORM_PROMPTS: Omit<AiPrompt, 'tenant_id'>[] = [
  {
    prompt_id: 'pp_high_risk_summary_v1',
    name: 'Summarise top high-risk customers',
    category: 'risk_analysis',
    body: 'Summarise the top 10 high-risk customers from the last 30 days. Include: customer_name, PD score, exposure, primary risk driver. Format as a Markdown table sorted by PD desc.',
    description: 'Quick risk summary for ops review.',
    is_platform: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'platform',
    tags: ['risk', 'summary', 'daily-review'],
  },
  {
    prompt_id: 'pp_npa_root_cause_v1',
    name: 'NPA root-cause analysis',
    category: 'investigation',
    body: 'For customer_id {{customer_id}}, identify the top 3 contributing factors to their current NPA status. Include DPD history, repayment behaviour, sector context, and any prior breach.',
    description: 'Per-customer NPA root-cause drill-down.',
    is_platform: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'platform',
    tags: ['npa', 'investigation', 'customer-drill'],
  },
  {
    prompt_id: 'pp_rbi_quarterly_v1',
    name: 'RBI quarterly compliance summary',
    category: 'compliance',
    body: 'Generate the RBI quarterly compliance summary including: total NPA count, NPA ratio %, SMA-0/1/2 transitions, sectoral concentration, top 5 fraud cases. Period: {{quarter}}.',
    description: 'Quarterly compliance pack input for RBI submission.',
    is_platform: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'platform',
    tags: ['rbi', 'compliance', 'quarterly'],
  },
  {
    prompt_id: 'pp_explain_prediction_v1',
    name: 'Explain prediction to relationship manager',
    category: 'modelling',
    body: 'Customer {{customer_id}} has a predicted PD of {{pd}}. Top 5 SHAP features pushed PD UP/DOWN. Write a one-paragraph explanation suitable for the relationship manager to discuss with the customer, AVOIDING jargon.',
    description: 'Human-friendly PD explanation.',
    is_platform: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'platform',
    tags: ['explainability', 'rm-customer'],
  },
  {
    prompt_id: 'pp_dq_anomaly_v1',
    name: 'Investigate DQ anomaly',
    category: 'data_quality',
    body: 'Anomaly {{anomaly_id}} was detected in source {{source_id}}. Describe likely root causes: schema drift, upstream system change, data dictionary mismatch, or ingestion lag. Suggest 3 corrective actions.',
    description: 'DQ anomaly investigation prompt.',
    is_platform: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'platform',
    tags: ['dq', 'anomaly', 'troubleshooting'],
  },
  {
    prompt_id: 'pp_sector_dive_v1',
    name: 'Sector deep-dive analysis',
    category: 'risk_analysis',
    body: 'Provide a multi-quarter analysis of sector {{sector}}: NPA ratio trend, top 5 stressed customers, contributing rule firings, and stress-test sensitivity. Format with section headings.',
    description: 'Quarterly sector analysis.',
    is_platform: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'platform',
    tags: ['sector', 'analysis', 'quarterly'],
  },
  {
    prompt_id: 'pp_audit_summary_v1',
    name: 'Audit trail summary',
    category: 'compliance',
    body: 'Summarise audit events for resource_id={{resource_id}} between {{start}} and {{end}}. Group by actor + action. Highlight any FAILURE outcomes or critical-severity events.',
    description: 'Compact audit trail review.',
    is_platform: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'platform',
    tags: ['audit', 'compliance'],
  },
];

export class PromptError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PromptError';
  }
}

export function isPromptCategory(x: unknown): x is PromptCategory {
  return typeof x === 'string' && ALL_PROMPT_CATEGORIES.includes(x as PromptCategory);
}

const _customPrompts = new Map<string, AiPrompt>();
let _seq = 0;

const NAME_RE = /^[A-Za-z0-9 _.&()-]{3,120}$/;

export function listPrompts(tenant_id: string, filter: { category?: PromptCategory; include_platform?: boolean; q?: string } = {}): AiPrompt[] {
  if (!tenant_id) throw new PromptError('invalid_input', 'tenant_id required');
  const includePlatform = filter.include_platform !== false;
  const out: AiPrompt[] = [];
  if (includePlatform) {
    for (const p of PLATFORM_PROMPTS) out.push({ ...p, tenant_id, tags: [...p.tags] });
  }
  for (const p of _customPrompts.values()) {
    if (p.tenant_id !== tenant_id) continue;
    out.push({ ...p, tags: [...p.tags] });
  }
  let filtered = out;
  if (filter.category) {
    if (!isPromptCategory(filter.category)) throw new PromptError('invalid_category', `invalid category ${filter.category}`);
    filtered = filtered.filter((p) => p.category === filter.category);
  }
  if (filter.q) {
    const q = filter.q.toLowerCase();
    filtered = filtered.filter(
      (p) => p.name.toLowerCase().includes(q) || p.body.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }
  filtered.sort((a, b) => Number(b.is_platform) - Number(a.is_platform) || a.name.localeCompare(b.name));
  return filtered;
}

export function getPrompt(tenant_id: string, prompt_id: string): AiPrompt | null {
  // Platform first (read-only, replicated for the tenant)
  const platform = PLATFORM_PROMPTS.find((p) => p.prompt_id === prompt_id);
  if (platform) return { ...platform, tenant_id, tags: [...platform.tags] };
  const custom = _customPrompts.get(prompt_id);
  if (!custom || custom.tenant_id !== tenant_id) return null;
  return { ...custom, tags: [...custom.tags] };
}

export function createPrompt(
  tenant_id: string,
  input: { name: string; category: PromptCategory; body: string; description?: string; tags?: string[] },
  actor: string,
  now: Date,
): AiPrompt {
  if (!tenant_id) throw new PromptError('invalid_input', 'tenant_id required');
  if (!actor) throw new PromptError('invalid_input', 'actor required');
  if (!input.name || !NAME_RE.test(input.name)) throw new PromptError('invalid_name', 'name must match pattern');
  if (!isPromptCategory(input.category)) throw new PromptError('invalid_category', `category ${input.category}`);
  if (!input.body || input.body.trim().length < 10)
    throw new PromptError('invalid_input', 'body ≥ 10 chars required');
  if (input.body.length > 8000) throw new PromptError('invalid_input', 'body > 8000 chars');
  _seq++;
  const id = `pmt-${tenant_id}-${String(_seq).padStart(6, '0')}`;
  const tags = (input.tags ?? []).filter((t) => typeof t === 'string' && t.length > 0).slice(0, 20);
  const entry: AiPrompt = {
    prompt_id: id,
    tenant_id,
    name: input.name,
    category: input.category,
    body: input.body,
    description: input.description ?? '',
    is_platform: false,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    created_by: actor,
    tags,
  };
  _customPrompts.set(id, entry);
  return { ...entry, tags: [...entry.tags] };
}

export function updatePrompt(
  tenant_id: string,
  prompt_id: string,
  patch: Partial<{ name: string; body: string; description: string; tags: string[]; category: PromptCategory }>,
  now: Date,
): AiPrompt {
  // Platform prompts are immutable
  if (PLATFORM_PROMPTS.some((p) => p.prompt_id === prompt_id))
    throw new PromptError('platform_immutable', 'platform prompts are read-only');
  const p = _customPrompts.get(prompt_id);
  if (!p || p.tenant_id !== tenant_id) throw new PromptError('unknown_prompt', `unknown ${prompt_id}`);
  if (patch.name !== undefined) {
    if (!NAME_RE.test(patch.name)) throw new PromptError('invalid_name', 'name invalid');
    p.name = patch.name;
  }
  if (patch.body !== undefined) {
    if (patch.body.length < 10 || patch.body.length > 8000) throw new PromptError('invalid_input', 'body length 10..8000');
    p.body = patch.body;
  }
  if (patch.description !== undefined) p.description = patch.description;
  if (patch.tags !== undefined)
    p.tags = patch.tags.filter((t) => typeof t === 'string' && t.length > 0).slice(0, 20);
  if (patch.category !== undefined) {
    if (!isPromptCategory(patch.category)) throw new PromptError('invalid_category', `category ${patch.category}`);
    p.category = patch.category;
  }
  p.updated_at = now.toISOString();
  return { ...p, tags: [...p.tags] };
}

export function deletePrompt(tenant_id: string, prompt_id: string): boolean {
  // Platform prompts are immutable
  if (PLATFORM_PROMPTS.some((p) => p.prompt_id === prompt_id)) return false;
  const p = _customPrompts.get(prompt_id);
  if (!p || p.tenant_id !== tenant_id) return false;
  _customPrompts.delete(prompt_id);
  return true;
}

export function _resetAiPromptStore() {
  _customPrompts.clear();
  _seq = 0;
}
