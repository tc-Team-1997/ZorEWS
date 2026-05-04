// Rule simulator. Replays the synthetic indicator history and emits per-rule
// firing stats: total_firings, fp_rate, median_lead_time_days.
//
// CLI:
//   ts-node src/simulator.ts                    -> simulate every rule in rules/seed
//   ts-node src/simulator.ts --rule RULE-001    -> only that rule
//   ts-node src/simulator.ts --report           -> write rules/sim/report.json
//
// FP rate definition: of all (customer, month) firings, the fraction whose
// label `defaulted_within_60d == 0`. A "true positive" requires that the
// customer defaulted within the 60-day window following the firing snapshot.
// Lead time = months between earliest firing and the customer's first labelled
// default month, expressed in days (×30).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Rule } from '../../../../rules/types';
import { evalExpr, validateRule } from './dsl';
import { SimulationSummary } from './lifecycle';

const HISTORY_PATH = path.resolve(__dirname, '..', '..', '..', '..', 'rules', 'sim', 'indicator_history.csv');
const SEED_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'rules', 'seed');
const REPORT_PATH = path.resolve(__dirname, '..', '..', '..', '..', 'rules', 'sim', 'report.json');

interface HistoryRow {
  customer_id: string;
  month: number;
  defaulted_within_60d: number;
  values: Record<string, number>;
}

export function loadHistory(p = HISTORY_PATH): HistoryRow[] {
  if (!fs.existsSync(p)) {
    throw new Error(
      `indicator history not found at ${p}. Run: npm run gen-history`,
    );
  }
  const txt = fs.readFileSync(p, 'utf8');
  const lines = txt.trim().split('\n');
  const header = lines[0].split(',');
  const idCols = header.slice(3); // customer_id, month, defaulted_within_60d, ...
  const rows: HistoryRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const values: Record<string, number> = {};
    for (let j = 0; j < idCols.length; j++) {
      values[idCols[j]] = Number(c[3 + j]);
    }
    rows.push({
      customer_id: c[0],
      month: Number(c[1]),
      defaulted_within_60d: Number(c[2]),
      values,
    });
  }
  return rows;
}

export function loadSeedRules(dir = SEED_DIR): Rule[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Rule);
}

export interface RuleSimResult extends SimulationSummary {
  customers_fired: number;
  true_positives: number;
  false_positives: number;
}

export function simulateRule(rule: Rule, history: HistoryRow[]): RuleSimResult {
  // group history by customer for lead-time calculation
  const byCustomer = new Map<string, HistoryRow[]>();
  for (const r of history) {
    let arr = byCustomer.get(r.customer_id);
    if (!arr) {
      arr = [];
      byCustomer.set(r.customer_id, arr);
    }
    arr.push(r);
  }

  let firings = 0;
  let truePositives = 0;
  let falsePositives = 0;
  const customersFired = new Set<string>();
  const leadTimesDays: number[] = [];

  for (const [cust, rows] of byCustomer) {
    rows.sort((a, b) => a.month - b.month);
    // first month at which the rule fires for this customer
    let firstFireMonth = -1;
    // first month at which the customer was labelled default-within-60d
    let firstLabelMonth = -1;
    for (const r of rows) {
      const fired = evalExpr(rule.when, r.values);
      if (fired) {
        firings += 1;
        if (firstFireMonth < 0) firstFireMonth = r.month;
        if (r.defaulted_within_60d === 1) truePositives += 1;
        else falsePositives += 1;
      }
      if (r.defaulted_within_60d === 1 && firstLabelMonth < 0) {
        firstLabelMonth = r.month;
      }
    }
    if (firstFireMonth >= 0) {
      customersFired.add(cust);
      if (firstLabelMonth >= 0) {
        // months between fire and label snapshot; convert to days (~30/mo)
        const leadMonths = firstLabelMonth - firstFireMonth;
        // a positive lead means we fired before the label flipped on
        if (leadMonths >= 0) leadTimesDays.push(leadMonths * 30);
      }
    }
  }

  const fpRate = firings === 0 ? 0 : falsePositives / firings;
  const medianLead = leadTimesDays.length === 0 ? null : median(leadTimesDays);

  return {
    rule_id: rule.id,
    total_firings: firings,
    fp_rate: round3(fpRate),
    median_lead_time_days: medianLead === null ? null : Math.round(medianLead),
    customers_fired: customersFired.size,
    true_positives: truePositives,
    false_positives: falsePositives,
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  const m = Math.floor(n / 2);
  return n % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export interface SimulatorReport {
  generated_at: string;
  history_rows: number;
  rules_simulated: number;
  mean_fp_rate: number;
  rules: RuleSimResult[];
}

export function buildReport(rules: Rule[], history: HistoryRow[]): SimulatorReport {
  const rs = rules.map((r) => simulateRule(r, history));
  const meanFp = rs.length === 0 ? 0 : rs.reduce((a, b) => a + b.fp_rate, 0) / rs.length;
  return {
    generated_at: new Date().toISOString(),
    history_rows: history.length,
    rules_simulated: rs.length,
    mean_fp_rate: round3(meanFp),
    rules: rs,
  };
}

function parseArgs(argv: string[]): { ruleId: string | null; writeReport: boolean } {
  let ruleId: string | null = null;
  let writeReport = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rule' && argv[i + 1]) {
      ruleId = argv[i + 1];
      i++;
    } else if (argv[i] === '--report') {
      writeReport = true;
    }
  }
  return { ruleId, writeReport };
}

function main(): void {
  const { ruleId, writeReport } = parseArgs(process.argv.slice(2));
  const history = loadHistory();
  const allRules = loadSeedRules();

  // Validate every rule before simulating — match service-layer behaviour.
  for (const r of allRules) {
    const v = validateRule(r);
    if (!v.ok) {
      // eslint-disable-next-line no-console
      console.error(`rule ${r.id} fails validation: ${v.errors.join('; ')}`);
      process.exitCode = 1;
      return;
    }
  }

  const target = ruleId ? allRules.filter((r) => r.id === ruleId) : allRules;
  if (target.length === 0) {
    // eslint-disable-next-line no-console
    console.error(`no rules to simulate (ruleId=${ruleId ?? 'all'})`);
    process.exitCode = 1;
    return;
  }
  const report = buildReport(target, history);
  if (writeReport || !ruleId) {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
  }
  // print compact summary
  const fmtRow = (r: RuleSimResult): string =>
    `${r.rule_id}  fp=${r.fp_rate.toFixed(3)}  fires=${String(r.total_firings).padStart(4)}  tp=${String(
      r.true_positives,
    ).padStart(3)}  customers=${String(r.customers_fired).padStart(3)}  lead=${
      r.median_lead_time_days === null ? '  -' : String(r.median_lead_time_days).padStart(3) + 'd'
    }`;
  // eslint-disable-next-line no-console
  console.log(`history_rows=${report.history_rows} rules=${report.rules_simulated} mean_fp=${report.mean_fp_rate.toFixed(3)}`);
  for (const r of report.rules) {
    // eslint-disable-next-line no-console
    console.log(fmtRow(r));
  }
}

if (require.main === module) {
  main();
}
