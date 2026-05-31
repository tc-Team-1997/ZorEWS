// Regulatory Compliance Center — pure resolver. 13th IA overlay (additive).

import {
  type ReportKind,
  type ReportFormat,
  type RegulatoryFramework,
  type RegulatoryDomain,
  type ReviewFrequency,
  REPORT_KINDS,
  BANKING_FRAMEWORKS,
  INSURANCE_FRAMEWORKS,
  REVIEW_FREQUENCIES,
} from './regulatoryFrameworkEngine';

function fnv1a(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dayIndex(asOf: Date): number {
  return Math.floor(asOf.getTime() / 86_400_000);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isoTimestamp(d: Date): string {
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}Z`
  );
}

function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

function dateOnlyUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function diffDays(target: Date, base: Date): number {
  const a = dateOnlyUTC(target).getTime();
  const b = dateOnlyUTC(base).getTime();
  return Math.round((a - b) / 86_400_000);
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

const BANKING_KINDS: ReadonlySet<ReportKind> = new Set<ReportKind>([
  'rbi',
  'basel',
  'aml',
  'kyc',
  'fraud',
  'executive_compliance',
]);

const INSURANCE_KINDS: ReadonlySet<ReportKind> = new Set<ReportKind>([
  'irdai',
  'solvency',
  'fraud',
  'executive_compliance',
]);

function domainForKind(kind: ReportKind, variantIdx: number): RegulatoryDomain {
  // fraud + executive_compliance can land in either domain; alternate by variant.
  if (kind === 'fraud' || kind === 'executive_compliance') {
    return variantIdx % 2 === 0 ? 'banking' : 'insurance';
  }
  if (INSURANCE_KINDS.has(kind) && !BANKING_KINDS.has(kind)) return 'insurance';
  return 'banking';
}

function frameworkForKind(
  kind: ReportKind,
  domain: RegulatoryDomain,
  rng: () => number,
): RegulatoryFramework {
  switch (kind) {
    case 'rbi':
      return 'rbi';
    case 'basel':
      return rng() < 0.5 ? 'basel_iii' : 'basel_iv';
    case 'aml':
      return 'aml';
    case 'kyc':
      return 'kyc';
    case 'irdai':
      return 'irdai';
    case 'solvency':
      return 'solvency';
    case 'fraud':
      return domain === 'insurance' ? 'fraud_compliance' : 'operational_risk';
    case 'executive_compliance':
      return domain === 'insurance'
        ? pick(rng, INSURANCE_FRAMEWORKS)
        : pick(rng, BANKING_FRAMEWORKS);
    default:
      return 'rbi';
  }
}

function regulatorFor(kind: ReportKind, domain: RegulatoryDomain): string {
  if (domain === 'insurance') {
    if (kind === 'irdai' || kind === 'solvency') return 'IRDAI';
    if (kind === 'fraud') return 'IRDAI';
    return 'IRDAI';
  }
  if (kind === 'rbi' || kind === 'basel' || kind === 'aml' || kind === 'kyc') return 'RBI';
  if (kind === 'fraud') return 'RBI';
  return 'RBI';
}

function labelFor(kind: ReportKind, variantIdx: number): string {
  const suffix = variantIdx % 2 === 0 ? 'Primary' : 'Supplementary';
  switch (kind) {
    case 'rbi':
      return `RBI Regulatory Return — ${suffix}`;
    case 'basel':
      return `Basel Capital Adequacy Report — ${suffix}`;
    case 'aml':
      return `AML Suspicious Activity Report — ${suffix}`;
    case 'kyc':
      return `KYC Compliance Attestation — ${suffix}`;
    case 'irdai':
      return `IRDAI Form-K Filing — ${suffix}`;
    case 'solvency':
      return `Solvency II Margin Report — ${suffix}`;
    case 'fraud':
      return `Fraud Risk Disclosure — ${suffix}`;
    case 'executive_compliance':
      return `Executive Compliance Pack — ${suffix}`;
    default:
      return `Regulatory Report — ${suffix}`;
  }
}

function descriptionFor(kind: ReportKind, framework: RegulatoryFramework, regulator: string): string {
  return `${kind.toUpperCase()} reporting bundle for ${regulator} under ${framework} framework — auto-generated submission pack with supporting evidence and attestations.`;
}

function formatsFor(kind: ReportKind, rng: () => number): {
  default_format: ReportFormat;
  supported_formats: ReportFormat[];
} {
  const variants: ReportFormat[][] = [
    ['pdf', 'excel', 'csv'],
    ['pdf', 'excel'],
    ['excel', 'csv'],
    ['pdf', 'csv'],
  ];
  const pickIdx = Math.floor(rng() * variants.length) % variants.length;
  const supported = variants[pickIdx];
  const def: ReportFormat =
    kind === 'executive_compliance' || kind === 'rbi' || kind === 'irdai'
      ? supported.includes('pdf')
        ? 'pdf'
        : supported[0]
      : kind === 'basel' || kind === 'solvency'
        ? supported.includes('excel')
          ? 'excel'
          : supported[0]
        : supported[0];
  return { default_format: def, supported_formats: supported };
}

function frequencyFor(kind: ReportKind, variantIdx: number): ReviewFrequency {
  const map: Record<ReportKind, ReviewFrequency[]> = {
    rbi: ['monthly', 'quarterly'],
    basel: ['quarterly', 'semi_annual'],
    aml: ['monthly', 'quarterly'],
    kyc: ['quarterly', 'semi_annual'],
    irdai: ['quarterly', 'annual'],
    solvency: ['quarterly', 'semi_annual'],
    fraud: ['monthly', 'quarterly'],
    executive_compliance: ['monthly', 'quarterly'],
  };
  const opts = map[kind] ?? REVIEW_FREQUENCIES.slice();
  return opts[variantIdx % opts.length];
}

function pageCountFor(kind: ReportKind, rng: () => number): number {
  const base: Record<ReportKind, number> = {
    rbi: 40,
    basel: 80,
    aml: 30,
    kyc: 25,
    irdai: 55,
    solvency: 70,
    fraud: 22,
    executive_compliance: 18,
  };
  const b = base[kind] ?? 30;
  return Math.max(4, b + Math.floor(rng() * 30) - 10);
}

function ownerFor(kind: ReportKind, domain: RegulatoryDomain, rng: () => number): string {
  const bankingOwners = [
    'compliance.lead',
    'aml.officer',
    'kyc.officer',
    'risk.cro',
    'finance.cfo',
    'audit.lead',
  ];
  const insuranceOwners = [
    'compliance.lead',
    'actuarial.lead',
    'claims.governance',
    'underwriting.head',
    'fraud.compliance.lead',
    'audit.lead',
  ];
  const pool = domain === 'insurance' ? insuranceOwners : bankingOwners;
  if (kind === 'executive_compliance') return 'cro.office';
  return pick(rng, pool);
}

function nextDueOffsetDays(kind: ReportKind, variantIdx: number, rng: () => number): number {
  // Spread next-due dates across [-10, +75] so calendar has overdue + due_today + due_soon + upcoming.
  const base = -10 + Math.floor(rng() * 86); // -10..75
  // Slight bias by kind so RBI/IRDAI cluster nearer term (regulator pressure).
  const bias: Record<ReportKind, number> = {
    rbi: -5,
    irdai: -5,
    basel: 5,
    solvency: 5,
    aml: 0,
    kyc: 10,
    fraud: 0,
    executive_compliance: 15,
  };
  const adjusted = base + (bias[kind] ?? 0) + variantIdx * 3;
  return Math.max(-15, Math.min(80, adjusted));
}

function lastGeneratedOffsetDays(rng: () => number): number | null {
  if (rng() < 0.15) return null; // 15% never generated
  return -(1 + Math.floor(rng() * 90)); // 1..90 days ago
}

function reportIdFor(tenant_id: string, kind: ReportKind, variantIdx: number): string {
  const kindCode = kind.toUpperCase().replace(/_/g, '');
  // Stable per (tenant, kind, variantIdx); short hash for tenant disambiguation.
  const tenantSeed = fnv1a(`${tenant_id}|RPT_ID`);
  const tenantSuffix = ((tenantSeed % 90) + 10).toString(); // 10..99
  const variantPad = pad2(variantIdx * 10 + Number(tenantSuffix.slice(-1)));
  return `RPT-${kindCode}-${variantPad}`;
}

export interface RegulatoryReportDef {
  report_id: string;
  tenant_id: string;
  kind: ReportKind;
  label: string;
  framework: RegulatoryFramework;
  domain: RegulatoryDomain;
  regulator: string;
  description: string;
  default_format: ReportFormat;
  supported_formats: ReportFormat[];
  frequency: ReviewFrequency;
  last_generated_at: string | null;
  next_due_at: string;
  owner: string;
  page_count: number;
}

function buildReportDef(
  tenant_id: string,
  kind: ReportKind,
  variantIdx: number,
  asOf: Date,
): RegulatoryReportDef {
  const day = dayIndex(asOf);
  const seed = fnv1a(`${tenant_id}|RPT|${kind}|${variantIdx}|${day}`);
  const rng = mulberry32(seed);

  const domain = domainForKind(kind, variantIdx);
  const framework = frameworkForKind(kind, domain, rng);
  const regulator = regulatorFor(kind, domain);
  const label = labelFor(kind, variantIdx);
  const description = descriptionFor(kind, framework, regulator);
  const { default_format, supported_formats } = formatsFor(kind, rng);
  const frequency = frequencyFor(kind, variantIdx);
  const page_count = pageCountFor(kind, rng);
  const owner = ownerFor(kind, domain, rng);

  const nextDueOffset = nextDueOffsetDays(kind, variantIdx, rng);
  const next_due_at = isoDate(addDays(dateOnlyUTC(asOf), nextDueOffset));

  const lastGenOffset = lastGeneratedOffsetDays(rng);
  const last_generated_at =
    lastGenOffset === null
      ? null
      : isoTimestamp(addDays(dateOnlyUTC(asOf), lastGenOffset));

  return {
    report_id: reportIdFor(tenant_id, kind, variantIdx),
    tenant_id,
    kind,
    label,
    framework,
    domain,
    regulator,
    description,
    default_format,
    supported_formats,
    frequency,
    last_generated_at,
    next_due_at,
    owner,
    page_count,
  };
}

export function listRegulatoryReports(
  tenant_id: string,
  asOf?: Date,
  filters?: { kind?: ReportKind; domain?: RegulatoryDomain; format?: ReportFormat },
): RegulatoryReportDef[] {
  const at = asOf ?? new Date();
  const defs: RegulatoryReportDef[] = [];
  for (const kind of REPORT_KINDS) {
    for (let variantIdx = 0; variantIdx < 2; variantIdx++) {
      defs.push(buildReportDef(tenant_id, kind, variantIdx, at));
    }
  }
  let filtered = defs;
  if (filters?.kind) {
    filtered = filtered.filter((d) => d.kind === filters.kind);
  }
  if (filters?.domain) {
    filtered = filtered.filter((d) => d.domain === filters.domain);
  }
  if (filters?.format) {
    filtered = filtered.filter((d) => d.supported_formats.includes(filters.format as ReportFormat));
  }
  filtered.sort((a, b) => {
    if (a.next_due_at < b.next_due_at) return -1;
    if (a.next_due_at > b.next_due_at) return 1;
    if (a.report_id < b.report_id) return -1;
    if (a.report_id > b.report_id) return 1;
    return 0;
  });
  return filtered;
}

export function getRegulatoryReport(
  report_id: string,
  tenant_id: string,
  asOf?: Date,
): RegulatoryReportDef | null {
  const all = listRegulatoryReports(tenant_id, asOf);
  for (const def of all) {
    if (def.report_id === report_id) return def;
  }
  return null;
}

export type CalendarEntryKind =
  | 'filing_deadline'
  | 'review_cycle'
  | 'audit_cycle'
  | 'regulatory_submission'
  | 'board_review';

export type CalendarUrgency = 'upcoming' | 'due_soon' | 'due_today' | 'overdue';

export interface RegulatoryCalendarEntry {
  calendar_entry_id: string;
  tenant_id: string;
  title: string;
  entry_kind: CalendarEntryKind;
  framework: RegulatoryFramework | null;
  domain: RegulatoryDomain | null;
  due_date: string;
  days_until_due: number;
  urgency: CalendarUrgency;
  owner: string;
  linked_report_id: string | null;
  notes: string;
}

const CALENDAR_KINDS: readonly CalendarEntryKind[] = [
  'filing_deadline',
  'review_cycle',
  'audit_cycle',
  'regulatory_submission',
  'board_review',
];

function urgencyFor(days: number): CalendarUrgency {
  if (days < 0) return 'overdue';
  if (days === 0) return 'due_today';
  if (days <= 7) return 'due_soon';
  return 'upcoming';
}

function titleForCalendar(
  entry_kind: CalendarEntryKind,
  framework: RegulatoryFramework | null,
  domain: RegulatoryDomain | null,
): string {
  const fw = framework ? framework.toUpperCase().replace(/_/g, ' ') : 'Cross-framework';
  switch (entry_kind) {
    case 'filing_deadline':
      return `${fw} filing deadline`;
    case 'review_cycle':
      return `${fw} review cycle`;
    case 'audit_cycle':
      return `${fw} audit cycle`;
    case 'regulatory_submission':
      return `${fw} regulatory submission`;
    case 'board_review':
      return `${domain === 'insurance' ? 'Insurance' : 'Banking'} board review — ${fw}`;
    default:
      return `${fw} milestone`;
  }
}

function notesForCalendar(entry_kind: CalendarEntryKind, urgency: CalendarUrgency): string {
  const prefix =
    urgency === 'overdue'
      ? 'OVERDUE — escalate to owner.'
      : urgency === 'due_today'
        ? 'Due today — final review required.'
        : urgency === 'due_soon'
          ? 'Due within 7 days — confirm progress.'
          : 'Upcoming — track in calendar.';
  const detail: Record<CalendarEntryKind, string> = {
    filing_deadline: 'Submission package must be approved + signed off prior to deadline.',
    review_cycle: 'Standing periodic review — collect attestations from owners.',
    audit_cycle: 'Audit window open — coordinate evidence gathering with audit team.',
    regulatory_submission: 'Regulator submission portal open — verify attachments + signatures.',
    board_review: 'Board-level review — agenda + read-ahead pack required 72h ahead.',
  };
  return `${prefix} ${detail[entry_kind]}`;
}

function buildCalendarEntry(
  tenant_id: string,
  slot: number,
  asOf: Date,
  daysHorizon: number,
): RegulatoryCalendarEntry {
  const day = dayIndex(asOf);
  const seed = fnv1a(`${tenant_id}|CAL|${slot}|${day}`);
  const rng = mulberry32(seed);

  const entry_kind = pick(rng, CALENDAR_KINDS);
  // Domain choice: some entries cross-framework (null).
  const domainRoll = rng();
  const domain: RegulatoryDomain | null =
    domainRoll < 0.45 ? 'banking' : domainRoll < 0.9 ? 'insurance' : null;
  const framework: RegulatoryFramework | null =
    domain === null
      ? null
      : domain === 'banking'
        ? pick(rng, BANKING_FRAMEWORKS)
        : pick(rng, INSURANCE_FRAMEWORKS);

  // Distribute due dates across [-10 .. daysHorizon] so we get overdue + soon + upcoming.
  const span = daysHorizon + 10; // -10 .. daysHorizon
  const offset = -10 + Math.floor(rng() * span);
  const dueDate = addDays(dateOnlyUTC(asOf), offset);
  const days_until_due = diffDays(dueDate, asOf);
  const urgency = urgencyFor(days_until_due);

  const ownerPool = [
    'compliance.lead',
    'aml.officer',
    'kyc.officer',
    'risk.cro',
    'audit.lead',
    'actuarial.lead',
    'claims.governance',
    'fraud.compliance.lead',
    'cro.office',
    'board.secretary',
  ];
  const owner = pick(rng, ownerPool);

  // Optionally link to a report (~55% chance) — pick a stable one.
  let linked_report_id: string | null = null;
  if (rng() < 0.55) {
    const kindsForDomain =
      domain === 'insurance'
        ? (REPORT_KINDS.filter((k) => INSURANCE_KINDS.has(k)) as ReportKind[])
        : domain === 'banking'
          ? (REPORT_KINDS.filter((k) => BANKING_KINDS.has(k)) as ReportKind[])
          : (REPORT_KINDS as readonly ReportKind[]).slice();
    if (kindsForDomain.length > 0) {
      const linkedKind = kindsForDomain[Math.floor(rng() * kindsForDomain.length) % kindsForDomain.length];
      const variantIdx = Math.floor(rng() * 2);
      linked_report_id = reportIdFor(tenant_id, linkedKind, variantIdx);
    }
  }

  const title = titleForCalendar(entry_kind, framework, domain);
  const notes = notesForCalendar(entry_kind, urgency);

  return {
    calendar_entry_id: `CAL-${tenant_id}-${pad2(slot)}-${day}`,
    tenant_id,
    title,
    entry_kind,
    framework,
    domain,
    due_date: isoDate(dueDate),
    days_until_due,
    urgency,
    owner,
    linked_report_id,
    notes,
  };
}

export function listRegulatoryCalendar(
  tenant_id: string,
  asOf?: Date,
  daysHorizon?: number,
): RegulatoryCalendarEntry[] {
  const at = asOf ?? new Date();
  const horizon = typeof daysHorizon === 'number' && daysHorizon > 0 ? Math.floor(daysHorizon) : 60;
  const entries: RegulatoryCalendarEntry[] = [];
  for (let slot = 0; slot < 24; slot++) {
    entries.push(buildCalendarEntry(tenant_id, slot, at, horizon));
  }
  entries.sort((a, b) => {
    if (a.due_date < b.due_date) return -1;
    if (a.due_date > b.due_date) return 1;
    if (a.calendar_entry_id < b.calendar_entry_id) return -1;
    if (a.calendar_entry_id > b.calendar_entry_id) return 1;
    return 0;
  });
  return entries;
}

export interface ReportingHubSummary {
  tenant_id: string;
  generated_at: string;
  total_reports: number;
  reports_due_30d: number;
  reports_overdue: number;
  by_kind: Record<ReportKind, number>;
  by_format: Record<ReportFormat, number>;
  most_recent_export: string | null;
  upcoming_calendar: RegulatoryCalendarEntry[];
}

export function buildReportingHubSummary(tenant_id: string, asOf?: Date): ReportingHubSummary {
  const at = asOf ?? new Date();
  const reports = listRegulatoryReports(tenant_id, at);
  const today = dateOnlyUTC(at);

  const by_kind: Record<ReportKind, number> = {
    rbi: 0,
    basel: 0,
    aml: 0,
    kyc: 0,
    irdai: 0,
    solvency: 0,
    fraud: 0,
    executive_compliance: 0,
  };
  const by_format: Record<ReportFormat, number> = {
    pdf: 0,
    excel: 0,
    csv: 0,
  };

  let reports_due_30d = 0;
  let reports_overdue = 0;
  let most_recent_export: string | null = null;

  for (const def of reports) {
    by_kind[def.kind] = (by_kind[def.kind] ?? 0) + 1;
    by_format[def.default_format] = (by_format[def.default_format] ?? 0) + 1;
    const due = new Date(`${def.next_due_at}T00:00:00Z`);
    const days = diffDays(due, today);
    if (days < 0) reports_overdue += 1;
    if (days >= 0 && days <= 30) reports_due_30d += 1;
    if (def.last_generated_at !== null) {
      if (most_recent_export === null || def.last_generated_at > most_recent_export) {
        most_recent_export = def.last_generated_at;
      }
    }
  }

  const calendar = listRegulatoryCalendar(tenant_id, at);
  const upcoming_calendar = calendar.slice(0, 5);

  return {
    tenant_id,
    generated_at: isoTimestamp(at),
    total_reports: reports.length,
    reports_due_30d,
    reports_overdue,
    by_kind,
    by_format,
    most_recent_export,
    upcoming_calendar,
  };
}

export interface ReportExportRequest {
  tenant_id: string;
  report_id: string;
  format: ReportFormat;
  requested_by: string;
  request_id?: string;
}

export interface ReportExportReceipt {
  request_id: string;
  report_id: string;
  format: ReportFormat;
  queued_at: string;
  estimated_ready_at: string;
  size_bytes_estimate: number;
  status: 'queued' | 'ready' | 'failed';
}

function deterministicRequestId(req: ReportExportRequest, day: number): string {
  const seed = fnv1a(
    `${req.tenant_id}|EXP|${req.report_id}|${req.format}|${day}|${req.requested_by}`,
  );
  const hex = seed.toString(16).padStart(8, '0');
  return `EXP-${req.report_id}-${hex.slice(0, 8)}`;
}

export function requestReportExport(
  req: ReportExportRequest,
  asOf?: Date,
): ReportExportReceipt {
  const at = asOf ?? new Date();
  const day = dayIndex(at);
  const request_id = req.request_id ?? deterministicRequestId(req, day);
  const queued_at = isoTimestamp(at);

  const def = getRegulatoryReport(req.report_id, req.tenant_id, at);
  if (def === null) {
    return {
      request_id,
      report_id: req.report_id,
      format: req.format,
      queued_at,
      estimated_ready_at: queued_at,
      size_bytes_estimate: 0,
      status: 'failed',
    };
  }

  const renderMs = def.page_count * 200;
  const minReadyMs = 5000;
  const readyMs = renderMs >= minReadyMs ? renderMs : minReadyMs;
  const estimated_ready = new Date(at.getTime() + readyMs);

  const perPage = req.format === 'pdf' ? 50_000 : 20_000;
  const size_bytes_estimate = def.page_count * perPage;

  return {
    request_id,
    report_id: req.report_id,
    format: req.format,
    queued_at,
    estimated_ready_at: isoTimestamp(estimated_ready),
    size_bytes_estimate,
    status: 'queued',
  };
}
