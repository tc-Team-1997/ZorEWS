// services/bff/src/rules/seed.ts
//
// Hand-tuned seed rules covering every state in the maker-checker
// lifecycle and at least three product categories. Used by the BFF
// in-memory store.

import type { RuleV2 } from './types';

export const SEED_RULES: RuleV2[] = [
  // ── ACTIVE rules (live in production) ─────────────────────────────
  {
    id: 'r-22',
    name: 'Salary inflow stopped 60d',
    family: 'Behavioural',
    applicable_products: ['personal_loan', 'credit_card'],
    state: 'active',
    version: '2.1.0',
    owner_id: 'risk.maker.alpha',
    submitted_by: 'risk.maker.alpha',
    approved_by: 'risk.checker.delta',
    conditions: {
      kind: 'group',
      op: 'AND',
      children: [
        {
          kind: 'leaf',
          condition: {
            variable_id: 'salary_credit_consistency',
            op: '<',
            value: 0.2,
            window_days: 60,
          },
        },
      ],
    },
    outcome: {
      severity: 'critical',
      alert_priority: 'P1',
      notify_roles: ['risk_analyst', 'branch_manager'],
      reason_template: 'Salary inflow gap > 60 days — likely employment loss',
    },
    regulatory_ref: 'Internal SOP §4.2 (income-shock detection)',
    created_at: '2026-01-12T08:00:00Z',
    updated_at: '2026-04-22T11:30:00Z',
    audit: [
      {
        ts: '2026-01-12T08:00:00Z',
        actor_id: 'risk.maker.alpha',
        actor_role: 'risk_analyst',
        kind: 'created',
        to_state: 'draft',
        version: '1.0.0',
      },
      {
        ts: '2026-01-13T09:15:00Z',
        actor_id: 'risk.checker.delta',
        actor_role: 'supervisor',
        kind: 'approved',
        to_state: 'approved',
        version: '1.0.0',
      },
      {
        ts: '2026-01-13T11:00:00Z',
        actor_id: 'cro.kumar',
        actor_role: 'admin',
        kind: 'activated',
        to_state: 'active',
        version: '1.0.0',
      },
      {
        ts: '2026-04-22T11:30:00Z',
        actor_id: 'risk.maker.alpha',
        actor_role: 'risk_analyst',
        kind: 'edited',
        to_state: 'active',
        version: '2.1.0',
        comment: 'Tightened threshold to 60 days based on Q1 backtest',
      },
    ],
  },
  {
    id: 'r-09',
    name: 'DPD ≥ 30 + utilisation > 95%',
    family: 'Financial',
    applicable_products: ['credit_card'],
    state: 'active',
    version: '1.4.0',
    owner_id: 'risk.maker.beta',
    submitted_by: 'risk.maker.beta',
    approved_by: 'risk.checker.delta',
    conditions: {
      kind: 'group',
      op: 'AND',
      children: [
        { kind: 'leaf', condition: { variable_id: 'current_dpd', op: '>=', value: 30 } },
        { kind: 'leaf', condition: { variable_id: 'utilization', op: '>', value: 0.95 } },
      ],
    },
    outcome: {
      severity: 'high',
      alert_priority: 'P2',
      notify_roles: ['collection_officer', 'supervisor'],
      reason_template: 'Card customer maxed out + 30d behind — collections priority',
    },
    regulatory_ref: 'RBI Master Circular on Credit Card Operations',
    created_at: '2026-02-01T08:00:00Z',
    updated_at: '2026-04-18T14:20:00Z',
    audit: [
      {
        ts: '2026-02-01T08:00:00Z',
        actor_id: 'risk.maker.beta',
        actor_role: 'risk_analyst',
        kind: 'created',
        to_state: 'draft',
      },
      {
        ts: '2026-02-02T10:00:00Z',
        actor_id: 'risk.checker.delta',
        actor_role: 'supervisor',
        kind: 'approved',
        to_state: 'approved',
      },
      {
        ts: '2026-02-02T16:00:00Z',
        actor_id: 'cro.kumar',
        actor_role: 'admin',
        kind: 'activated',
        to_state: 'active',
      },
    ],
  },

  // ── PENDING_REVIEW (waiting on a checker) ─────────────────────────
  {
    id: 'r-14',
    name: 'Cheque return 2× in 30d',
    family: 'Transaction',
    applicable_products: ['msme'],
    state: 'pending_review',
    version: '0.9.0',
    owner_id: 'fraud.maker.gamma',
    submitted_by: 'fraud.maker.gamma',
    approved_by: null,
    conditions: {
      kind: 'group',
      op: 'AND',
      children: [
        {
          kind: 'leaf',
          condition: {
            variable_id: 'cheque_return_count_30d',
            op: '>=',
            value: 2,
            window_days: 30,
          },
        },
      ],
    },
    outcome: {
      severity: 'medium',
      alert_priority: 'P3',
      notify_roles: ['risk_analyst'],
    },
    created_at: '2026-04-25T09:00:00Z',
    updated_at: '2026-04-26T15:30:00Z',
    audit: [
      {
        ts: '2026-04-25T09:00:00Z',
        actor_id: 'fraud.maker.gamma',
        actor_role: 'risk_analyst',
        kind: 'created',
        to_state: 'draft',
      },
      {
        ts: '2026-04-26T15:30:00Z',
        actor_id: 'fraud.maker.gamma',
        actor_role: 'risk_analyst',
        kind: 'submitted',
        to_state: 'pending_review',
      },
    ],
  },

  // ── DRAFT (still being edited) ────────────────────────────────────
  {
    id: 'r-03',
    name: 'Bureau enquiry surge',
    family: 'Credit',
    applicable_products: [],
    state: 'draft',
    version: '0.2.0',
    owner_id: 'risk.maker.alpha',
    conditions: {
      kind: 'group',
      op: 'AND',
      children: [
        {
          kind: 'leaf',
          condition: { variable_id: 'enquiries_30d', op: '>=', value: 3 },
        },
      ],
    },
    outcome: {
      severity: 'low',
      alert_priority: 'P4',
      notify_roles: ['risk_analyst'],
    },
    created_at: '2026-04-26T11:00:00Z',
    updated_at: '2026-04-28T08:00:00Z',
    audit: [
      {
        ts: '2026-04-26T11:00:00Z',
        actor_id: 'risk.maker.alpha',
        actor_role: 'risk_analyst',
        kind: 'created',
        to_state: 'draft',
      },
    ],
  },

  // ── APPROVED (waiting on the activator) ───────────────────────────
  {
    id: 'r-18',
    name: 'Sudden cash withdrawal pattern',
    family: 'Transaction',
    applicable_products: ['personal_loan', 'credit_card'],
    state: 'approved',
    version: '1.0.1',
    owner_id: 'aml.maker.kappa',
    submitted_by: 'aml.maker.kappa',
    approved_by: 'risk.checker.delta',
    conditions: {
      kind: 'group',
      op: 'OR',
      children: [
        {
          kind: 'leaf',
          condition: { variable_id: 'cash_withdrawal_pct_income', op: '>', value: 0.6 },
        },
        {
          kind: 'leaf',
          condition: { variable_id: 'atm_declined_count_30d', op: '>=', value: 7 },
        },
      ],
    },
    outcome: {
      severity: 'high',
      alert_priority: 'P2',
      notify_roles: ['supervisor', 'collection_officer'],
    },
    regulatory_ref: 'AML monitoring SOP §3.1',
    created_at: '2026-04-15T08:00:00Z',
    updated_at: '2026-04-27T12:00:00Z',
    audit: [
      {
        ts: '2026-04-15T08:00:00Z',
        actor_id: 'aml.maker.kappa',
        actor_role: 'risk_analyst',
        kind: 'created',
        to_state: 'draft',
      },
      {
        ts: '2026-04-25T10:00:00Z',
        actor_id: 'aml.maker.kappa',
        actor_role: 'risk_analyst',
        kind: 'submitted',
        to_state: 'pending_review',
      },
      {
        ts: '2026-04-27T12:00:00Z',
        actor_id: 'risk.checker.delta',
        actor_role: 'supervisor',
        kind: 'approved',
        to_state: 'approved',
      },
    ],
  },

  // ── DEPRECATED (retired) ──────────────────────────────────────────
  {
    id: 'r-25',
    name: 'Multi-bureau delinquency confirmed',
    family: 'Credit',
    applicable_products: [],
    state: 'deprecated',
    version: '0.5.0',
    owner_id: 'risk.maker.beta',
    submitted_by: 'risk.maker.beta',
    approved_by: 'risk.checker.delta',
    conditions: {
      kind: 'group',
      op: 'AND',
      children: [{ kind: 'leaf', condition: { variable_id: 'bureau_score_delta_90d', op: '<', value: -50 } }],
    },
    outcome: {
      severity: 'critical',
      alert_priority: 'P1',
      notify_roles: ['supervisor', 'branch_manager'],
    },
    created_at: '2025-09-10T08:00:00Z',
    updated_at: '2026-03-30T16:00:00Z',
    audit: [
      {
        ts: '2025-09-10T08:00:00Z',
        actor_id: 'risk.maker.beta',
        actor_role: 'risk_analyst',
        kind: 'created',
        to_state: 'draft',
      },
      {
        ts: '2026-03-30T16:00:00Z',
        actor_id: 'cro.kumar',
        actor_role: 'admin',
        kind: 'deprecated',
        to_state: 'deprecated',
        comment: 'Replaced by r-09 + bureau-score Δ check inside r-22',
      },
    ],
  },
];
