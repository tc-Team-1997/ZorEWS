// services/bff/src/dr/dr_admin.ts
//
// PHASE E.1 — DR admin runbook + game-day surface (PDF §A7 Backup &
// Recovery — closes the "no DR admin SPA" gap from the gap analysis).
//
// Two surfaces:
//   1. PURE-DATA catalog mirror of docs/dr-runbook.md +
//      docs/dr-game-day-plan.md so the SPA can render the runbook +
//      cadence checklist interactively (vs the markdown which is
//      regulator-audit-ready but not click-through).
//   2. PER-TENANT ledger of executed game-day exercises with explicit
//      6-dimension scoring rubric (RTO / RPO / runbook accuracy /
//      validator findings / comms cadence / audit-chain integrity).
//      Drives the SPA's "DR drill history" view + the green/amber/red
//      verdict badge per the docs/dr-game-day-plan.md §6 rubric.
//
// Architecture choices (per execution rules):
//   - Additive only — no impact on docs/dr-runbook.md or the existing
//     runtime modules.
//   - Pure-data + a small in-memory ledger. Pg-backed swap is a
//     future ticket; the IGameDayLedger interface keeps it mechanical.
//   - Closed enum of cadences + scoring dimensions + verdicts so the
//     SPA grid is stable.
//   - Per-tenant full audit fields on game-day rows.
//   - RBAC: audit:read admin-only.

/** Closed enum — matches docs/dr-game-day-plan.md §2 scope ladder. */
export const ALL_DR_CADENCES = ['Q1', 'Q2', 'Q3', 'Q4'] as const;
export type DrCadence = (typeof ALL_DR_CADENCES)[number];

export function isDrCadence(v: unknown): v is DrCadence {
  return typeof v === 'string' && (ALL_DR_CADENCES as readonly string[]).includes(v);
}

/** Closed enum — 6 scoring dimensions from docs/dr-game-day-plan.md §6. */
export const ALL_DR_SCORE_DIMENSIONS = [
  'rto_met',
  'rpo_met',
  'runbook_accuracy',
  'validator_findings',
  'comms_cadence',
  'audit_chain_integrity',
] as const;
export type DrScoreDimension = (typeof ALL_DR_SCORE_DIMENSIONS)[number];

/** Closed enum — per-dimension verdict (Pass / Marginal / Fail). */
export const ALL_DR_SCORES = ['pass', 'marginal', 'fail'] as const;
export type DrScore = (typeof ALL_DR_SCORES)[number];

/** Closed enum — overall game-day verdict. Computed from per-dimension
 *  scores: any fail → red; all pass → green; else amber. */
export const ALL_DR_VERDICTS = ['green', 'amber', 'red'] as const;
export type DrVerdict = (typeof ALL_DR_VERDICTS)[number];

// ── Pure-data: RTO/RPO catalog from docs/dr-runbook.md §1 ─────────────

export interface RtoRpoTarget {
  tier: string;
  /** e.g. "Aurora", "S3 audit", "MSK" — drives the SPA tile header. */
  resource: string;
  rto_minutes: number | null;
  rpo_minutes: number;
  notes: string;
}

/** RTO/RPO targets per docs/dr-runbook.md §1. Hand-curated mirror. */
export const DR_RTO_RPO_TARGETS: ReadonlyArray<RtoRpoTarget> = [
  {
    tier: '0',
    resource: 'Aurora primary',
    rto_minutes: 15,
    rpo_minutes: 5,
    notes: 'Aurora Global DB cross-region replication.',
  },
  {
    tier: '0',
    resource: 'S3 audit (Object Lock)',
    rto_minutes: null,
    rpo_minutes: 0,
    notes: 'CRR-synced; no RTO target (always available cross-region).',
  },
  {
    tier: '1',
    resource: 'MSK',
    rto_minutes: 30,
    rpo_minutes: 2,
    notes: 'MirrorMaker 2 → secondary cluster.',
  },
  {
    tier: '1',
    resource: 'EKS workloads',
    rto_minutes: 60,
    rpo_minutes: 0,
    notes: 'Stateless; ArgoCD redeploy from secondary registry.',
  },
  {
    tier: '2',
    resource: 'Glue Schema Registry',
    rto_minutes: 120,
    rpo_minutes: 0,
    notes: 'BACKWARD-compat schemas redeployed via CI.',
  },
  {
    tier: '3',
    resource: 'raw + curated S3',
    rto_minutes: 240,
    rpo_minutes: 15,
    notes: 'CRR with delay; non-blocking for the alert path.',
  },
];

/** Failover procedure steps from docs/dr-runbook.md §3. */
export interface DrRunbookStep {
  step_no: number;
  title: string;
  owner_role: string;
  /** Hand-curated estimate for the SPA tile timer. */
  estimated_minutes: number;
  description: string;
}

export const DR_RUNBOOK_STEPS: ReadonlyArray<DrRunbookStep> = [
  {
    step_no: 1,
    title: 'Declare DR + page on-call',
    owner_role: 'Incident commander',
    estimated_minutes: 5,
    description:
      'Confirm incident severity meets DR threshold; page primary + secondary; open war room in #apex-ews-dr-war-room.',
  },
  {
    step_no: 2,
    title: 'Promote Aurora secondary',
    owner_role: 'Aurora operator',
    estimated_minutes: 12,
    description:
      'aws rds failover-global-cluster — primary detaches; secondary promotes; verify writer endpoint reachable.',
  },
  {
    step_no: 3,
    title: 'DNS swap (Route53 weighted records)',
    owner_role: 'Platform-eng',
    estimated_minutes: 5,
    description:
      'Update Route53 alias weights primary → secondary; confirm CloudFront origin failover engages.',
  },
  {
    step_no: 4,
    title: 'EKS workload promotion + env var swap',
    owner_role: 'EKS operator',
    estimated_minutes: 15,
    description:
      'Apply secondary-region kustomize overlay; rotate env vars to point at secondary Aurora + MSK.',
  },
  {
    step_no: 5,
    title: 'MSK MirrorMaker 2 halt + consumer bootstrap update',
    owner_role: 'MSK operator',
    estimated_minutes: 10,
    description:
      'Stop MM2 source; update kafkajs bootstrap config in BFF + consumer services; restart pods.',
  },
  {
    step_no: 6,
    title: 'Validation (smoke + spot-check + integrity)',
    owner_role: 'Validator',
    estimated_minutes: 10,
    description:
      'make smoke + 10-alert end-to-end + /v1/audit/integrity per tenant + POST /v1/webhooks/:id/test.',
  },
  {
    step_no: 7,
    title: 'Externalise (StatusPage + regulator email)',
    owner_role: 'Comms officer',
    estimated_minutes: 5,
    description:
      'Update StatusPage; send RBI/IRDAI failover notice per BAC-A §4.2.3 + customer notice via email channel.',
  },
];

/** Scope ladder from docs/dr-game-day-plan.md §2. */
export interface DrGameDayScope {
  cadence: DrCadence;
  month_hint: string;
  scope: string;
  data_class: string;
  customer_impact: string;
}

export const DR_GAME_DAY_SCOPE: ReadonlyArray<DrGameDayScope> = [
  {
    cadence: 'Q1',
    month_hint: 'March',
    scope: 'Aurora only — promotion + failback',
    data_class: 'Synthetic',
    customer_impact: 'None',
  },
  {
    cadence: 'Q2',
    month_hint: 'June',
    scope: 'Aurora + MSK',
    data_class: 'Synthetic',
    customer_impact: 'None',
  },
  {
    cadence: 'Q3',
    month_hint: 'September',
    scope: 'Full stack → secondary region',
    data_class: 'Synthetic only',
    customer_impact: 'None',
  },
  {
    cadence: 'Q4',
    month_hint: 'December',
    scope: 'Full stack + 1-hour live shadow + failback',
    data_class: '10% canary',
    customer_impact: 'Limited (controlled) — requires CISO + Legal sign-off 2 weeks in advance',
  },
];

/** Pre-game checklist from docs/dr-game-day-plan.md §4. */
export const DR_PREGAME_CHECKLIST: ReadonlyArray<string> = [
  'Capacity headroom verified across both regions',
  'Release candidate tagged with pinned registry digests',
  'Baseline load test executed',
  'Tenant notice sent (Q4 only — 1 week minimum)',
  'War-room channels created in Slack',
  'Roster confirmed + backups acknowledged',
];

// ── Per-tenant game-day ledger ────────────────────────────────────────

export interface DrGameDayScore {
  dimension: DrScoreDimension;
  score: DrScore;
  notes: string | null;
}

export interface DrGameDayRecord {
  record_id: string;
  tenant_id: string;
  cadence: DrCadence;
  /** Calendar year of the exercise (e.g. 2026). */
  year: number;
  executed_at: string;
  incident_commander: string;
  scope_summary: string;
  scores: DrGameDayScore[];
  verdict: DrVerdict;
  observed_rto_minutes: number | null;
  observed_rpo_minutes: number | null;
  remediation_jira_keys: string[];
  notes: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface DrGameDayCreateInput {
  record_id: string;
  cadence: DrCadence;
  year: number;
  executed_at: string;
  incident_commander: string;
  scope_summary: string;
  scores: DrGameDayScore[];
  observed_rto_minutes?: number | null;
  observed_rpo_minutes?: number | null;
  remediation_jira_keys?: string[];
  notes?: string | null;
}

export interface DrGameDayUpdateInput {
  cadence?: DrCadence;
  year?: number;
  executed_at?: string;
  incident_commander?: string;
  scope_summary?: string;
  scores?: DrGameDayScore[];
  observed_rto_minutes?: number | null;
  observed_rpo_minutes?: number | null;
  remediation_jira_keys?: string[];
  notes?: string | null;
}

export class DrAdminError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'invalid_record_id'
      | 'invalid_cadence'
      | 'invalid_year'
      | 'invalid_executed_at'
      | 'invalid_commander'
      | 'invalid_scope'
      | 'invalid_scores'
      | 'invalid_rto'
      | 'invalid_rpo'
      | 'invalid_jira_keys'
      | 'invalid_notes'
      | 'unknown_record'
      | 'duplicate_record_id'
      | 'cap_reached',
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = 'DrAdminError';
  }
}

/** Per-tenant cap — DR exercises are rare (4/year max). */
export const DR_GAME_DAY_CAP_PER_TENANT = 100;
export const YEAR_MIN = 2024;
export const YEAR_MAX = 2099;
export const RTO_RPO_MAX_MIN = 60 * 24 * 7; // 7 days — sanity ceiling

const RECORD_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const JIRA_KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;

/** Compute verdict from per-dimension scores per docs/dr-game-day-plan.md §6. */
export function computeVerdict(scores: DrGameDayScore[]): DrVerdict {
  if (scores.length === 0) return 'amber';
  if (scores.some((s) => s.score === 'fail')) return 'red';
  if (scores.every((s) => s.score === 'pass')) return 'green';
  return 'amber';
}

function validateScores(scores: DrGameDayScore[]): void {
  if (!Array.isArray(scores)) {
    throw new DrAdminError('invalid_scores', 'scores must be an array');
  }
  if (scores.length === 0) {
    throw new DrAdminError('invalid_scores', 'scores cannot be empty');
  }
  if (scores.length > ALL_DR_SCORE_DIMENSIONS.length) {
    throw new DrAdminError(
      'invalid_scores',
      `scores can contain at most ${ALL_DR_SCORE_DIMENSIONS.length} entries (one per dimension)`,
    );
  }
  const seen = new Set<string>();
  for (const s of scores) {
    if (!s || typeof s !== 'object') {
      throw new DrAdminError('invalid_scores', 'each score must be an object');
    }
    if (
      !(ALL_DR_SCORE_DIMENSIONS as readonly string[]).includes(s.dimension)
    ) {
      throw new DrAdminError(
        'invalid_scores',
        `score.dimension must be one of: ${ALL_DR_SCORE_DIMENSIONS.join(', ')}`,
      );
    }
    if (!(ALL_DR_SCORES as readonly string[]).includes(s.score)) {
      throw new DrAdminError(
        'invalid_scores',
        `score.score must be one of: ${ALL_DR_SCORES.join(', ')}`,
      );
    }
    if (seen.has(s.dimension)) {
      throw new DrAdminError(
        'invalid_scores',
        `duplicate dimension in scores[]: ${s.dimension}`,
      );
    }
    seen.add(s.dimension);
    if (s.notes !== null && s.notes !== undefined) {
      if (typeof s.notes !== 'string' || s.notes.length > 1000) {
        throw new DrAdminError(
          'invalid_scores',
          'score.notes must be a string ≤ 1000 chars (or null)',
        );
      }
    }
  }
}

function validateRto(v: unknown): void {
  if (v === null || v === undefined) return;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > RTO_RPO_MAX_MIN) {
    throw new DrAdminError(
      'invalid_rto',
      `observed_rto_minutes must be a non-negative integer ≤ ${RTO_RPO_MAX_MIN}`,
    );
  }
}

function validateRpo(v: unknown): void {
  if (v === null || v === undefined) return;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > RTO_RPO_MAX_MIN) {
    throw new DrAdminError(
      'invalid_rpo',
      `observed_rpo_minutes must be a non-negative integer ≤ ${RTO_RPO_MAX_MIN}`,
    );
  }
}

function validateJiraKeys(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    throw new DrAdminError('invalid_jira_keys', 'remediation_jira_keys must be an array');
  }
  if (v.length > 50) {
    throw new DrAdminError(
      'invalid_jira_keys',
      'remediation_jira_keys can contain at most 50 keys',
    );
  }
  const out: string[] = [];
  for (const k of v) {
    if (typeof k !== 'string' || !JIRA_KEY_RE.test(k)) {
      throw new DrAdminError(
        'invalid_jira_keys',
        'each remediation_jira_key must match ^[A-Z][A-Z0-9]*-\\d+$',
      );
    }
    out.push(k);
  }
  return out;
}

function validateCreate(input: DrGameDayCreateInput): void {
  if (!input || typeof input !== 'object') {
    throw new DrAdminError('invalid_input', 'request body must be an object');
  }
  if (typeof input.record_id !== 'string' || !RECORD_ID_RE.test(input.record_id)) {
    throw new DrAdminError(
      'invalid_record_id',
      'record_id must match ^[a-z][a-z0-9_-]{1,63}$',
    );
  }
  if (!isDrCadence(input.cadence)) {
    throw new DrAdminError(
      'invalid_cadence',
      `cadence must be one of: ${ALL_DR_CADENCES.join(', ')}`,
    );
  }
  if (
    typeof input.year !== 'number' ||
    !Number.isInteger(input.year) ||
    input.year < YEAR_MIN ||
    input.year > YEAR_MAX
  ) {
    throw new DrAdminError(
      'invalid_year',
      `year must be an integer in [${YEAR_MIN}, ${YEAR_MAX}]`,
    );
  }
  if (typeof input.executed_at !== 'string' || !ISO_DT_RE.test(input.executed_at)) {
    throw new DrAdminError(
      'invalid_executed_at',
      'executed_at must be an ISO-8601 datetime',
    );
  }
  if (
    typeof input.incident_commander !== 'string' ||
    input.incident_commander.trim().length === 0 ||
    input.incident_commander.length > 120
  ) {
    throw new DrAdminError(
      'invalid_commander',
      'incident_commander must be 1..120 chars after trim',
    );
  }
  if (
    typeof input.scope_summary !== 'string' ||
    input.scope_summary.trim().length === 0 ||
    input.scope_summary.length > 2000
  ) {
    throw new DrAdminError(
      'invalid_scope',
      'scope_summary must be 1..2000 chars after trim',
    );
  }
  validateScores(input.scores);
  validateRto(input.observed_rto_minutes);
  validateRpo(input.observed_rpo_minutes);
  if (input.notes !== undefined && input.notes !== null) {
    if (typeof input.notes !== 'string' || input.notes.length > 4000) {
      throw new DrAdminError(
        'invalid_notes',
        'notes must be a string ≤ 4000 chars (or null)',
      );
    }
  }
  if (input.remediation_jira_keys !== undefined) {
    validateJiraKeys(input.remediation_jira_keys);
  }
}

function validateUpdate(patch: DrGameDayUpdateInput): void {
  if (!patch || typeof patch !== 'object') {
    throw new DrAdminError('invalid_input', 'patch must be an object');
  }
  if (patch.cadence !== undefined && !isDrCadence(patch.cadence)) {
    throw new DrAdminError('invalid_cadence', 'cadence must be valid');
  }
  if (patch.year !== undefined) {
    if (
      typeof patch.year !== 'number' ||
      !Number.isInteger(patch.year) ||
      patch.year < YEAR_MIN ||
      patch.year > YEAR_MAX
    ) {
      throw new DrAdminError('invalid_year', 'year out of range');
    }
  }
  if (patch.executed_at !== undefined) {
    if (typeof patch.executed_at !== 'string' || !ISO_DT_RE.test(patch.executed_at)) {
      throw new DrAdminError('invalid_executed_at', 'executed_at must be ISO-8601');
    }
  }
  if (patch.incident_commander !== undefined) {
    if (
      typeof patch.incident_commander !== 'string' ||
      patch.incident_commander.trim().length === 0 ||
      patch.incident_commander.length > 120
    ) {
      throw new DrAdminError('invalid_commander', 'commander 1..120 chars');
    }
  }
  if (patch.scope_summary !== undefined) {
    if (
      typeof patch.scope_summary !== 'string' ||
      patch.scope_summary.trim().length === 0 ||
      patch.scope_summary.length > 2000
    ) {
      throw new DrAdminError('invalid_scope', 'scope_summary 1..2000 chars');
    }
  }
  if (patch.scores !== undefined) validateScores(patch.scores);
  if (patch.observed_rto_minutes !== undefined) validateRto(patch.observed_rto_minutes);
  if (patch.observed_rpo_minutes !== undefined) validateRpo(patch.observed_rpo_minutes);
  if (patch.remediation_jira_keys !== undefined) validateJiraKeys(patch.remediation_jira_keys);
  if (patch.notes !== undefined && patch.notes !== null) {
    if (typeof patch.notes !== 'string' || patch.notes.length > 4000) {
      throw new DrAdminError('invalid_notes', 'notes ≤ 4000 chars');
    }
  }
}

export interface DrGameDayLedger {
  list(tenant_id: string, opts?: { include_deleted?: boolean }): DrGameDayRecord[];
  get(tenant_id: string, record_id: string): DrGameDayRecord | null;
  create(
    tenant_id: string,
    input: DrGameDayCreateInput,
    actor: string,
    now: Date,
  ): DrGameDayRecord;
  update(
    tenant_id: string,
    record_id: string,
    patch: DrGameDayUpdateInput,
    actor: string,
    now: Date,
  ): DrGameDayRecord;
  softDelete(
    tenant_id: string,
    record_id: string,
    actor: string,
    now: Date,
  ): DrGameDayRecord;
  restore(payload: DrGameDayRecord): boolean;
}

export class InMemoryDrGameDayLedger implements DrGameDayLedger {
  private byTenant = new Map<string, Map<string, DrGameDayRecord>>();

  private bucket(tenant_id: string): Map<string, DrGameDayRecord> {
    let b = this.byTenant.get(tenant_id);
    if (!b) {
      b = new Map();
      this.byTenant.set(tenant_id, b);
    }
    return b;
  }

  list(
    tenant_id: string,
    opts: { include_deleted?: boolean } = {},
  ): DrGameDayRecord[] {
    const out: DrGameDayRecord[] = [];
    const b = this.byTenant.get(tenant_id);
    if (!b) return out;
    for (const r of b.values()) {
      if (!opts.include_deleted && r.deleted_at) continue;
      out.push({ ...r, scores: r.scores.map((s) => ({ ...s })), remediation_jira_keys: [...r.remediation_jira_keys] });
    }
    // Sort newest-first by executed_at (year desc, executed_at desc).
    out.sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year;
      return b.executed_at.localeCompare(a.executed_at);
    });
    return out;
  }

  get(tenant_id: string, record_id: string): DrGameDayRecord | null {
    const r = this.byTenant.get(tenant_id)?.get(record_id);
    if (!r || r.deleted_at) return null;
    return { ...r, scores: r.scores.map((s) => ({ ...s })), remediation_jira_keys: [...r.remediation_jira_keys] };
  }

  create(
    tenant_id: string,
    input: DrGameDayCreateInput,
    actor: string,
    now: Date,
  ): DrGameDayRecord {
    validateCreate(input);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new DrAdminError('invalid_input', 'actor (created_by) required');
    }
    const b = this.bucket(tenant_id);
    const existing = b.get(input.record_id);
    if (existing && !existing.deleted_at) {
      throw new DrAdminError(
        'duplicate_record_id',
        `record_id ${input.record_id} already exists`,
        { record_id: input.record_id },
      );
    }
    const live = [...b.values()].filter((r) => !r.deleted_at).length;
    if (live >= DR_GAME_DAY_CAP_PER_TENANT) {
      throw new DrAdminError(
        'cap_reached',
        `DR game-day ledger cap (${DR_GAME_DAY_CAP_PER_TENANT}) reached`,
      );
    }
    const ts = now.toISOString();
    const verdict = computeVerdict(input.scores);
    const entry: DrGameDayRecord = {
      record_id: input.record_id,
      tenant_id,
      cadence: input.cadence,
      year: input.year,
      executed_at: input.executed_at,
      incident_commander: input.incident_commander.trim(),
      scope_summary: input.scope_summary.trim(),
      scores: input.scores.map((s) => ({
        dimension: s.dimension,
        score: s.score,
        notes: s.notes?.trim() || null,
      })),
      verdict,
      observed_rto_minutes:
        input.observed_rto_minutes === undefined ? null : input.observed_rto_minutes,
      observed_rpo_minutes:
        input.observed_rpo_minutes === undefined ? null : input.observed_rpo_minutes,
      remediation_jira_keys: validateJiraKeys(input.remediation_jira_keys),
      notes: input.notes?.trim() || null,
      created_at: ts,
      created_by: actor,
      updated_at: ts,
      updated_by: actor,
      deleted_at: null,
      deleted_by: null,
    };
    b.set(entry.record_id, entry);
    return { ...entry, scores: entry.scores.map((s) => ({ ...s })), remediation_jira_keys: [...entry.remediation_jira_keys] };
  }

  update(
    tenant_id: string,
    record_id: string,
    patch: DrGameDayUpdateInput,
    actor: string,
    now: Date,
  ): DrGameDayRecord {
    validateUpdate(patch);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new DrAdminError('invalid_input', 'actor (updated_by) required');
    }
    const b = this.bucket(tenant_id);
    const cur = b.get(record_id);
    if (!cur || cur.deleted_at) {
      throw new DrAdminError('unknown_record', `record ${record_id} not found`);
    }
    const merged: DrGameDayRecord = {
      ...cur,
      cadence: patch.cadence ?? cur.cadence,
      year: patch.year ?? cur.year,
      executed_at: patch.executed_at ?? cur.executed_at,
      incident_commander:
        patch.incident_commander !== undefined
          ? patch.incident_commander.trim()
          : cur.incident_commander,
      scope_summary:
        patch.scope_summary !== undefined
          ? patch.scope_summary.trim()
          : cur.scope_summary,
      scores: patch.scores
        ? patch.scores.map((s) => ({
            dimension: s.dimension,
            score: s.score,
            notes: s.notes?.trim() || null,
          }))
        : cur.scores.map((s) => ({ ...s })),
      observed_rto_minutes:
        patch.observed_rto_minutes !== undefined
          ? patch.observed_rto_minutes
          : cur.observed_rto_minutes,
      observed_rpo_minutes:
        patch.observed_rpo_minutes !== undefined
          ? patch.observed_rpo_minutes
          : cur.observed_rpo_minutes,
      remediation_jira_keys:
        patch.remediation_jira_keys !== undefined
          ? validateJiraKeys(patch.remediation_jira_keys)
          : [...cur.remediation_jira_keys],
      notes:
        patch.notes !== undefined ? patch.notes?.trim() || null : cur.notes,
      updated_at: now.toISOString(),
      updated_by: actor,
    };
    merged.verdict = computeVerdict(merged.scores);
    b.set(record_id, merged);
    return { ...merged, scores: merged.scores.map((s) => ({ ...s })), remediation_jira_keys: [...merged.remediation_jira_keys] };
  }

  softDelete(
    tenant_id: string,
    record_id: string,
    actor: string,
    now: Date,
  ): DrGameDayRecord {
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new DrAdminError('invalid_input', 'actor (deleted_by) required');
    }
    const b = this.bucket(tenant_id);
    const cur = b.get(record_id);
    if (!cur || cur.deleted_at) {
      throw new DrAdminError('unknown_record', `record ${record_id} not found`);
    }
    const ts = now.toISOString();
    const tombstoned: DrGameDayRecord = {
      ...cur,
      deleted_at: ts,
      deleted_by: actor,
      updated_at: ts,
      updated_by: actor,
    };
    b.set(record_id, tombstoned);
    return { ...tombstoned, scores: tombstoned.scores.map((s) => ({ ...s })), remediation_jira_keys: [...tombstoned.remediation_jira_keys] };
  }

  restore(payload: DrGameDayRecord): boolean {
    const b = this.bucket(payload.tenant_id);
    const cur = b.get(payload.record_id);
    if (cur && !cur.deleted_at) return false;
    const restored: DrGameDayRecord = {
      ...payload,
      deleted_at: null,
      deleted_by: null,
    };
    b.set(restored.record_id, restored);
    return true;
  }
}

export const defaultDrGameDayLedger: DrGameDayLedger = new InMemoryDrGameDayLedger();
