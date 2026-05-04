// services/bff/src/integrations/dms.ts
//
// T6 M14.4 — DMS (Document Management System) adapter (4th adapter
// in Module 14).
//
// DMS is the BIL upstream that holds the document layer: claim forms,
// medical records, KYC proofs, identity/address proofs, policy
// docs, photos, invoices. It's a critical pivot point — the case
// investigation workflow (M9.1) walks through evidence; AML hits
// (M14.3) cite supporting docs; the indicator engine flags missing
// docs.
//
// This adapter surfaces document metadata only — actual file content
// is out of scope for the prototype (production = signed S3 / DMS
// vendor URLs through `download_url`). The stub generates 0-12
// deterministic documents per customer with realistic type mix.

import { randomUUID } from 'node:crypto';

// ─── Public types ──────────────────────────────────────────────────────

export type DocumentType =
  | 'claim_form'
  | 'medical_record'
  | 'kyc_proof'
  | 'identity_proof'
  | 'address_proof'
  | 'policy_doc'
  | 'photo'
  | 'invoice'
  | 'misc';

export type DocumentStatus =
  | 'pending_review'
  | 'verified'
  | 'rejected'
  | 'expired';

export interface DmsDocument {
  document_id: string;
  customer_id: string;
  /** Optional pivot to a case (set when the doc was uploaded as
   *  evidence for a case rather than at customer onboarding). */
  case_id: string | null;
  /** Optional pivot to a policy or claim. */
  policy_id: string | null;
  claim_id: string | null;
  type: DocumentType;
  /** Operator-readable filename hint. */
  filename: string;
  /** Bytes — metadata only; content lives in DMS. */
  size_bytes: number;
  /** MIME type. */
  mime_type: string;
  status: DocumentStatus;
  uploaded_at: string;
  uploaded_by: string;
  /** ISO timestamp of the most-recent status change; null when status='pending_review'. */
  status_changed_at: string | null;
  status_changed_by: string | null;
  /** Optional expiry date (KYC/identity proofs). null otherwise. */
  expires_at: string | null;
  /** Signed download URL (synthesised — production = DMS vendor URL). */
  download_url: string;
}

export interface DmsAdapter {
  /** Documents attached to a customer (across all cases/policies). */
  listByCustomer(tenant_id: string, customer_id: string, asOf: Date): Promise<DmsDocument[]>;
  /** Documents attached to a specific case. */
  listByCase(tenant_id: string, case_id: string): Promise<DmsDocument[]>;
  /** Single document. Tenant-scoped — null on cross-tenant lookup. */
  get(tenant_id: string, document_id: string): Promise<DmsDocument | null>;
  /** Update a document's status with audit trail. */
  updateStatus(
    tenant_id: string,
    document_id: string,
    status: DocumentStatus,
    changed_by: string,
    now: Date,
  ): Promise<DmsDocument>;
}

export class DmsError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'DmsError';
  }
}

const VALID_STATUSES: DocumentStatus[] = ['pending_review', 'verified', 'rejected', 'expired'];
const VALID_TYPES: DocumentType[] = [
  'claim_form',
  'medical_record',
  'kyc_proof',
  'identity_proof',
  'address_proof',
  'policy_doc',
  'photo',
  'invoice',
  'misc',
];

export function isDocumentStatus(s: unknown): s is DocumentStatus {
  return typeof s === 'string' && VALID_STATUSES.includes(s as DocumentStatus);
}
export function isDocumentType(s: unknown): s is DocumentType {
  return typeof s === 'string' && VALID_TYPES.includes(s as DocumentType);
}

export function listDocumentTypes(): DocumentType[] {
  return [...VALID_TYPES];
}

// ─── Deterministic PRNG ────────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick<T>(r: () => number, arr: readonly T[]): T {
  return arr[Math.floor(r() * arr.length)]!;
}
function daysBefore(d: Date, n: number): string {
  return new Date(d.getTime() - n * 86_400_000).toISOString();
}

// ─── Stub data ─────────────────────────────────────────────────────────

const MIME_BY_TYPE: Record<DocumentType, string[]> = {
  claim_form: ['application/pdf'],
  medical_record: ['application/pdf', 'image/jpeg'],
  kyc_proof: ['application/pdf', 'image/jpeg'],
  identity_proof: ['image/jpeg', 'image/png'],
  address_proof: ['application/pdf', 'image/jpeg'],
  policy_doc: ['application/pdf'],
  photo: ['image/jpeg', 'image/png'],
  invoice: ['application/pdf'],
  misc: ['application/pdf', 'image/jpeg', 'application/octet-stream'],
};

const FILENAME_BY_TYPE: Record<DocumentType, string> = {
  claim_form: 'claim_form',
  medical_record: 'medical_record',
  kyc_proof: 'kyc_proof',
  identity_proof: 'id_proof',
  address_proof: 'address_proof',
  policy_doc: 'policy_doc',
  photo: 'photo',
  invoice: 'invoice',
  misc: 'misc',
};

/** How many docs a customer has, deterministically. ~10% none, ~50% 1-3,
 *  ~30% 4-7, ~10% 8-12. */
function docCountFor(seed: number): number {
  const r = rng(seed)();
  if (r < 0.1) return 0;
  if (r < 0.6) return 1 + Math.floor(rng(seed * 13)() * 3);
  if (r < 0.9) return 4 + Math.floor(rng(seed * 17)() * 4);
  return 8 + Math.floor(rng(seed * 19)() * 5);
}

function statusForType(type: DocumentType, r: () => number, asOf: Date): {
  status: DocumentStatus;
  status_changed_at: string | null;
  expires_at: string | null;
} {
  // KYC + identity + address proofs: ~85% verified, ~10% pending, 3% rejected, 2% expired
  // Other docs: ~70% verified, ~25% pending, 4% rejected, 1% expired
  const isProof = type === 'kyc_proof' || type === 'identity_proof' || type === 'address_proof';
  const roll = r();
  let status: DocumentStatus;
  if (isProof) {
    if (roll < 0.85) status = 'verified';
    else if (roll < 0.95) status = 'pending_review';
    else if (roll < 0.98) status = 'rejected';
    else status = 'expired';
  } else {
    if (roll < 0.7) status = 'verified';
    else if (roll < 0.95) status = 'pending_review';
    else if (roll < 0.99) status = 'rejected';
    else status = 'expired';
  }
  const status_changed_at =
    status === 'pending_review' ? null : daysBefore(asOf, Math.floor(r() * 60));

  // KYC/identity/address proofs may carry expiry; others null. ~6 months
  // to 5 years from upload.
  let expires_at: string | null = null;
  if (isProof) {
    const days = 180 + Math.floor(r() * (365 * 5 - 180));
    expires_at = daysBefore(asOf, -days);
    if (status === 'expired') {
      // Force expiry in the past
      expires_at = daysBefore(asOf, 30 + Math.floor(r() * 365));
    }
  }
  return { status, status_changed_at, expires_at };
}

function buildDocument(
  tenant_id: string,
  customer_id: string,
  index: number,
  asOf: Date,
): DmsDocument {
  const seed = fnv1a(`dms|${tenant_id}|${customer_id}|${index}`);
  const r = rng(seed);
  const type = pick(r, VALID_TYPES);
  const mimePool = MIME_BY_TYPE[type];
  const mime_type = pick(r, mimePool);
  const ext = mime_type.split('/')[1]!.split('+')[0]!;
  const document_id = `dms-${tenant_id.slice(0, 3).toLowerCase()}-${(seed % 10_000_000).toString().padStart(7, '0')}`;
  const filename = `${FILENAME_BY_TYPE[type]}_${(seed % 1_000_000).toString().padStart(6, '0')}.${ext === 'jpeg' ? 'jpg' : ext}`;
  const size_bytes = 50_000 + Math.floor(r() * 4_950_000); // 50KB - 5MB

  // ~30% of docs link to a case, ~25% to a policy, ~10% to a claim
  const linkRoll = r();
  const case_id = linkRoll < 0.3 ? `CASE-${(seed % 10_000).toString().padStart(5, '0')}` : null;
  const policy_id = linkRoll >= 0.3 && linkRoll < 0.55
    ? `POL-${tenant_id.slice(0, 3).toUpperCase()}-${(seed % 1_000_000).toString().padStart(6, '0')}`
    : null;
  const claim_id = linkRoll >= 0.55 && linkRoll < 0.65
    ? `CLM-${tenant_id.slice(0, 3).toUpperCase()}-${(seed % 1_000_000).toString().padStart(6, '0')}`
    : null;

  const uploadedDaysAgo = Math.floor(r() * 365);
  const uploaded_at = daysBefore(asOf, uploadedDaysAgo);
  const uploaded_by = `agent-${(seed % 200).toString().padStart(3, '0')}`;

  const { status, status_changed_at, expires_at } = statusForType(type, r, asOf);
  const status_changed_by = status_changed_at === null ? null : `reviewer-${(seed % 50).toString().padStart(2, '0')}`;

  return {
    document_id,
    customer_id,
    case_id,
    policy_id,
    claim_id,
    type,
    filename,
    size_bytes,
    mime_type,
    status,
    uploaded_at,
    uploaded_by,
    status_changed_at,
    status_changed_by,
    expires_at,
    download_url: `/v1/integrations/dms/documents/${document_id}/download`,
  };
}

// ─── Stub adapter ──────────────────────────────────────────────────────

export class StubDmsAdapter implements DmsAdapter {
  /** tenant_id → customer_id → document_id → DmsDocument. */
  private readonly byCustomer = new Map<string, Map<string, Map<string, DmsDocument>>>();
  /** tenant_id → document_id → DmsDocument (reverse index for O(1) get/update). */
  private readonly byId = new Map<string, Map<string, DmsDocument>>();

  async listByCustomer(
    tenant_id: string,
    customer_id: string,
    asOf: Date,
  ): Promise<DmsDocument[]> {
    if (!tenant_id || !customer_id) return [];
    let custMap = this.byCustomer.get(tenant_id)?.get(customer_id);
    if (!custMap) {
      const seed = fnv1a(`count|${tenant_id}|${customer_id}`);
      const n = docCountFor(seed);
      custMap = new Map();
      const built: DmsDocument[] = [];
      for (let i = 0; i < n; i++) {
        const d = buildDocument(tenant_id, customer_id, i, asOf);
        custMap.set(d.document_id, d);
        built.push(d);
      }
      let tMap = this.byCustomer.get(tenant_id);
      if (!tMap) {
        tMap = new Map();
        this.byCustomer.set(tenant_id, tMap);
      }
      tMap.set(customer_id, custMap);
      let idMap = this.byId.get(tenant_id);
      if (!idMap) {
        idMap = new Map();
        this.byId.set(tenant_id, idMap);
      }
      for (const d of built) idMap.set(d.document_id, d);
    }
    return [...custMap.values()].sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
  }

  async listByCase(tenant_id: string, case_id: string): Promise<DmsDocument[]> {
    if (!tenant_id || !case_id) return [];
    const tIdMap = this.byId.get(tenant_id);
    if (!tIdMap) return [];
    return [...tIdMap.values()]
      .filter((d) => d.case_id === case_id)
      .sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
  }

  async get(tenant_id: string, document_id: string): Promise<DmsDocument | null> {
    return this.byId.get(tenant_id)?.get(document_id) ?? null;
  }

  async updateStatus(
    tenant_id: string,
    document_id: string,
    status: DocumentStatus,
    changed_by: string,
    now: Date,
  ): Promise<DmsDocument> {
    if (!isDocumentStatus(status)) {
      throw new DmsError('invalid_status', `status must be one of ${VALID_STATUSES.join(',')}`);
    }
    const idMap = this.byId.get(tenant_id);
    const existing = idMap?.get(document_id);
    if (!existing) {
      throw new DmsError('unknown_document', `unknown document_id: ${document_id}`);
    }
    const updated: DmsDocument = {
      ...existing,
      status,
      status_changed_at: now.toISOString(),
      status_changed_by: changed_by,
    };
    idMap!.set(document_id, updated);
    const custMap = this.byCustomer.get(tenant_id)?.get(existing.customer_id);
    custMap?.set(document_id, updated);
    return updated;
  }

  /** Test helper. */
  reset(): void {
    this.byCustomer.clear();
    this.byId.clear();
  }
}

/** Module-level singleton used by routes when no override is supplied. */
export const defaultDmsAdapter: DmsAdapter = new StubDmsAdapter();
