// services/integration-mocks/src/aml.ts
//
// Mocks the AML (Anti-Money-Laundering) hub. APEX EWS pushes suspicious
// transaction flags inbound and consumes the AML engine's verdicts on
// the way back out.

import { Router } from 'express';
import { chaos } from './chaos';

interface InboundFlag {
  flag_id: string;
  customer_id: string;
  transaction_id: string;
  reason_code: string;
  raised_at: string;
}

interface OutboundVerdict {
  verdict_id: string;
  flag_id: string;
  customer_id: string;
  decision: 'cleared' | 'sar_filed' | 'monitor' | 'frozen';
  ruling: string;
  decided_at: string;
}

const REASONS = ['structuring', 'velocity_spike', 'high_risk_geo', 'pep_match'] as const;
const DECISIONS: OutboundVerdict['decision'][] = ['cleared', 'sar_filed', 'monitor', 'frozen'];

export function amlRouter(): Router {
  const r = Router();
  r.use(chaos('aml'));

  r.post('/aml/inbound', (req, res) => {
    const flag = (req.body ?? {}) as Partial<InboundFlag>;
    const errs: string[] = [];
    if (!flag.customer_id) errs.push('customer_id is required');
    if (!flag.transaction_id) errs.push('transaction_id is required');
    if (errs.length) return res.status(400).json({ error: errs.join('; ') });
    const flag_id = `aml-${Date.now()}-${Math.floor(Math.random() * 9999)}`;
    const reason_code = flag.reason_code ?? REASONS[Math.floor(Math.random() * REASONS.length)]!;
    res.status(202).json({
      flag_id,
      customer_id: flag.customer_id,
      transaction_id: flag.transaction_id,
      reason_code,
      raised_at: new Date().toISOString(),
      status: 'queued',
    });
  });

  r.get('/aml/outbound', (req, res) => {
    const since = (req.query.since as string | undefined) ?? '';
    const limit = Math.min(
      500,
      Math.max(1, parseInt((req.query.limit as string) ?? '50', 10) || 50),
    );
    const items: OutboundVerdict[] = [];
    const now = Date.now();
    for (let i = 0; i < limit; i++) {
      const decided = new Date(now - i * 90_000);
      if (since && decided.toISOString() < since) break;
      items.push({
        verdict_id: `vrd-${now}-${i}`,
        flag_id: `aml-${now - 3_600_000 - i * 90_000}`,
        customer_id: `c-${1000 + ((i * 7) % 240)}`,
        decision: DECISIONS[(i * 3) % DECISIONS.length]!,
        ruling: ['no further action', 'flag escalated', 'continue monitoring', 'block account'][
          (i * 3) % 4
        ]!,
        decided_at: decided.toISOString(),
      });
    }
    res.json({ items, count: items.length });
  });

  return r;
}
