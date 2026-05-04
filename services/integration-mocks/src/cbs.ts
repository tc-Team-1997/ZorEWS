// services/integration-mocks/src/cbs.ts
//
// Mocks the bank's CBS (Finacle/Flexcube-style). REST surface only — Kafka
// is the primary data path in the real integration, but for the prototype
// we stand up the snapshot/replay endpoints so back-fill flows can be
// exercised without a real CBS.

import { Router } from 'express';
import { chaos } from './chaos';

interface CbsCustomer {
  customer_id: string;
  full_name: string;
  national_id: string;
  segment: 'retail' | 'sme' | 'corporate';
  branch_code: string;
  joined_at: string;
}

interface CbsLoan {
  loan_id: string;
  customer_id: string;
  product: 'mortgage' | 'auto' | 'personal' | 'sme';
  principal_kes: number;
  outstanding_kes: number;
  emi_kes: number;
  interest_rate_pct: number;
  status: 'ACTIVE' | 'CLOSED' | 'WRITTEN_OFF';
  dpd: number;
  opened_at: string;
}

const SEGMENTS: CbsCustomer['segment'][] = ['retail', 'sme', 'corporate'];
const PRODUCTS: CbsLoan['product'][] = ['mortgage', 'auto', 'personal', 'sme'];

function customer(id: string): CbsCustomer {
  const idx = parseInt(id.replace(/\D/g, '').slice(-3) || '1', 10);
  return {
    customer_id: id,
    full_name: ['Achieng Otieno', 'Brian Kamau', 'Cynthia Mwangi', 'Daniel Wanjiku'][idx % 4]!,
    national_id: `K${(20000000 + idx).toString().slice(0, 8)}`,
    segment: SEGMENTS[idx % 3]!,
    branch_code: `BR-${100 + (idx % 24)}`,
    joined_at: new Date(Date.now() - (300 + (idx % 1500)) * 86400000).toISOString(),
  };
}

function loan(id: string, customer_id?: string): CbsLoan {
  const idx = parseInt(id.replace(/\D/g, '').slice(-3) || '1', 10);
  const principal = 100_000 + (idx % 50) * 80_000;
  return {
    loan_id: id,
    customer_id: customer_id ?? `c-${1000 + (idx % 240)}`,
    product: PRODUCTS[idx % 4]!,
    principal_kes: principal,
    outstanding_kes: Math.round(principal * (0.3 + ((idx * 13) % 70) / 100)),
    emi_kes: Math.round(principal / (12 + (idx % 48))),
    interest_rate_pct: 9 + (idx % 9),
    status: idx % 17 === 0 ? 'WRITTEN_OFF' : idx % 9 === 0 ? 'CLOSED' : 'ACTIVE',
    dpd: idx % 31 === 0 ? 90 + (idx % 60) : idx % 7 === 0 ? 30 + (idx % 30) : 0,
    opened_at: new Date(Date.now() - (60 + (idx % 1800)) * 86400000).toISOString(),
  };
}

export function cbsRouter(): Router {
  const r = Router();
  r.use(chaos('cbs'));

  r.get('/cbs/customers/:customer_id', (req, res) => {
    res.json(customer(req.params.customer_id));
  });

  r.get('/cbs/loans/:loan_id', (req, res) => {
    res.json(loan(req.params.loan_id));
  });

  r.get('/cbs/loans', (req, res) => {
    const status = (req.query.status as string | undefined) ?? 'ACTIVE';
    const page = Math.max(1, parseInt((req.query.page as string) ?? '1', 10) || 1);
    const page_size = Math.min(
      1000,
      Math.max(1, parseInt((req.query.page_size as string) ?? '50', 10) || 50),
    );
    const total = 520; // matches the dbt seed
    const start = (page - 1) * page_size;
    const items: CbsLoan[] = [];
    for (let i = 0; i < page_size && start + i < total; i++) {
      const id = `l-${10000 + start + i}`;
      const lo = loan(id);
      if (status !== 'ALL' && lo.status !== status) continue;
      items.push(lo);
    }
    res.json({ page, page_size, total, items });
  });

  r.post('/cbs/replay', (req, res) => {
    const { from, to, topics } = (req.body ?? {}) as {
      from?: string;
      to?: string;
      topics?: string[];
    };
    if (!from || !to) {
      return res.status(400).json({ error: 'from and to are required ISO timestamps' });
    }
    const job_id = `replay-${Date.now()}-${Math.floor(Math.random() * 9999)}`;
    res.status(202).json({
      job_id,
      from,
      to,
      topics: topics ?? ['apex.cbs.events'],
      estimated_events: 4000 + Math.floor(Math.random() * 8000),
      status: 'queued',
    });
  });

  return r;
}
