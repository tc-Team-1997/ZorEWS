// services/integration-mocks/src/ifrs9.ts
//
// Mocks the bank's IFRS 9 engine. APEX EWS reads stage assignments
// (Stage 1 = performing, Stage 2 = SICR, Stage 3 = NPA) and pushes
// model inputs (PD, LGD, EAD) for ECL calculation.

import { Router } from 'express';
import { chaos } from './chaos';

interface StageRow {
  customer_id: string;
  loan_id: string;
  current_stage: 1 | 2 | 3;
  prior_stage: 1 | 2 | 3;
  changed_at: string;
  reason: 'sicr_breach' | 'cure' | 'dpd_threshold' | 'restructure';
}

const REASONS: StageRow['reason'][] = ['sicr_breach', 'cure', 'dpd_threshold', 'restructure'];

function stageFor(customer_id: string): StageRow {
  const idx = parseInt(customer_id.replace(/\D/g, '').slice(-3) || '1', 10);
  const current = idx % 11 === 0 ? 3 : idx % 5 === 0 ? 2 : 1;
  const prior = idx % 13 === 0 ? Math.min(3, current + 1) : current;
  return {
    customer_id,
    loan_id: `l-${10000 + (idx * 17) % 520}`,
    current_stage: current as 1 | 2 | 3,
    prior_stage: prior as 1 | 2 | 3,
    changed_at: new Date(Date.now() - (idx % 60) * 86400000).toISOString(),
    reason: REASONS[idx % REASONS.length]!,
  };
}

export function ifrs9Router(): Router {
  const r = Router();
  r.use(chaos('ifrs9'));

  r.get('/ifrs9/stages/:customer_id', (req, res) => {
    res.json(stageFor(req.params.customer_id));
  });

  r.post('/ifrs9/inputs', (req, res) => {
    const body = (req.body ?? {}) as {
      customer_id?: string;
      loan_id?: string;
      pd?: number;
      lgd?: number;
      ead_kes?: number;
      horizon_months?: number;
    };
    if (!body.customer_id || !body.loan_id) {
      return res.status(400).json({ error: 'customer_id and loan_id required' });
    }
    if (typeof body.pd !== 'number' || body.pd < 0 || body.pd > 1) {
      return res.status(400).json({ error: 'pd must be 0..1' });
    }
    if (typeof body.lgd !== 'number' || body.lgd < 0 || body.lgd > 1) {
      return res.status(400).json({ error: 'lgd must be 0..1' });
    }
    if (typeof body.ead_kes !== 'number' || body.ead_kes < 0) {
      return res.status(400).json({ error: 'ead_kes must be >= 0' });
    }
    const horizon = body.horizon_months ?? 12;
    const ecl_kes = Math.round(body.ead_kes * body.pd * body.lgd);
    res.status(202).json({
      submission_id: `ifrs9-${Date.now()}`,
      customer_id: body.customer_id,
      loan_id: body.loan_id,
      horizon_months: horizon,
      ecl_kes,
      status: 'accepted',
    });
  });

  return r;
}
