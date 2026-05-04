// services/integration-mocks/src/collection.ts
//
// Mocks the bank's Collection system. APEX EWS pushes new cases inbound
// and the Collection system POSTs lifecycle callbacks back as cases
// progress (cured / promised / defaulted / etc.).

import { Router } from 'express';
import { chaos } from './chaos';

interface NewCase {
  case_id: string;
  customer_id: string;
  loan_id?: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  reason: string;
}

interface CallbackEnvelope {
  case_id: string;
  outcome: 'cured' | 'cured_temp' | 'defaulted';
  closed_at: string;
  note?: string;
}

export function collectionRouter(): Router {
  const r = Router();
  r.use(chaos('collection'));

  r.post('/collection/cases', (req, res) => {
    const body = (req.body ?? {}) as Partial<NewCase>;
    const errs: string[] = [];
    if (!body.case_id) errs.push('case_id is required');
    if (!body.customer_id) errs.push('customer_id is required');
    if (!body.severity) errs.push('severity is required');
    if (errs.length) return res.status(400).json({ error: errs.join('; ') });
    const queue = body.severity === 'critical' || body.severity === 'high'
      ? 'high-touch'
      : 'standard';
    res.status(202).json({
      case_id: body.case_id,
      assigned_queue: queue,
      assigned_team: queue === 'high-touch' ? 'collections-priority' : 'collections-bulk',
      acknowledged_at: new Date().toISOString(),
    });
  });

  // The "callback" the Collection system would normally POST inbound to
  // EWS. We expose it on this mock too so demos can fire one manually
  // (curl against this endpoint) and observe the path back.
  r.post('/ews/collection/callback', (req, res) => {
    const body = (req.body ?? {}) as Partial<CallbackEnvelope>;
    const errs: string[] = [];
    if (!body.case_id) errs.push('case_id is required');
    if (!body.outcome) errs.push('outcome is required');
    if (!body.closed_at) errs.push('closed_at is required');
    if (errs.length) return res.status(400).json({ error: errs.join('; ') });
    res.status(202).json({
      case_id: body.case_id,
      received_at: new Date().toISOString(),
      forwarded_to: 'apex.collection-adapter',
    });
  });

  return r;
}
