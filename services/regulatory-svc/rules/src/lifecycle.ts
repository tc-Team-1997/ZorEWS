// Rule lifecycle: draft → simulate → live → retired.
//
// All state transitions are appended to an in-memory audit log. Each entry is
// marked `// emit to apex.audit.events` so agent-integration / agent-alert can
// later wire this to the real audit topic.

import { Rule, RuleStatus } from '../../../../rules/types';
import { validateRule } from './dsl';

export interface AuditEvent {
  ts: string;
  rule_id: string;
  from: RuleStatus | null;
  to: RuleStatus;
  actor: string;
  detail?: Record<string, unknown>;
}

export interface SimulationSummary {
  rule_id: string;
  total_firings: number;
  fp_rate: number;
  median_lead_time_days: number | null;
}

export class RuleStore {
  private rules = new Map<string, Rule>();
  private sims = new Map<string, SimulationSummary>();
  public audit: AuditEvent[] = [];

  /** The minimum simulator-pass criteria the orchestrator demanded: FP rate ≤ 0.25. */
  static readonly MAX_FP_RATE = 0.25;

  list(): Rule[] {
    return Array.from(this.rules.values());
  }

  get(id: string): Rule | undefined {
    return this.rules.get(id);
  }

  /** Create a draft rule. Validates against schema + catalog. */
  create(rule: Rule, actor = 'system'): Rule {
    const v = validateRule(rule);
    if (!v.ok) {
      const err = new Error(`rule validation failed: ${v.errors.join('; ')}`);
      (err as Error & { status?: number }).status = 400;
      throw err;
    }
    if (this.rules.has(rule.id)) {
      const err = new Error(`rule ${rule.id} already exists`);
      (err as Error & { status?: number }).status = 409;
      throw err;
    }
    const drafted: Rule = { ...rule, status: 'draft' };
    this.rules.set(rule.id, drafted);
    this.appendAudit({
      ts: new Date().toISOString(),
      rule_id: rule.id,
      from: null,
      to: 'draft',
      actor,
      detail: { version: rule.version },
    });
    return drafted;
  }

  /**
   * Run a simulation for a draft rule. Caller passes a pre-computed summary
   * (the simulator module computes it). On success, transitions draft→simulate.
   */
  recordSimulation(id: string, summary: SimulationSummary, actor = 'system'): SimulationSummary {
    const r = this.requireRule(id);
    if (r.status !== 'draft' && r.status !== 'simulate') {
      const err = new Error(`cannot simulate rule in status=${r.status}`);
      (err as Error & { status?: number }).status = 409;
      throw err;
    }
    this.sims.set(id, summary);
    const prev = r.status;
    r.status = 'simulate';
    this.appendAudit({
      ts: new Date().toISOString(),
      rule_id: id,
      from: prev,
      to: 'simulate',
      actor,
      detail: { ...summary },
    });
    return summary;
  }

  /** Promote simulate→live. Requires a recorded simulation with FP rate ≤ MAX_FP_RATE. */
  promote(id: string, actor = 'system'): Rule {
    const r = this.requireRule(id);
    if (r.status !== 'simulate') {
      const err = new Error(`promote requires status=simulate, got ${r.status}`);
      (err as Error & { status?: number }).status = 409;
      throw err;
    }
    const sim = this.sims.get(id);
    if (!sim) {
      const err = new Error(`promote requires a recorded simulation for ${id}`);
      (err as Error & { status?: number }).status = 409;
      throw err;
    }
    if (sim.fp_rate > RuleStore.MAX_FP_RATE) {
      const err = new Error(
        `promote refused: FP rate ${sim.fp_rate.toFixed(3)} > ${RuleStore.MAX_FP_RATE}`,
      );
      (err as Error & { status?: number }).status = 412;
      throw err;
    }
    const prev = r.status;
    r.status = 'live';
    this.appendAudit({
      ts: new Date().toISOString(),
      rule_id: id,
      from: prev,
      to: 'live',
      actor,
      detail: { fp_rate: sim.fp_rate },
    });
    return r;
  }

  /** Retire a rule. Allowed from any non-retired state. */
  retire(id: string, actor = 'system', reason?: string): Rule {
    const r = this.requireRule(id);
    if (r.status === 'retired') {
      const err = new Error(`rule ${id} already retired`);
      (err as Error & { status?: number }).status = 409;
      throw err;
    }
    const prev = r.status;
    r.status = 'retired';
    this.appendAudit({
      ts: new Date().toISOString(),
      rule_id: id,
      from: prev,
      to: 'retired',
      actor,
      detail: reason ? { reason } : undefined,
    });
    return r;
  }

  getSimulation(id: string): SimulationSummary | undefined {
    return this.sims.get(id);
  }

  private requireRule(id: string): Rule {
    const r = this.rules.get(id);
    if (!r) {
      const err = new Error(`rule ${id} not found`);
      (err as Error & { status?: number }).status = 404;
      throw err;
    }
    return r;
  }

  private appendAudit(ev: AuditEvent): void {
    // emit to apex.audit.events
    this.audit.push(ev);
  }
}
