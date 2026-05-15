// services/bff/src/adapter_id_catalog.ts
//
// T6 M14.25 — Adapter entity ID format catalog.
//
// Hand-curated metadata: for every M14 adapter, the entity types
// it produces IDs for + the canonical ID pattern (regex) + a
// rendered example. Drives the SPA "paste an ID and route to the
// right adapter" feature + client-side ID-shape validation
// before hitting the adapter route.
//
// Companion to:
//   - M14.9  /v1/integrations/adapters/health
//   - M14.23 /v1/integrations/adapters/sla-catalog
//   - M14.24 /v1/integrations/adapters/operations
//   - M14.25 /v1/integrations/adapters/id-catalog  — THIS
//
// Pure — platform-static. Same response across every tenant.

import type { AdapterId } from './adapter_health';

// ─── Public types ─────────────────────────────────────────────────────

export interface AdapterEntityIdSpec {
  /** Entity name (policy / claim / match / report / etc). */
  entity: string;
  /** Field name as it appears in adapter response payloads. */
  id_field: string;
  /** Anchored regex string describing the canonical ID format.
   *  Tenant slug placeholder uses `<TEN>` for documentation;
   *  `pattern_runtime` is the resolved tenant-anchored regex. */
  pattern_template: string;
  /** Worked example rendered for the BIL tenant. */
  example: string;
  /** Brief operator-facing notes. */
  description: string;
}

export interface AdapterIdGroup {
  adapter_id: AdapterId;
  label: string;
  base_path: string;
  entities: AdapterEntityIdSpec[];
}

export interface AdapterIdCatalog {
  total_adapters: number;
  total_entities: number;
  /** Per-adapter grouped entity ID specs. Sorted by adapter_id asc. */
  adapters: AdapterIdGroup[];
  /** Flat union of every (adapter_id, entity) pair sorted by adapter_id
   *  then entity asc. Useful for the SPA's "all known ID formats"
   *  picker. */
  all_entities: Array<{ adapter_id: AdapterId; entity: string; pattern_template: string; example: string }>;
}

// ─── Hand-curated catalog ─────────────────────────────────────────────

const TEN = 'BIL'; // canonical 3-char example slug used in the rendered examples

const ADAPTERS: readonly AdapterIdGroup[] = [
  {
    adapter_id: 'agent',
    label: 'Agent Productivity',
    base_path: '/v1/integrations/agent',
    entities: [
      {
        entity: 'agent',
        id_field: 'agent_id',
        pattern_template: '^AGT-<TEN>-\\d{4}$',
        example: 'AGT-BIL-0042',
        description: 'BIL agent identifier — 4-digit zero-padded index per tenant.',
      },
    ],
  },
  {
    adapter_id: 'aml',
    label: 'AML Watchlist',
    base_path: '/v1/integrations/aml',
    entities: [
      {
        entity: 'match',
        id_field: 'match_id',
        pattern_template: '^aml-<TEN>-\\d{7}$',
        example: 'aml-bil-0123456',
        description: 'Persistent AML match record. Tenant slug is lower-case.',
      },
    ],
  },
  {
    adapter_id: 'bureau',
    label: 'Credit Bureau',
    base_path: '/v1/integrations/bureau',
    entities: [
      {
        entity: 'report',
        id_field: 'report_id',
        pattern_template: '^bur-<TEN>-\\d{7}$',
        example: 'bur-bil-0123456',
        description: 'Bureau pull receipt. Tenant slug is lower-case.',
      },
    ],
  },
  {
    adapter_id: 'dms',
    label: 'Document Management',
    base_path: '/v1/integrations/dms',
    entities: [
      {
        entity: 'document',
        id_field: 'document_id',
        pattern_template: '^dms-<TEN>-\\d{7}$',
        example: 'dms-bil-0123456',
        description: 'DMS document record. Tenant slug is lower-case.',
      },
    ],
  },
  {
    adapter_id: 'finance',
    label: 'Finance / Treasury',
    base_path: '/v1/integrations/finance',
    entities: [
      {
        entity: 'account',
        id_field: 'account_id',
        pattern_template: '^ACC-<TEN>-\\d{7}$',
        example: 'ACC-BIL-1234567',
        description: '7-digit zero-padded synthetic account number per tenant.',
      },
      {
        entity: 'ledger_entry',
        id_field: 'entry_id',
        pattern_template: '^LE-<TEN>-\\d{8}$',
        example: 'LE-BIL-12345678',
        description: 'Ledger entry — 8-digit padded suffix.',
      },
    ],
  },
  {
    adapter_id: 'hr',
    label: 'HR',
    base_path: '/v1/integrations/hr',
    entities: [
      {
        entity: 'employee',
        id_field: 'employee_id',
        pattern_template: '^EMP-<TEN>-\\d{4}$',
        example: 'EMP-BIL-0042',
        description: '4-digit padded employee index per tenant.',
      },
    ],
  },
  {
    adapter_id: 'ifrs9',
    label: 'IFRS9 Stages',
    base_path: '/v1/integrations/ifrs9',
    entities: [
      {
        entity: 'customer',
        id_field: 'customer_id',
        pattern_template: '^[A-Z0-9_-]{1,64}$',
        example: 'CUST-100001',
        description: 'IFRS9 keys off the customer_id directly — no separate stage ID.',
      },
    ],
  },
  {
    adapter_id: 'insurance',
    label: 'Core Insurance',
    base_path: '/v1/integrations/insurance',
    entities: [
      {
        entity: 'policy',
        id_field: 'policy_id',
        pattern_template: '^POL-<TEN>-\\d{6}$',
        example: 'POL-BIL-123456',
        description: 'Policy Master identifier — 6-digit padded suffix per tenant.',
      },
      {
        entity: 'claim',
        id_field: 'claim_id',
        pattern_template: '^CLM-<TEN>-\\d{6}$',
        example: 'CLM-BIL-123456',
        description: 'Claim identifier sharing the policy 6-digit suffix.',
      },
    ],
  },
];

// ─── Pure resolver ────────────────────────────────────────────────────

function renderForTenant(pattern: string, tenant_id: string, lower = false): string {
  const slug = tenant_id.slice(0, 3);
  const ten = lower ? slug.toLowerCase() : slug.toUpperCase();
  return pattern.replace('<TEN>', ten);
}

export function listAdapterIdCatalog(): AdapterIdCatalog {
  // Defensive deep-copy so caller mutations don't pollute the singleton.
  const adapters: AdapterIdGroup[] = ADAPTERS.map((g) => ({
    adapter_id: g.adapter_id,
    label: g.label,
    base_path: g.base_path,
    entities: g.entities.map((e) => ({ ...e })),
  }));
  adapters.sort((a, b) => a.adapter_id.localeCompare(b.adapter_id));

  const all_entities: AdapterIdCatalog['all_entities'] = [];
  for (const g of adapters) {
    for (const e of g.entities) {
      all_entities.push({
        adapter_id: g.adapter_id,
        entity: e.entity,
        pattern_template: e.pattern_template,
        example: e.example,
      });
    }
  }
  all_entities.sort((a, b) => {
    if (a.adapter_id !== b.adapter_id) return a.adapter_id.localeCompare(b.adapter_id);
    return a.entity.localeCompare(b.entity);
  });

  return {
    total_adapters: adapters.length,
    total_entities: all_entities.length,
    adapters,
    all_entities,
  };
}

/** Resolve a tenant-anchored RegExp from the pattern_template. Pattern
 *  is case-aware via the `lower_case_slug` heuristic — adapters using
 *  lowercase tenant slugs (aml/bureau/dms) get a lower-cased anchor. */
export function buildPatternForTenant(
  pattern_template: string,
  tenant_id: string,
): RegExp {
  // Heuristic: pattern_template casing indicates expected slug casing
  // because the literal prefixes (POL/CLM/AGT/EMP/ACC/LE = upper;
  // aml/bur/dms = lower) co-vary with the slug case in the live id
  // generators. We use the FIRST alpha character as the indicator.
  const firstAlpha = pattern_template.match(/[A-Za-z]/);
  const lower = firstAlpha ? firstAlpha[0] === firstAlpha[0].toLowerCase() : false;
  const resolved = renderForTenant(pattern_template, tenant_id, lower);
  return new RegExp(resolved);
}
