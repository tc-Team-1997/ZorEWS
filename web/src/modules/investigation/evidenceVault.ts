// Evidence Vault — pure resolver. Backs the Investigation Center evidence section.
//
// PURE module — no I/O, no React, no async, deterministic. Production swap will
// replace resolver bodies with HTTP/pg calls but the surface contract stays stable.
// Deterministic synthesis via FNV-1a + Mulberry32 keyed on (tenant, investigation, day).

import { listInvestigations } from './investigationEngine';

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

function toHex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, '0');
}

function pickFrom<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

function isoFromDay(asOf: Date, hourOffset: number, minuteOffset: number): string {
  const y = asOf.getUTCFullYear();
  const m = String(asOf.getUTCMonth() + 1).padStart(2, '0');
  const d = String(asOf.getUTCDate()).padStart(2, '0');
  const hh = String(((asOf.getUTCHours() + hourOffset) % 24 + 24) % 24).padStart(2, '0');
  const mm = String(((asOf.getUTCMinutes() + minuteOffset) % 60 + 60) % 60).padStart(2, '0');
  return `${y}-${m}-${d}T${hh}:${mm}:00Z`;
}

export const EVIDENCE_TYPES = ['document', 'pdf', 'image', 'screenshot', 'external_reference'] as const;
export type EvidenceType = typeof EVIDENCE_TYPES[number];

export const EVIDENCE_VERIFICATION_STATUSES = ['unverified', 'verified', 'failed'] as const;
export type EvidenceVerificationStatus = typeof EVIDENCE_VERIFICATION_STATUSES[number];

export type CustodyAction = 'uploaded' | 'viewed' | 'downloaded' | 'verified' | 'version_bumped';

export interface CustodyEntry {
  ts: string;
  actor: string;
  action: CustodyAction;
  notes: string | null;
}

export interface Evidence {
  evidence_id: string;
  investigation_id: string;
  tenant_id: string;
  evidence_type: EvidenceType;
  title: string;
  description: string;
  file_name: string;
  file_size_bytes: number;
  hash_sha256: string;
  version: number;
  uploaded_by: string;
  uploaded_at: string;
  verification_status: EvidenceVerificationStatus;
  verified_by: string | null;
  verified_at: string | null;
  chain_of_custody: CustodyEntry[];
}

export function computeEvidenceHash(evidence_id: string, title: string, uploaded_at: string): string {
  const chunks: string[] = [];
  chunks.push(toHex8(fnv1a(evidence_id)));
  chunks.push(toHex8(fnv1a(title)));
  chunks.push(toHex8(fnv1a(uploaded_at)));
  chunks.push(toHex8(fnv1a(evidence_id + title)));
  chunks.push(toHex8(fnv1a(title + uploaded_at)));
  chunks.push(toHex8(fnv1a(evidence_id + uploaded_at)));
  chunks.push(toHex8(fnv1a(evidence_id + title + uploaded_at)));
  chunks.push(toHex8(fnv1a(uploaded_at + evidence_id + title)));
  return chunks.join('');
}

const TITLES_BY_TYPE: Record<EvidenceType, readonly string[]> = {
  document: [
    'Customer KYC Profile',
    'Loan Application Form',
    'Income Verification Statement',
    'Bank Statement Analysis',
    'Credit Bureau Report',
  ],
  pdf: [
    'Forensic Audit Report',
    'Compliance Review PDF',
    'Risk Assessment Summary',
    'Investigation Findings Report',
    'Regulatory Filing Copy',
  ],
  image: [
    'Site Inspection Photo',
    'Collateral Asset Image',
    'Property Documentation',
    'Branch Visit Snapshot',
    'Field Verification Photo',
  ],
  screenshot: [
    'Transaction Log Screenshot',
    'System Alert Screenshot',
    'Dashboard Anomaly Capture',
    'Email Thread Screenshot',
    'CBS Record Screenshot',
  ],
  external_reference: [
    'Bureau API Reference',
    'Court Records Link',
    'AML Watchlist Match',
    'External Audit URL',
    'Regulator Notification Link',
  ],
};

const ACTOR_POOL = [
  'alice.admin',
  'bob.investigator',
  'carol.analyst',
  'dan.supervisor',
  'eve.auditor',
  'frank.collector',
  'grace.compliance',
  'henry.cro',
];

function pickEvidenceType(rng: () => number): EvidenceType {
  return pickFrom(EVIDENCE_TYPES, rng);
}

function pickVerificationStatus(rng: () => number): EvidenceVerificationStatus {
  const r = rng();
  if (r < 0.7) return 'verified';
  if (r < 0.9) return 'unverified';
  return 'failed';
}

function buildCustodyChain(
  rng: () => number,
  uploaded_at: string,
  uploaded_by: string,
  verification_status: EvidenceVerificationStatus,
  asOf: Date,
): CustodyEntry[] {
  const entries: CustodyEntry[] = [];

  entries.push({
    ts: uploaded_at,
    actor: uploaded_by,
    action: 'uploaded',
    notes: 'Initial upload',
  });

  const extraCount = 1 + Math.floor(rng() * 3); // 1..3 additional
  const extraActions: CustodyAction[] = ['viewed', 'downloaded'];

  for (let i = 0; i < extraCount; i++) {
    const action = pickFrom(extraActions, rng);
    const actor = pickFrom(ACTOR_POOL, rng);
    const hourOffset = 1 + Math.floor(rng() * 8);
    const minuteOffset = Math.floor(rng() * 60);
    entries.push({
      ts: isoFromDay(asOf, hourOffset + i, minuteOffset),
      actor,
      action,
      notes: action === 'viewed' ? 'Reviewed during investigation' : 'Downloaded for offline review',
    });
  }

  if (verification_status === 'verified') {
    const verifier = pickFrom(ACTOR_POOL, rng);
    entries.push({
      ts: isoFromDay(asOf, 6 + extraCount, Math.floor(rng() * 60)),
      actor: verifier,
      action: 'verified',
      notes: 'Hash verified — chain intact',
    });
  }

  return entries;
}

function fileSizeFor(evidence_type: EvidenceType, rng: () => number): number {
  if (evidence_type === 'external_reference') return 0;
  switch (evidence_type) {
    case 'document':
      return 50_000 + Math.floor(rng() * 450_000); // 50KB..500KB
    case 'pdf':
      return 200_000 + Math.floor(rng() * 1_800_000); // 200KB..2MB
    case 'image':
      return 500_000 + Math.floor(rng() * 4_500_000); // 500KB..5MB
    case 'screenshot':
      return 100_000 + Math.floor(rng() * 900_000); // 100KB..1MB
  }
}

function fileNameFor(evidence_type: EvidenceType, title: string, evidence_id: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  switch (evidence_type) {
    case 'document':
      return `${slug}_${evidence_id}.docx`;
    case 'pdf':
      return `${slug}_${evidence_id}.pdf`;
    case 'image':
      return `${slug}_${evidence_id}.jpg`;
    case 'screenshot':
      return `${slug}_${evidence_id}.png`;
    case 'external_reference':
      return `https://evidence.zorews.example/refs/${evidence_id}`;
  }
}

export function listEvidence(investigation_id: string, tenant_id: string, asOf?: Date): Evidence[] {
  const now = asOf ?? new Date();
  const day = dayIndex(now);
  const seed = fnv1a(`${tenant_id}|evidence|${investigation_id}|${day}`);
  const rng = mulberry32(seed);

  const count = 2 + Math.floor(rng() * 5); // 2..6
  const results: Evidence[] = [];

  for (let i = 0; i < count; i++) {
    const evidence_type = pickEvidenceType(rng);
    const titles = TITLES_BY_TYPE[evidence_type];
    const title = pickFrom(titles, rng);
    const evidence_id = `EV-${String(((seed + i * 7919) >>> 0) % 100000).padStart(5, '0')}`;
    const uploaded_by = pickFrom(ACTOR_POOL, rng);
    const uploaded_at = isoFromDay(now, Math.floor(rng() * 8), Math.floor(rng() * 60));
    const verification_status = pickVerificationStatus(rng);
    const version = 1 + Math.floor(rng() * 3); // 1..3
    const hash_sha256 = computeEvidenceHash(evidence_id, title, uploaded_at);
    const file_size_bytes = fileSizeFor(evidence_type, rng);
    const file_name = fileNameFor(evidence_type, title, evidence_id);

    const chain_of_custody = buildCustodyChain(rng, uploaded_at, uploaded_by, verification_status, now);
    const verified_entry = chain_of_custody.find((c) => c.action === 'verified');
    const verified_by = verified_entry ? verified_entry.actor : null;
    const verified_at = verified_entry ? verified_entry.ts : null;

    const description =
      evidence_type === 'external_reference'
        ? `External reference attached to investigation ${investigation_id}`
        : `${title} attached as evidence for investigation ${investigation_id}`;

    results.push({
      evidence_id,
      investigation_id,
      tenant_id,
      evidence_type,
      title,
      description,
      file_name,
      file_size_bytes,
      hash_sha256,
      version,
      uploaded_by,
      uploaded_at,
      verification_status,
      verified_by,
      verified_at,
      chain_of_custody,
    });
  }

  return results;
}

export function getEvidence(
  evidence_id: string,
  investigation_id: string,
  tenant_id: string,
  asOf?: Date,
): Evidence | null {
  const items = listEvidence(investigation_id, tenant_id, asOf);
  return items.find((e) => e.evidence_id === evidence_id) ?? null;
}

export interface EvidenceVerifyResult {
  ok: boolean;
  computed_hash: string;
  expected_hash: string;
}

export function verifyEvidence(evidence: Evidence): EvidenceVerifyResult {
  const computed_hash = computeEvidenceHash(evidence.evidence_id, evidence.title, evidence.uploaded_at);
  return {
    ok: computed_hash === evidence.hash_sha256,
    computed_hash,
    expected_hash: evidence.hash_sha256,
  };
}

export interface EvidenceVaultSummary {
  tenant_id: string;
  generated_at: string;
  total_items: number;
  by_type: Record<EvidenceType, number>;
  by_verification_status: Record<EvidenceVerificationStatus, number>;
  verification_rate: number;
}

export function evidenceVaultSummary(tenant_id: string, asOf?: Date): EvidenceVaultSummary {
  const now = asOf ?? new Date();
  const generated_at = isoFromDay(now, 0, 0);

  const by_type: Record<EvidenceType, number> = {
    document: 0,
    pdf: 0,
    image: 0,
    screenshot: 0,
    external_reference: 0,
  };
  const by_verification_status: Record<EvidenceVerificationStatus, number> = {
    unverified: 0,
    verified: 0,
    failed: 0,
  };

  const investigations = listInvestigations(tenant_id, now).slice(0, 32);
  let total_items = 0;
  let verified_count = 0;

  for (const inv of investigations) {
    const items = listEvidence(inv.investigation_id, tenant_id, now);
    for (const item of items) {
      total_items += 1;
      by_type[item.evidence_type] += 1;
      by_verification_status[item.verification_status] += 1;
      if (item.verification_status === 'verified') verified_count += 1;
    }
  }

  const verification_rate = total_items === 0 ? 0 : verified_count / total_items;

  return {
    tenant_id,
    generated_at,
    total_items,
    by_type,
    by_verification_status,
    verification_rate,
  };
}
