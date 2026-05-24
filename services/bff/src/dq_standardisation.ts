// services/bff/src/dq_standardisation.ts
//
// DQ Standardisation pipelines — closes §2.3 #16 of
// ZorEWS_Pending_Gap_Analysis.md.
//
// Canonicalisation pipeline + dictionary management for the Data Pipeline
// Standardisation screen. Distinct from M7 NPA Prediction model — this is
// a deterministic *rule-driven* standardisation pass (e.g. "Pvt Ltd" →
// "Private Limited", "FY25" → "FY2024-25", "MH" → "Maharashtra") rather
// than an ML model.
//
//   GET    /v1/dq/standardisation/pipelines              (list)
//   POST   /v1/dq/standardisation/pipelines              (create)
//   GET    /v1/dq/standardisation/pipelines/:id          (single)
//   PATCH  /v1/dq/standardisation/pipelines/:id          (update steps)
//   DELETE /v1/dq/standardisation/pipelines/:id          (remove)
//   POST   /v1/dq/standardisation/pipelines/:id/run      (dry-run on sample)
//   GET    /v1/dq/standardisation/dictionaries           (list dictionaries)
//   POST   /v1/dq/standardisation/dictionaries           (create dictionary)
//   GET    /v1/dq/standardisation/dictionaries/:id       (single)
//   POST   /v1/dq/standardisation/dictionaries/:id/entries   (add entry)
//   DELETE /v1/dq/standardisation/dictionaries/:id/entries/:from  (remove entry)

export type StandardisationOp =
  | 'trim'
  | 'uppercase'
  | 'lowercase'
  | 'titlecase'
  | 'collapse_whitespace'
  | 'strip_punctuation'
  | 'dictionary_lookup'
  | 'regex_replace';

export const ALL_STANDARDISATION_OPS: readonly StandardisationOp[] = [
  'trim', 'uppercase', 'lowercase', 'titlecase', 'collapse_whitespace', 'strip_punctuation', 'dictionary_lookup', 'regex_replace',
];

export interface StandardisationStep {
  op: StandardisationOp;
  config?: { dictionary_id?: string; pattern?: string; replacement?: string };
}

export interface StandardisationPipeline {
  pipeline_id: string;
  tenant_id: string;
  name: string;
  description: string;
  target_column: string;
  steps: StandardisationStep[];
  created_at: string;
  updated_at: string;
  created_by: string;
}

export interface Dictionary {
  dictionary_id: string;
  tenant_id: string;
  name: string;
  description: string;
  entries: { from: string; to: string }[];
  created_at: string;
  updated_at: string;
}

export class StandardisationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'StandardisationError';
  }
}

const _pipelines = new Map<string, StandardisationPipeline>();
const _dictionaries = new Map<string, Dictionary>();
let _pSeq = 0;
let _dSeq = 0;

const NAME_RE = /^[A-Za-z0-9 _.-]{1,80}$/;

function isStepValid(s: unknown): s is StandardisationStep {
  if (!s || typeof s !== 'object') return false;
  const so = s as { op?: unknown };
  return typeof so.op === 'string' && ALL_STANDARDISATION_OPS.includes(so.op as StandardisationOp);
}

export function listPipelines(tenant_id: string): StandardisationPipeline[] {
  if (!tenant_id) throw new StandardisationError('invalid_input', 'tenant_id required');
  const out: StandardisationPipeline[] = [];
  for (const v of _pipelines.values()) if (v.tenant_id === tenant_id) out.push({ ...v, steps: v.steps.map((s) => ({ ...s, config: s.config ? { ...s.config } : undefined })) });
  out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return out;
}

export function getPipeline(tenant_id: string, pipeline_id: string): StandardisationPipeline | null {
  if (!tenant_id) throw new StandardisationError('invalid_input', 'tenant_id required');
  const found = _pipelines.get(pipeline_id);
  if (!found || found.tenant_id !== tenant_id) return null;
  return { ...found, steps: found.steps.map((s) => ({ ...s, config: s.config ? { ...s.config } : undefined })) };
}

export function createPipeline(
  tenant_id: string,
  input: { name: string; description?: string; target_column: string; steps: StandardisationStep[] },
  actor: string,
  now: Date,
): StandardisationPipeline {
  if (!tenant_id) throw new StandardisationError('invalid_input', 'tenant_id required');
  if (!actor) throw new StandardisationError('invalid_input', 'actor required');
  if (!input || typeof input !== 'object') throw new StandardisationError('invalid_input', 'input required');
  if (!input.name || !NAME_RE.test(input.name)) throw new StandardisationError('invalid_input', 'name invalid');
  if (!input.target_column) throw new StandardisationError('invalid_input', 'target_column required');
  if (!Array.isArray(input.steps) || input.steps.length === 0)
    throw new StandardisationError('invalid_input', 'steps must be non-empty');
  if (input.steps.length > 20) throw new StandardisationError('invalid_input', 'steps > 20');
  for (const s of input.steps) {
    if (!isStepValid(s)) throw new StandardisationError('invalid_step', `invalid step ${JSON.stringify(s)}`);
    if (s.op === 'dictionary_lookup' && !s.config?.dictionary_id)
      throw new StandardisationError('invalid_step', 'dictionary_lookup requires config.dictionary_id');
    if (s.op === 'regex_replace' && (!s.config?.pattern || s.config.replacement === undefined))
      throw new StandardisationError('invalid_step', 'regex_replace requires pattern + replacement');
  }
  _pSeq++;
  const id = `stdp-${tenant_id}-${String(_pSeq).padStart(5, '0')}`;
  const entry: StandardisationPipeline = {
    pipeline_id: id,
    tenant_id,
    name: input.name,
    description: input.description ?? '',
    target_column: input.target_column,
    steps: input.steps.map((s) => ({ ...s, config: s.config ? { ...s.config } : undefined })),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    created_by: actor,
  };
  _pipelines.set(id, entry);
  return entry;
}

export function updatePipeline(
  tenant_id: string,
  pipeline_id: string,
  patch: Partial<{ name: string; description: string; target_column: string; steps: StandardisationStep[] }>,
  now: Date,
): StandardisationPipeline {
  if (!tenant_id) throw new StandardisationError('invalid_input', 'tenant_id required');
  const found = _pipelines.get(pipeline_id);
  if (!found || found.tenant_id !== tenant_id)
    throw new StandardisationError('unknown_pipeline', `unknown ${pipeline_id}`);
  if (patch.name !== undefined) {
    if (!NAME_RE.test(patch.name)) throw new StandardisationError('invalid_input', 'name invalid');
    found.name = patch.name;
  }
  if (patch.description !== undefined) found.description = patch.description;
  if (patch.target_column !== undefined) {
    if (!patch.target_column) throw new StandardisationError('invalid_input', 'target_column required');
    found.target_column = patch.target_column;
  }
  if (patch.steps !== undefined) {
    if (!Array.isArray(patch.steps) || patch.steps.length === 0)
      throw new StandardisationError('invalid_input', 'steps must be non-empty');
    for (const s of patch.steps) {
      if (!isStepValid(s)) throw new StandardisationError('invalid_step', `invalid step ${JSON.stringify(s)}`);
    }
    found.steps = patch.steps.map((s) => ({ ...s, config: s.config ? { ...s.config } : undefined }));
  }
  found.updated_at = now.toISOString();
  return { ...found, steps: found.steps.map((s) => ({ ...s, config: s.config ? { ...s.config } : undefined })) };
}

export function deletePipeline(tenant_id: string, pipeline_id: string): boolean {
  if (!tenant_id) throw new StandardisationError('invalid_input', 'tenant_id required');
  const found = _pipelines.get(pipeline_id);
  if (!found || found.tenant_id !== tenant_id) return false;
  _pipelines.delete(pipeline_id);
  return true;
}

function titleCase(s: string): string {
  return s.replace(/\b\w+/g, (w) => w.charAt(0).toUpperCase() + w.substring(1).toLowerCase());
}

function applyStep(value: string, step: StandardisationStep, dicts: Map<string, Dictionary>): string {
  switch (step.op) {
    case 'trim': return value.trim();
    case 'uppercase': return value.toUpperCase();
    case 'lowercase': return value.toLowerCase();
    case 'titlecase': return titleCase(value);
    case 'collapse_whitespace': return value.replace(/\s+/g, ' ');
    case 'strip_punctuation': return value.replace(/[.,;:!?'"()\[\]{}]/g, '');
    case 'dictionary_lookup': {
      const did = step.config?.dictionary_id;
      if (!did) return value;
      const dict = dicts.get(did);
      if (!dict) return value;
      for (const e of dict.entries) {
        if (value === e.from) return e.to;
      }
      return value;
    }
    case 'regex_replace': {
      const pat = step.config?.pattern;
      const rep = step.config?.replacement;
      if (!pat || rep === undefined) return value;
      try {
        return value.replace(new RegExp(pat, 'g'), rep);
      } catch {
        return value;
      }
    }
  }
}

export interface RunSampleResult {
  pipeline_id: string;
  target_column: string;
  steps_applied: number;
  rows: { input: string; output: string; transformations: { step: number; op: StandardisationOp; before: string; after: string }[] }[];
}

export function runPipelineOnSample(
  tenant_id: string,
  pipeline_id: string,
  samples: string[],
): RunSampleResult {
  if (!tenant_id) throw new StandardisationError('invalid_input', 'tenant_id required');
  if (!Array.isArray(samples)) throw new StandardisationError('invalid_input', 'samples must be an array');
  if (samples.length > 100) throw new StandardisationError('invalid_input', 'samples > 100');
  const pl = _pipelines.get(pipeline_id);
  if (!pl || pl.tenant_id !== tenant_id)
    throw new StandardisationError('unknown_pipeline', `unknown ${pipeline_id}`);

  // Resolve tenant-scoped dictionary map
  const tenantDicts = new Map<string, Dictionary>();
  for (const d of _dictionaries.values()) if (d.tenant_id === tenant_id) tenantDicts.set(d.dictionary_id, d);

  const rows = samples.map((s) => {
    let cur = s;
    const transformations: { step: number; op: StandardisationOp; before: string; after: string }[] = [];
    pl.steps.forEach((st, idx) => {
      const before = cur;
      cur = applyStep(cur, st, tenantDicts);
      if (before !== cur) transformations.push({ step: idx, op: st.op, before, after: cur });
    });
    return { input: s, output: cur, transformations };
  });
  return { pipeline_id, target_column: pl.target_column, steps_applied: pl.steps.length, rows };
}

// ─── Dictionaries ───────────────────────────────────────────────────────

export function listDictionaries(tenant_id: string): Dictionary[] {
  if (!tenant_id) throw new StandardisationError('invalid_input', 'tenant_id required');
  const out: Dictionary[] = [];
  for (const v of _dictionaries.values()) if (v.tenant_id === tenant_id) out.push({ ...v, entries: v.entries.map((e) => ({ ...e })) });
  out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return out;
}

export function getDictionary(tenant_id: string, dictionary_id: string): Dictionary | null {
  if (!tenant_id) throw new StandardisationError('invalid_input', 'tenant_id required');
  const found = _dictionaries.get(dictionary_id);
  if (!found || found.tenant_id !== tenant_id) return null;
  return { ...found, entries: found.entries.map((e) => ({ ...e })) };
}

export function createDictionary(
  tenant_id: string,
  input: { name: string; description?: string; entries?: { from: string; to: string }[] },
  now: Date,
): Dictionary {
  if (!tenant_id) throw new StandardisationError('invalid_input', 'tenant_id required');
  if (!input || !input.name || !NAME_RE.test(input.name))
    throw new StandardisationError('invalid_input', 'name invalid');
  _dSeq++;
  const id = `dict-${tenant_id}-${String(_dSeq).padStart(5, '0')}`;
  const entries = (input.entries ?? []).map((e) => ({ ...e }));
  for (const e of entries) {
    if (!e.from || typeof e.from !== 'string' || typeof e.to !== 'string')
      throw new StandardisationError('invalid_input', 'each entry needs from + to as strings');
  }
  const dict: Dictionary = {
    dictionary_id: id,
    tenant_id,
    name: input.name,
    description: input.description ?? '',
    entries,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  _dictionaries.set(id, dict);
  return dict;
}

export function addDictionaryEntry(
  tenant_id: string,
  dictionary_id: string,
  entry: { from: string; to: string },
  now: Date,
): Dictionary {
  const dict = _dictionaries.get(dictionary_id);
  if (!dict || dict.tenant_id !== tenant_id)
    throw new StandardisationError('unknown_dictionary', `unknown ${dictionary_id}`);
  if (!entry || !entry.from || typeof entry.from !== 'string' || typeof entry.to !== 'string')
    throw new StandardisationError('invalid_input', 'entry from + to required');
  if (dict.entries.length >= 5000)
    throw new StandardisationError('dictionary_full', 'dictionary cap = 5000 entries');
  // Update existing or append
  const existing = dict.entries.find((e) => e.from === entry.from);
  if (existing) existing.to = entry.to;
  else dict.entries.push({ from: entry.from, to: entry.to });
  dict.updated_at = now.toISOString();
  return { ...dict, entries: dict.entries.map((e) => ({ ...e })) };
}

export function removeDictionaryEntry(
  tenant_id: string,
  dictionary_id: string,
  from: string,
  now: Date,
): Dictionary {
  const dict = _dictionaries.get(dictionary_id);
  if (!dict || dict.tenant_id !== tenant_id)
    throw new StandardisationError('unknown_dictionary', `unknown ${dictionary_id}`);
  const before = dict.entries.length;
  dict.entries = dict.entries.filter((e) => e.from !== from);
  if (dict.entries.length === before)
    throw new StandardisationError('unknown_entry', `entry from=${from} not found`);
  dict.updated_at = now.toISOString();
  return { ...dict, entries: dict.entries.map((e) => ({ ...e })) };
}

export function _resetStandardisationStore() {
  _pipelines.clear();
  _dictionaries.clear();
  _pSeq = 0;
  _dSeq = 0;
}
