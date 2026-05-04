// Standalone tuning runner that does not require npm install.
//
// Mirrors the logic in src/gen_history.ts and src/simulator.ts in pure CommonJS
// so we can validate-and-tune the seed rules end-to-end without network access.
// The TypeScript versions remain the canonical implementation; this file is a
// debugging aid kept in sync manually.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const CATALOG_PATH = path.join(ROOT, 'services', 'regulatory-svc', 'indicators', 'catalog.json');
const SEED_DIR = path.join(ROOT, 'rules', 'seed');
const HISTORY_PATH = path.join(ROOT, 'rules', 'sim', 'indicator_history.csv');
const REPORT_PATH = path.join(ROOT, 'rules', 'sim', 'report.json');
const SCHEMA_PATH = path.join(ROOT, 'rules', 'dsl.schema.json');

const SEED = Number(process.env.APEX_SIM_SEED || 20260426);
const N_CUSTOMERS = Number(process.env.APEX_SIM_CUSTOMERS || 250);
const N_MONTHS = 12;
const DEFAULT_RATE = 0.18;

class Rng {
  constructor(seed) { this.state = seed >>> 0; }
  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  uniform(a, b) { return a + (b - a) * this.next(); }
  normal(m = 0, s = 1) {
    const u1 = Math.max(this.next(), 1e-12);
    const u2 = this.next();
    return m + s * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  bernoulli(p) { return this.next() < p; }
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function sampleIndicator(rng, id, s) {
  switch (id) {
    case 'FIN-001': return clamp(rng.normal(0.05 + 0.55 * s, 0.12), -0.2, 0.95);
    case 'FIN-002': return clamp(Math.round(rng.normal(2 + 18 * s, 3)), 0, 30);
    case 'FIN-003': return clamp(rng.normal(0.6 - 0.5 * s, 0.25), 0.01, 3);
    case 'FIN-004': return clamp(rng.normal(0.18 + 0.45 * s, 0.1), 0, 1.5);
    case 'FIN-005': return rng.normal(1.3 - 1.4 * s, 0.3);
    case 'FIN-006': return clamp(Math.round(rng.normal(0 + 2.2 * s, 0.6)), 0, 6);
    case 'FIN-007': return clamp(rng.normal(2 + 5 * s, 1.2), 0.2, 12);
    case 'FIN-008': return clamp(rng.normal(0.25 + 0.55 * s, 0.15), 0, 1.1);
    case 'BEH-001': return clamp(rng.normal(1 + 22 * s, 3), 0, 90);
    case 'BEH-002': return clamp(Math.round(rng.normal(0 + 4 * s, 1)), 0, 12);
    case 'BEH-003': return clamp(rng.normal(0.05 + 0.55 * s, 0.12), 0, 1);
    case 'BEH-004': return clamp(rng.normal(0 + 0.55 * s, 0.18), -0.5, 1);
    case 'BEH-005': return clamp(Math.round(rng.normal(0 + 2.5 * s, 1)), 0, 10);
    case 'BEH-006': return Math.round(rng.normal(180 - 220 * s, 60));
    case 'BEH-007': return rng.bernoulli(0.005 + 0.5 * s) ? 1 : 0;
    case 'BEH-008': return clamp(Math.round(rng.normal(0 + 5 * s, 1.4)), 0, 15);
    case 'TXN-001': return clamp(rng.normal(0.85 + 0.55 * s, 0.15), 0.1, 3);
    case 'TXN-002': return rng.normal(0 + 2.2 * s, 0.7);
    case 'TXN-003': return clamp(rng.normal(0.18 + 0.4 * s, 0.12), 0, 1);
    case 'TXN-004': return clamp(rng.normal(0 + 0.45 * s, 0.18), -0.4, 1);
    case 'TXN-005': return clamp(Math.round(rng.normal(0 + 3 * s, 1)), 0, 12);
    case 'TXN-006': return clamp(rng.normal(0.35 + 0.4 * s, 0.12), 0.1, 1);
    case 'TXN-007': return clamp(rng.normal(1 + 2.5 * s, 0.6), 0.2, 8);
    case 'TXN-008': return rng.normal(0 + 0.18 * s, 0.1);
    case 'CRD-001': return clamp(Math.round(rng.normal(0 + 80 * s, 20)), -50, 250);
    case 'CRD-002': return clamp(Math.round(rng.normal(0 + 4 * s, 1.2)), 0, 12);
    case 'CRD-003': return clamp(Math.round(rng.normal(0 + 65 * s, 12)), 0, 180);
    case 'CRD-004': return rng.normal(0.05 + 0.6 * s, 0.18);
    case 'CRD-005': {
      if (!rng.bernoulli(0.005 + 0.75 * s)) return 0;
      return rng.bernoulli(0.4 * s) ? 2 : 1;
    }
    case 'CRD-006': return clamp(Math.round(rng.normal(0 + 55 * s, 10)), 0, 180);
    case 'CRD-007': return clamp(rng.normal(1.4 - 0.9 * s, 0.25), 0.1, 3);
    case 'CRD-008': return rng.bernoulli(0.005 + 0.3 * s) ? 1 : 0;
    default: return 0;
  }
}

function generateHistory() {
  const cat = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const ids = cat.indicators.map((i) => i.id);
  const rng = new Rng(SEED);
  const profiles = [];
  for (let i = 0; i < N_CUSTOMERS; i++) {
    const defaults = rng.bernoulli(DEFAULT_RATE);
    profiles.push({
      id: `CUST-${String(i + 1).padStart(5, '0')}`,
      defaults,
      defaultMonth: defaults ? 3 + Math.floor(rng.uniform(0, N_MONTHS - 3)) : -1,
    });
  }
  const rows = [];
  for (const p of profiles) {
    for (let m = 0; m < N_MONTHS; m++) {
      const monthsToDefault = p.defaults ? p.defaultMonth - m : 99;
      if (p.defaults && monthsToDefault < 0) continue;
      let stress = 0;
      if (p.defaults && monthsToDefault >= 0 && monthsToDefault <= 2) {
        stress = 1 - monthsToDefault / 3;
      }
      stress += rng.uniform(-0.05, 0.05);
      stress = clamp(stress, 0, 1);
      const values = {};
      for (const id of ids) values[id] = Math.round(sampleIndicator(rng, id, stress) * 10000) / 10000;
      const within60 = p.defaults && monthsToDefault >= 0 && monthsToDefault <= 2 ? 1 : 0;
      rows.push({ customer_id: p.id, month: m, defaulted_within_60d: within60, values });
    }
  }
  // write csv
  const header = ['customer_id', 'month', 'defaulted_within_60d', ...ids];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.customer_id, r.month, r.defaulted_within_60d, ...ids.map((id) => r.values[id])].join(','));
  }
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, lines.join('\n') + '\n');
  return { rows, ids, customers: profiles.length };
}

function evalCmp(c, v) {
  if (v === null || v === undefined || Number.isNaN(v)) return false;
  switch (c.op) {
    case 'gt': return v > Number(c.value);
    case 'gte': return v >= Number(c.value);
    case 'lt': return v < Number(c.value);
    case 'lte': return v <= Number(c.value);
    case 'eq': return v === Number(c.value);
    case 'between': return c.range && v >= c.range[0] && v <= c.range[1];
  }
  return false;
}
function evalExpr(e, vals) {
  if (e.indicator) return evalCmp(e, vals[e.indicator]);
  if (e.and) return e.and.every((s) => evalExpr(s, vals));
  if (e.or) return e.or.some((s) => evalExpr(s, vals));
  if (e.not) return !evalExpr(e.not, vals);
  return false;
}

function loadSeedRules() {
  return fs
    .readdirSync(SEED_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(SEED_DIR, f), 'utf8')));
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  const m = Math.floor(n / 2);
  return n % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function simulateRule(rule, rows) {
  const byCustomer = new Map();
  for (const r of rows) {
    let arr = byCustomer.get(r.customer_id);
    if (!arr) byCustomer.set(r.customer_id, (arr = []));
    arr.push(r);
  }
  let firings = 0, tp = 0, fp = 0;
  const fired = new Set();
  const leadDays = [];
  for (const [cust, arr] of byCustomer) {
    arr.sort((a, b) => a.month - b.month);
    let firstFire = -1, firstLabel = -1;
    for (const r of arr) {
      const f = evalExpr(rule.when, r.values);
      if (f) {
        firings++;
        if (firstFire < 0) firstFire = r.month;
        if (r.defaulted_within_60d === 1) tp++; else fp++;
      }
      if (r.defaulted_within_60d === 1 && firstLabel < 0) firstLabel = r.month;
    }
    if (firstFire >= 0) {
      fired.add(cust);
      if (firstLabel >= 0) {
        const dm = firstLabel - firstFire;
        if (dm >= 0) leadDays.push(dm * 30);
      }
    }
  }
  const fpRate = firings === 0 ? 0 : fp / firings;
  return {
    rule_id: rule.id,
    total_firings: firings,
    fp_rate: Math.round(fpRate * 1000) / 1000,
    median_lead_time_days: median(leadDays) === null ? null : Math.round(median(leadDays)),
    customers_fired: fired.size,
    true_positives: tp,
    false_positives: fp,
  };
}

// schema check (lightweight): every indicator must exist in catalog and ids must match pattern
function collectIds(e, acc = new Set()) {
  if (e.indicator) acc.add(e.indicator);
  else if (e.and) e.and.forEach((s) => collectIds(s, acc));
  else if (e.or) e.or.forEach((s) => collectIds(s, acc));
  else if (e.not) collectIds(e.not, acc);
  return acc;
}

function main() {
  const action = process.argv[2] || 'all';
  if (action === 'gen' || action === 'all') {
    const out = generateHistory();
    console.log(`history: ${out.rows.length} rows, ${out.customers} customers, ${out.ids.length} indicators`);
  }
  if (action === 'sim' || action === 'all') {
    const rows = [];
    const txt = fs.readFileSync(HISTORY_PATH, 'utf8').trim().split('\n');
    const header = txt[0].split(',');
    const idCols = header.slice(3);
    for (let i = 1; i < txt.length; i++) {
      const c = txt[i].split(',');
      const values = {};
      for (let j = 0; j < idCols.length; j++) values[idCols[j]] = Number(c[3 + j]);
      rows.push({ customer_id: c[0], month: Number(c[1]), defaulted_within_60d: Number(c[2]), values });
    }
    const cat = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    const catIds = new Set(cat.indicators.map((i) => i.id));
    const seeds = loadSeedRules();
    const results = [];
    for (const r of seeds) {
      // validate indicator references
      for (const id of collectIds(r.when)) {
        if (!catIds.has(id)) { console.error(`bad rule ${r.id}: unknown indicator ${id}`); process.exit(1); }
      }
      results.push(simulateRule(r, rows));
    }
    const meanFp = results.reduce((a, b) => a + b.fp_rate, 0) / results.length;
    const report = {
      generated_at: new Date().toISOString(),
      history_rows: rows.length,
      rules_simulated: results.length,
      mean_fp_rate: Math.round(meanFp * 1000) / 1000,
      rules: results,
    };
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
    console.log(`history_rows=${report.history_rows} rules=${report.rules_simulated} mean_fp=${report.mean_fp_rate}`);
    for (const r of results) {
      const lead = r.median_lead_time_days === null ? '   -' : `${String(r.median_lead_time_days).padStart(3)}d`;
      console.log(`${r.rule_id}  fp=${r.fp_rate.toFixed(3)}  fires=${String(r.total_firings).padStart(4)}  tp=${String(r.true_positives).padStart(3)}  fp=${String(r.false_positives).padStart(3)}  customers=${String(r.customers_fired).padStart(3)}  lead=${lead}`);
    }
    // also print over-threshold list
    const over = results.filter((r) => r.fp_rate > 0.25);
    console.log(`\nover_threshold_count=${over.length}: ${over.map((r) => `${r.rule_id}(${r.fp_rate})`).join(', ')}`);
  }
}
main();
