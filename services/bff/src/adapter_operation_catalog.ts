// services/bff/src/adapter_operation_catalog.ts
//
// T6 M14.24 — Adapter operation catalog.
//
// Hand-curated metadata catalog of every operation each M14 adapter
// exposes — operation_id, HTTP method, path pattern, description,
// and parameter contracts. Drives the SPA "API explorer" panel so
// admins can see which queries are available without browsing the
// TypeScript interface files.
//
// Companion to:
//   - M14.9   /v1/integrations/adapters[/health]  — fleet probe
//   - M14.23  /v1/integrations/adapters/sla-catalog — SLA targets
//   - M14.24  /v1/integrations/adapters/operations  — THIS shape:
//             what operations + parameters each adapter exposes
//
// Pure — platform-static. Same response across every tenant.

import type { AdapterId } from './adapter_health';

// ─── Public types ─────────────────────────────────────────────────────

export type ParameterLocation = 'query' | 'path' | 'body';
export type ParameterType = 'string' | 'integer' | 'datetime' | 'enum';

export interface OperationParameter {
  name: string;
  in: ParameterLocation;
  type: ParameterType;
  required: boolean;
  description: string;
  /** Allowed values when type === 'enum'. */
  enum_values?: readonly string[];
}

export interface AdapterOperation {
  operation_id: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  description: string;
  parameters: OperationParameter[];
}

export interface AdapterOperationGroup {
  adapter_id: AdapterId;
  label: string;
  base_path: string;
  operation_count: number;
  operations: AdapterOperation[];
}

export interface AdapterOperationCatalog {
  total_adapters: number;
  total_operations: number;
  adapters: AdapterOperationGroup[];
  /** Adapter ordered by operation_count desc with adapter_id asc
   *  tie-break — most-featured adapter floats to the top. */
  most_capable_adapter: {
    adapter_id: AdapterId;
    operation_count: number;
  };
}

// ─── Operation catalog (hand-curated) ─────────────────────────────────

interface AdapterMeta {
  adapter_id: AdapterId;
  label: string;
  base_path: string;
  operations: AdapterOperation[];
}

const CUSTOMER_ID_PARAM: OperationParameter = {
  name: 'customer_id',
  in: 'query',
  type: 'string',
  required: true,
  description: 'Customer identifier (matches M14 stub synthesis cohort).',
};

const PAGE_PARAMS: OperationParameter[] = [
  {
    name: 'page',
    in: 'query',
    type: 'integer',
    required: false,
    description: '1-based page number (default 1).',
  },
  {
    name: 'page_size',
    in: 'query',
    type: 'integer',
    required: false,
    description: 'Page size; adapter-specific cap.',
  },
];

const ADAPTERS: readonly AdapterMeta[] = [
  // ─── insurance (M14.1) ─────────────────────────────────────────────
  {
    adapter_id: 'insurance',
    label: 'Core Insurance',
    base_path: '/v1/integrations/insurance',
    operations: [
      {
        operation_id: 'listPolicies',
        method: 'GET',
        path: '/v1/integrations/insurance/policies',
        description: 'List a customer\'s policies, newest-inception first.',
        parameters: [CUSTOMER_ID_PARAM],
      },
      {
        operation_id: 'getPolicy',
        method: 'GET',
        path: '/v1/integrations/insurance/policies/:policy_id',
        description: 'Fetch a single policy by id (deterministic shape from id).',
        parameters: [
          {
            name: 'policy_id',
            in: 'path',
            type: 'string',
            required: true,
            description: 'Canonical id (POL-<TEN>-<6 digits>).',
          },
        ],
      },
      {
        operation_id: 'listClaims',
        method: 'GET',
        path: '/v1/integrations/insurance/claims',
        description: 'List a customer\'s claims, newest-filed first.',
        parameters: [CUSTOMER_ID_PARAM],
      },
      {
        operation_id: 'getClaim',
        method: 'GET',
        path: '/v1/integrations/insurance/claims/:claim_id',
        description: 'Fetch a single claim by id.',
        parameters: [
          {
            name: 'claim_id',
            in: 'path',
            type: 'string',
            required: true,
            description: 'Canonical id (CLM-<TEN>-<6 digits>).',
          },
        ],
      },
    ],
  },

  // ─── ifrs9 (M14.2) ─────────────────────────────────────────────────
  {
    adapter_id: 'ifrs9',
    label: 'IFRS9 Stages',
    base_path: '/v1/integrations/ifrs9',
    operations: [
      {
        operation_id: 'getStage',
        method: 'GET',
        path: '/v1/integrations/ifrs9/stages/:customer_id',
        description: 'Fetch a customer\'s current IFRS9 stage + PD/LGD/EAD/ECL.',
        parameters: [
          {
            name: 'customer_id',
            in: 'path',
            type: 'string',
            required: true,
            description: 'Customer identifier.',
          },
        ],
      },
      {
        operation_id: 'listStages',
        method: 'GET',
        path: '/v1/integrations/ifrs9/stages',
        description: 'Paginated list filtered by IFRS9 stage (1/2/3), sorted highest-ECL first.',
        parameters: [
          {
            name: 'stage',
            in: 'query',
            type: 'enum',
            required: false,
            description: 'Filter by IFRS9 stage (1, 2, or 3).',
            enum_values: ['1', '2', '3'],
          },
          ...PAGE_PARAMS,
        ],
      },
    ],
  },

  // ─── aml (M14.3) ───────────────────────────────────────────────────
  {
    adapter_id: 'aml',
    label: 'AML Watchlist',
    base_path: '/v1/integrations/aml',
    operations: [
      {
        operation_id: 'screenCustomer',
        method: 'POST',
        path: '/v1/integrations/aml/screen',
        description: 'Screen a customer (idempotent per tenant/customer; persists matches for review).',
        parameters: [
          {
            name: 'customer_id',
            in: 'body',
            type: 'string',
            required: true,
            description: 'Customer identifier.',
          },
        ],
      },
      {
        operation_id: 'listMatches',
        method: 'GET',
        path: '/v1/integrations/aml/matches',
        description: 'List persisted matches for a customer (sorted highest-severity first).',
        parameters: [CUSTOMER_ID_PARAM],
      },
      {
        operation_id: 'getMatch',
        method: 'GET',
        path: '/v1/integrations/aml/matches/:match_id',
        description: 'Fetch a single match by id.',
        parameters: [
          {
            name: 'match_id',
            in: 'path',
            type: 'string',
            required: true,
            description: 'Match identifier.',
          },
        ],
      },
      {
        operation_id: 'updateMatchStatus',
        method: 'PATCH',
        path: '/v1/integrations/aml/matches/:match_id',
        description: 'Transition a match through the review workflow.',
        parameters: [
          {
            name: 'match_id',
            in: 'path',
            type: 'string',
            required: true,
            description: 'Match identifier.',
          },
          {
            name: 'status',
            in: 'body',
            type: 'enum',
            required: true,
            description: 'Review workflow state.',
            enum_values: ['open', 'cleared', 'escalated', 'false_positive'],
          },
        ],
      },
    ],
  },

  // ─── dms (M14.4) ───────────────────────────────────────────────────
  {
    adapter_id: 'dms',
    label: 'Document Management',
    base_path: '/v1/integrations/dms',
    operations: [
      {
        operation_id: 'document-types',
        method: 'GET',
        path: '/v1/integrations/dms/document-types',
        description: 'List the 9 document type enum values.',
        parameters: [],
      },
      {
        operation_id: 'listDocuments',
        method: 'GET',
        path: '/v1/integrations/dms/documents',
        description: 'List documents for a customer OR a case (exactly one required).',
        parameters: [
          {
            name: 'customer_id',
            in: 'query',
            type: 'string',
            required: false,
            description: 'Customer filter (mutually exclusive with case_id).',
          },
          {
            name: 'case_id',
            in: 'query',
            type: 'string',
            required: false,
            description: 'Case filter (mutually exclusive with customer_id).',
          },
        ],
      },
      {
        operation_id: 'getDocument',
        method: 'GET',
        path: '/v1/integrations/dms/documents/:document_id',
        description: 'Fetch a single document by id.',
        parameters: [
          {
            name: 'document_id',
            in: 'path',
            type: 'string',
            required: true,
            description: 'Document identifier (dms-<TEN>-<7 digits>).',
          },
        ],
      },
      {
        operation_id: 'updateDocumentStatus',
        method: 'PATCH',
        path: '/v1/integrations/dms/documents/:document_id/status',
        description: 'Move a document through its review status workflow.',
        parameters: [
          {
            name: 'document_id',
            in: 'path',
            type: 'string',
            required: true,
            description: 'Document identifier.',
          },
          {
            name: 'status',
            in: 'body',
            type: 'enum',
            required: true,
            description: 'Document review status.',
            enum_values: ['pending_review', 'verified', 'rejected', 'expired'],
          },
        ],
      },
    ],
  },

  // ─── bureau (M14.5) ────────────────────────────────────────────────
  {
    adapter_id: 'bureau',
    label: 'Credit Bureau',
    base_path: '/v1/integrations/bureau',
    operations: [
      {
        operation_id: 'types',
        method: 'GET',
        path: '/v1/integrations/bureau/types',
        description: 'List the 4 supported bureau enum values.',
        parameters: [],
      },
      {
        operation_id: 'pull',
        method: 'POST',
        path: '/v1/integrations/bureau/pull',
        description: 'Synchronously pull a bureau report (idempotent per day).',
        parameters: [
          {
            name: 'customer_id',
            in: 'body',
            type: 'string',
            required: true,
            description: 'Customer identifier.',
          },
          {
            name: 'bureau_type',
            in: 'body',
            type: 'enum',
            required: true,
            description: 'Which bureau to query.',
            enum_values: ['CIBIL', 'CRIF', 'EXPERIAN', 'EQUIFAX'],
          },
        ],
      },
      {
        operation_id: 'listReports',
        method: 'GET',
        path: '/v1/integrations/bureau/reports',
        description: 'List persisted reports for a customer, newest-first.',
        parameters: [CUSTOMER_ID_PARAM],
      },
      {
        operation_id: 'getReport',
        method: 'GET',
        path: '/v1/integrations/bureau/reports/:report_id',
        description: 'Fetch a single bureau report by id.',
        parameters: [
          {
            name: 'report_id',
            in: 'path',
            type: 'string',
            required: true,
            description: 'Report identifier.',
          },
        ],
      },
    ],
  },

  // ─── agent (M14.6) ─────────────────────────────────────────────────
  {
    adapter_id: 'agent',
    label: 'Agent Productivity',
    base_path: '/v1/integrations/agent',
    operations: [
      {
        operation_id: 'listAgents',
        method: 'GET',
        path: '/v1/integrations/agent/agents',
        description: 'Paginated list of agents (50 per tenant) with optional tier + status filters.',
        parameters: [
          {
            name: 'tier',
            in: 'query',
            type: 'enum',
            required: false,
            description: 'Agent tier filter.',
            enum_values: ['gold', 'silver', 'bronze'],
          },
          {
            name: 'status',
            in: 'query',
            type: 'enum',
            required: false,
            description: 'Agent status filter.',
            enum_values: ['active', 'suspended', 'terminated', 'on_leave'],
          },
          ...PAGE_PARAMS,
        ],
      },
      {
        operation_id: 'getAgent',
        method: 'GET',
        path: '/v1/integrations/agent/agents/:agent_id',
        description: 'Fetch a single agent by id.',
        parameters: [
          {
            name: 'agent_id',
            in: 'path',
            type: 'string',
            required: true,
            description: 'Agent identifier.',
          },
        ],
      },
      {
        operation_id: 'getProductivity',
        method: 'GET',
        path: '/v1/integrations/agent/agents/:agent_id/productivity',
        description: 'Fetch a single-period productivity record (defaults to current month).',
        parameters: [
          {
            name: 'agent_id',
            in: 'path',
            type: 'string',
            required: true,
            description: 'Agent identifier.',
          },
          {
            name: 'period',
            in: 'query',
            type: 'string',
            required: false,
            description: 'YYYY-MM period; defaults to current month.',
          },
        ],
      },
      {
        operation_id: 'listProductivity',
        method: 'GET',
        path: '/v1/integrations/agent/agents/:agent_id/productivity/history',
        description: 'Trailing productivity history (months clamped to [1, 36]).',
        parameters: [
          {
            name: 'agent_id',
            in: 'path',
            type: 'string',
            required: true,
            description: 'Agent identifier.',
          },
          {
            name: 'months',
            in: 'query',
            type: 'integer',
            required: false,
            description: 'Number of months (1..36, default 12).',
          },
        ],
      },
    ],
  },

  // ─── finance (M14.7) ───────────────────────────────────────────────
  {
    adapter_id: 'finance',
    label: 'Finance / Treasury',
    base_path: '/v1/integrations/finance',
    operations: [
      {
        operation_id: 'listAccountsForCustomer',
        method: 'GET',
        path: '/v1/integrations/finance/accounts',
        description: 'List a customer\'s accounts, newest-activity first.',
        parameters: [CUSTOMER_ID_PARAM],
      },
      {
        operation_id: 'getAccount',
        method: 'GET',
        path: '/v1/integrations/finance/accounts/:account_id',
        description: 'Fetch a single account by id.',
        parameters: [
          {
            name: 'account_id',
            in: 'path',
            type: 'string',
            required: true,
            description: 'Account identifier.',
          },
        ],
      },
      {
        operation_id: 'listLedger',
        method: 'GET',
        path: '/v1/integrations/finance/accounts/:account_id/ledger',
        description: 'Paginated ledger entries newest-first, with optional ISO time-window filters.',
        parameters: [
          {
            name: 'account_id',
            in: 'path',
            type: 'string',
            required: true,
            description: 'Account identifier.',
          },
          {
            name: 'since',
            in: 'query',
            type: 'datetime',
            required: false,
            description: 'Lower-bound ISO datetime (inclusive).',
          },
          {
            name: 'until',
            in: 'query',
            type: 'datetime',
            required: false,
            description: 'Upper-bound ISO datetime (inclusive).',
          },
          ...PAGE_PARAMS,
        ],
      },
    ],
  },

  // ─── hr (M14.8) ────────────────────────────────────────────────────
  {
    adapter_id: 'hr',
    label: 'HR',
    base_path: '/v1/integrations/hr',
    operations: [
      {
        operation_id: 'listEmployees',
        method: 'GET',
        path: '/v1/integrations/hr/employees',
        description: 'Paginated list of employees (80 per tenant) with department + status filters.',
        parameters: [
          {
            name: 'department',
            in: 'query',
            type: 'enum',
            required: false,
            description: 'Employee department.',
            enum_values: ['risk', 'underwriting', 'claims', 'operations', 'compliance', 'it', 'finance', 'admin'],
          },
          {
            name: 'status',
            in: 'query',
            type: 'enum',
            required: false,
            description: 'Employment status.',
            enum_values: ['active', 'on_leave', 'suspended', 'terminated'],
          },
          ...PAGE_PARAMS,
        ],
      },
      {
        operation_id: 'getEmployee',
        method: 'GET',
        path: '/v1/integrations/hr/employees/:employee_id',
        description: 'Fetch a single employee by id.',
        parameters: [
          {
            name: 'employee_id',
            in: 'path',
            type: 'string',
            required: true,
            description: 'Employee identifier.',
          },
        ],
      },
      {
        operation_id: 'getLeaveBalance',
        method: 'GET',
        path: '/v1/integrations/hr/employees/:employee_id/leave-balance',
        description: 'Fetch an employee\'s leave balance snapshot.',
        parameters: [
          {
            name: 'employee_id',
            in: 'path',
            type: 'string',
            required: true,
            description: 'Employee identifier.',
          },
        ],
      },
    ],
  },
] as const;

// ─── Pure resolver ────────────────────────────────────────────────────

export function listAdapterOperationCatalog(): AdapterOperationCatalog {
  const adapters: AdapterOperationGroup[] = ADAPTERS.map((a) => ({
    adapter_id: a.adapter_id,
    label: a.label,
    base_path: a.base_path,
    operation_count: a.operations.length,
    operations: a.operations.map((op) => ({
      operation_id: op.operation_id,
      method: op.method,
      path: op.path,
      description: op.description,
      // Defensive deep-copy so SPA mutations don't pollute the singleton.
      parameters: op.parameters.map((p) => ({
        ...p,
        ...(p.enum_values ? { enum_values: [...p.enum_values] } : {}),
      })),
    })),
  }));

  const total_operations = adapters.reduce((sum, a) => sum + a.operation_count, 0);

  // most_capable_adapter: highest operation_count; tie-break by adapter_id asc.
  const sortedForMost = [...adapters].sort((a, b) => {
    if (b.operation_count !== a.operation_count) return b.operation_count - a.operation_count;
    return a.adapter_id.localeCompare(b.adapter_id);
  });

  return {
    total_adapters: adapters.length,
    total_operations,
    adapters,
    most_capable_adapter: {
      adapter_id: sortedForMost[0]!.adapter_id,
      operation_count: sortedForMost[0]!.operation_count,
    },
  };
}

export function getAdapterOperations(adapter_id: string): AdapterOperationGroup | null {
  const catalog = listAdapterOperationCatalog();
  return catalog.adapters.find((a) => a.adapter_id === adapter_id) ?? null;
}
