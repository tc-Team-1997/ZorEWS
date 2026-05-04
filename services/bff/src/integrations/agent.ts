// services/bff/src/integrations/agent.ts
//
// T6 M14.6 — Agent Productivity adapter (6th adapter in Module 14).
//
// Agent is the BIL pitch's #5 upstream — the HR-side feed that holds
// per-agent identity, branch, and monthly productivity (policies sold,
// premium collected, persistency, lapse, complaints, conversion).
// M11.3 already shipped a dashboard view with leaderboard + risk
// contribution; M14.6 lands the adapter so the SPA + case-investigation
// flow can pull a single agent's full history on demand.
//
// Production wires this to the BIL HR upstream (e.g. SAP SuccessFactors
// + agent-management system); the stub holds a deterministic 50-agent
// register per tenant with realistic monthly variance.

// ─── Public types ──────────────────────────────────────────────────────

export type AgentTier = 'gold' | 'silver' | 'bronze';
export type AgentStatus = 'active' | 'suspended' | 'terminated' | 'on_leave';

export interface Agent {
  agent_id: string;
  name: string;
  branch: string;
  joined_at: string;
  status: AgentStatus;
  tier: AgentTier;
  /** Manager's agent_id — null for branch heads. */
  manager_id: string | null;
}

export interface AgentProductivity {
  agent_id: string;
  /** YYYY-MM period this row covers. */
  period: string;
  policies_sold: number;
  premium_collected_kes: number;
  /** 12-month persistency rate (% of policies still in-force after 12m). */
  persistency_pct: number;
  /** Lapse count for the period. */
  lapse_count: number;
  /** Customer complaints filed against this agent in the period. */
  complaints_count: number;
  /** Lead → policy conversion rate as a percentage. */
  conversion_pct: number;
  /** Rank among same-branch agents that month. 1 = top. null when
   *  the agent was on_leave / suspended / terminated for the whole month. */
  branch_rank: number | null;
}

export interface AgentListPage {
  items: Agent[];
  page: number;
  page_size: number;
  total: number;
  filter: { tier?: AgentTier; status?: AgentStatus } | null;
}

export interface AgentAdapter {
  list(
    tenant_id: string,
    opts: { tier?: AgentTier; status?: AgentStatus; page?: number; page_size?: number },
    asOf: Date,
  ): Promise<AgentListPage>;
  get(tenant_id: string, agent_id: string): Promise<Agent | null>;
  /** Single-period productivity. period defaults to YYYY-MM of asOf. */
  getProductivity(
    tenant_id: string,
    agent_id: string,
    opts: { period?: string },
    asOf: Date,
  ): Promise<AgentProductivity | null>;
  /** Last N months ending at asOf, newest-first. months clamped to [1, 36]. */
  listProductivity(
    tenant_id: string,
    agent_id: string,
    months: number,
    asOf: Date,
  ): Promise<AgentProductivity[]>;
}

export class AgentError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

const VALID_TIERS: AgentTier[] = ['gold', 'silver', 'bronze'];
const VALID_STATUSES: AgentStatus[] = ['active', 'suspended', 'terminated', 'on_leave'];

export function isAgentTier(s: unknown): s is AgentTier {
  return typeof s === 'string' && VALID_TIERS.includes(s as AgentTier);
}
export function isAgentStatus(s: unknown): s is AgentStatus {
  return typeof s === 'string' && VALID_STATUSES.includes(s as AgentStatus);
}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidPeriod(s: unknown): s is string {
  return typeof s === 'string' && PERIOD_RE.test(s);
}

// ─── Deterministic PRNG ────────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick<T>(r: () => number, arr: readonly T[]): T {
  return arr[Math.floor(r() * arr.length)]!;
}
function periodOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}
function priorPeriod(period: string, n: number): string {
  // period = YYYY-MM
  const [y, m] = period.split('-').map(Number) as [number, number];
  let yy = y;
  let mm = m - n;
  while (mm <= 0) {
    mm += 12;
    yy -= 1;
  }
  return `${yy}-${mm.toString().padStart(2, '0')}`;
}

// ─── Stub data ─────────────────────────────────────────────────────────

const FIRST_NAMES = ['Asha', 'Raj', 'Priya', 'Arjun', 'Maya', 'Ravi', 'Sneha', 'Karan', 'Divya', 'Vikram'];
const LAST_NAMES = ['Mwangi', 'Patel', 'Sharma', 'Kumar', 'Reddy', 'Iyer', 'Singh', 'Nair', 'Gupta', 'Desai'];
const BRANCHES = ['Nairobi-Westlands', 'Nairobi-CBD', 'Mumbai-BKC', 'Mumbai-Andheri', 'Bangalore-Whitefield'];
const FLEET_SIZE = 50; // 50 agents per tenant

function buildAgent(tenant_id: string, index: number): Agent {
  const seed = fnv1a(`agent|${tenant_id}|${index}`);
  const r = rng(seed);
  const first = pick(r, FIRST_NAMES);
  const last = pick(r, LAST_NAMES);
  const branch = pick(r, BRANCHES);
  // Tier distribution: 15% gold, 35% silver, 50% bronze.
  const tierRoll = r();
  const tier: AgentTier = tierRoll < 0.15 ? 'gold' : tierRoll < 0.5 ? 'silver' : 'bronze';
  // Status distribution: 88% active, 5% on_leave, 4% suspended, 3% terminated.
  const statusRoll = r();
  const status: AgentStatus =
    statusRoll < 0.88 ? 'active' : statusRoll < 0.93 ? 'on_leave' : statusRoll < 0.97 ? 'suspended' : 'terminated';
  // Joined 30-3650 days before today (1 month - 10 years).
  const joinedDaysAgo = 30 + Math.floor(r() * 3620);
  const joined_at = new Date(Date.now() - joinedDaysAgo * 86_400_000).toISOString();
  // Manager id — first 5 agents are branch heads (no manager); others
  // report to one of the first 5.
  const manager_id =
    index < 5 ? null : `AGT-${tenant_id.slice(0, 3).toUpperCase()}-${(index % 5).toString().padStart(4, '0')}`;
  return {
    agent_id: `AGT-${tenant_id.slice(0, 3).toUpperCase()}-${index.toString().padStart(4, '0')}`,
    name: `${first} ${last}`,
    branch,
    joined_at,
    status,
    tier,
    manager_id,
  };
}

function buildProductivity(
  tenant_id: string,
  agent: Agent,
  period: string,
): AgentProductivity {
  const seed = fnv1a(`prod|${tenant_id}|${agent.agent_id}|${period}`);
  const r = rng(seed);

  // If terminated for the whole month → all zeros + null rank.
  // suspended / on_leave → reduced volume.
  const wasInactive = agent.status === 'terminated';
  const wasReduced = agent.status === 'suspended' || agent.status === 'on_leave';

  const tierMultiplier = agent.tier === 'gold' ? 2.5 : agent.tier === 'silver' ? 1.5 : 1.0;
  const baselinePolicies = wasInactive ? 0 : Math.floor((5 + r() * 25) * tierMultiplier);
  const policies_sold = wasReduced ? Math.floor(baselinePolicies * 0.4) : baselinePolicies;
  const premium_per_policy = 50_000 + Math.floor(r() * 200_000); // 50k-250k KES
  const premium_collected_kes = policies_sold * premium_per_policy;
  // Higher tier → better persistency on average. Bronze 65-90, silver 75-93, gold 82-96.
  const baseP = agent.tier === 'gold' ? 82 : agent.tier === 'silver' ? 75 : 65;
  const persistency_pct = wasInactive ? 0 : Math.round((baseP + r() * 14) * 10) / 10;
  const lapse_count = wasInactive ? 0 : Math.floor(policies_sold * (1 - persistency_pct / 100) * 0.8);
  const complaints_count = Math.floor(r() * 4); // 0-3
  const conversion_pct = wasInactive ? 0 : Math.round((10 + r() * 35) * 10) / 10; // 10-45%

  // Rank: 1 = top, null when policies_sold = 0 (stays out of leaderboard).
  // Within the stub we just hash to a 1-N rank deterministically.
  const branch_rank = policies_sold === 0 ? null : 1 + (seed % 10);

  return {
    agent_id: agent.agent_id,
    period,
    policies_sold,
    premium_collected_kes,
    persistency_pct,
    lapse_count,
    complaints_count,
    conversion_pct,
    branch_rank,
  };
}

// ─── Stub adapter ──────────────────────────────────────────────────────

export class StubAgentAdapter implements AgentAdapter {
  async list(
    tenant_id: string,
    opts: { tier?: AgentTier; status?: AgentStatus; page?: number; page_size?: number },
    _asOf: Date,
  ): Promise<AgentListPage> {
    const all: Agent[] = [];
    for (let i = 0; i < FLEET_SIZE; i++) {
      all.push(buildAgent(tenant_id, i));
    }
    const filtered = all.filter((a) => {
      if (opts.tier && a.tier !== opts.tier) return false;
      if (opts.status && a.status !== opts.status) return false;
      return true;
    });
    const page = Math.max(1, opts.page ?? 1);
    const page_size = Math.max(1, Math.min(100, opts.page_size ?? 25));
    const start = (page - 1) * page_size;
    return {
      items: filtered.slice(start, start + page_size),
      page,
      page_size,
      total: filtered.length,
      filter: opts.tier || opts.status ? { tier: opts.tier, status: opts.status } : null,
    };
  }

  async get(tenant_id: string, agent_id: string): Promise<Agent | null> {
    if (!tenant_id || !agent_id) return null;
    const m = agent_id.match(new RegExp(`^AGT-${tenant_id.slice(0, 3).toUpperCase()}-(\\d{4})$`));
    if (!m) return null;
    const idx = parseInt(m[1]!, 10);
    if (idx < 0 || idx >= FLEET_SIZE) return null;
    return buildAgent(tenant_id, idx);
  }

  async getProductivity(
    tenant_id: string,
    agent_id: string,
    opts: { period?: string },
    asOf: Date,
  ): Promise<AgentProductivity | null> {
    if (opts.period !== undefined && !isValidPeriod(opts.period)) {
      throw new AgentError('invalid_period', `period must be YYYY-MM (got ${opts.period})`);
    }
    const agent = await this.get(tenant_id, agent_id);
    if (!agent) return null;
    const period = opts.period ?? periodOf(asOf);
    return buildProductivity(tenant_id, agent, period);
  }

  async listProductivity(
    tenant_id: string,
    agent_id: string,
    months: number,
    asOf: Date,
  ): Promise<AgentProductivity[]> {
    const m = Math.max(1, Math.min(36, months));
    const agent = await this.get(tenant_id, agent_id);
    if (!agent) return [];
    const out: AgentProductivity[] = [];
    const cur = periodOf(asOf);
    for (let i = 0; i < m; i++) {
      out.push(buildProductivity(tenant_id, agent, priorPeriod(cur, i)));
    }
    return out; // already newest-first (i=0 is current)
  }
}

/** Module-level singleton used by routes when no override is supplied. */
export const defaultAgentAdapter: AgentAdapter = new StubAgentAdapter();
