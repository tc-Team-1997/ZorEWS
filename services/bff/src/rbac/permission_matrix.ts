// services/bff/src/rbac/permission_matrix.ts
//
// Enterprise Permission Matrix store.
//
// OVERLAY on top of the existing `requireRole('op')` middleware +
// infra/rbac/matrix.json. Adds a (role × module × action) grant matrix
// that the SPA matrix editor can CRUD against. Pure additive — does
// NOT replace anything; can compose with the legacy op-string gate.
//
// Storage:
//   - InMemoryPermissionMatrixStore for dev/tests
//   - Mirrors data/schema/049_rbac_permission_matrix.sql for the
//     pg-backed swap (production: re-implement IPermissionMatrixStore
//     against rbac.permission_action + rbac.permission_module +
//     rbac.role_permission).

export const PERMISSION_ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'configure'] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export interface PermissionActionDef {
  id: PermissionAction;
  label: string;
  description: string;
  sort_order: number;
}

export const PERMISSION_ACTION_CATALOG: readonly PermissionActionDef[] = [
  { id: 'view', label: 'View', description: 'Read or list records in the module', sort_order: 1 },
  { id: 'create', label: 'Create', description: 'Create new records within the module', sort_order: 2 },
  { id: 'edit', label: 'Edit', description: 'Modify existing records', sort_order: 3 },
  { id: 'delete', label: 'Delete', description: 'Soft-delete or hard-delete records', sort_order: 4 },
  { id: 'approve', label: 'Approve', description: 'Approve maker-checker workflows (4-eyes second step)', sort_order: 5 },
  { id: 'export', label: 'Export', description: 'Export records to CSV / PDF / Excel', sort_order: 6 },
  { id: 'configure', label: 'Configure', description: 'Edit module configuration + thresholds (admin-level)', sort_order: 7 },
] as const;

export type PermissionModuleCategory =
  | 'dashboard'
  | 'banking'
  | 'insurance'
  | 'workflow'
  | 'reporting'
  | 'ai'
  | 'admin'
  | 'data';

export type PermissionModuleDomain = 'banking' | 'insurance' | 'both';

export interface PermissionModuleDef {
  id: string;
  label: string;
  description: string;
  category: PermissionModuleCategory;
  domain: PermissionModuleDomain;
  sort_order: number;
  active: boolean;
}

/** Mirrors the seed in 049_rbac_permission_matrix.sql. */
export const PERMISSION_MODULE_CATALOG: readonly PermissionModuleDef[] = [
  // Dashboard
  { id: 'dashboard', label: 'Dashboard', description: 'Enterprise + per-role landing dashboards', category: 'dashboard', domain: 'both', sort_order: 1, active: true },
  // Banking
  { id: 'borrower_watch', label: 'Borrower Watch', description: 'Per-borrower watchlist + drill-through', category: 'banking', domain: 'banking', sort_order: 10, active: true },
  { id: 'account_behaviour', label: 'Account Behaviour', description: 'Behavioural-signal monitoring on accounts', category: 'banking', domain: 'banking', sort_order: 11, active: true },
  { id: 'financial_ratios', label: 'Financial Ratios', description: 'DSCR / ICR / DE etc + CMA pack', category: 'banking', domain: 'banking', sort_order: 12, active: true },
  { id: 'sma_classification', label: 'SMA Classification', description: 'RBI SMA-0/1/2 movement + drill', category: 'banking', domain: 'banking', sort_order: 13, active: true },
  { id: 'npa_prediction', label: 'NPA Prediction', description: 'AI-driven NPA forecasting', category: 'banking', domain: 'banking', sort_order: 14, active: true },
  { id: 'sector_watch', label: 'Sector Watch', description: 'Portfolio concentration × stress', category: 'banking', domain: 'banking', sort_order: 15, active: true },
  { id: 'fraud_detection', label: 'Fraud Detection', description: 'Fraud signals + investigation surface (banking-side)', category: 'banking', domain: 'banking', sort_order: 16, active: true },
  // Insurance
  { id: 'claims_anomaly', label: 'Claims Anomaly', description: 'Claim-fraud + anomalous-claim detection', category: 'insurance', domain: 'insurance', sort_order: 20, active: true },
  { id: 'policy_lapse_risk', label: 'Policy Lapse Risk', description: 'Lapse-risk forecasting + persistency', category: 'insurance', domain: 'insurance', sort_order: 21, active: true },
  { id: 'solvency_watch', label: 'Solvency Watch', description: 'IRDAI solvency margin + drivers', category: 'insurance', domain: 'insurance', sort_order: 22, active: true },
  { id: 'underwriting', label: 'Underwriting Deviation', description: 'Underwriting deviation review + approval', category: 'insurance', domain: 'insurance', sort_order: 23, active: true },
  { id: 'channel_risk', label: 'Channel Risk', description: 'Distribution-channel scorecards', category: 'insurance', domain: 'insurance', sort_order: 24, active: true },
  // Workflow + AI
  { id: 'alerts', label: 'Alerts', description: 'Alert center: classify, route, acknowledge, escalate', category: 'workflow', domain: 'both', sort_order: 30, active: true },
  { id: 'cases', label: 'Cases', description: 'Case-management workflow incl. maker-checker', category: 'workflow', domain: 'both', sort_order: 31, active: true },
  { id: 'rules_engine', label: 'Rules Engine', description: 'Rule authoring, simulation, versioning, approval', category: 'ai', domain: 'both', sort_order: 40, active: true },
  { id: 'scenarios', label: 'Scenarios', description: 'Scenario library + stress-test simulation', category: 'ai', domain: 'both', sort_order: 41, active: true },
  { id: 'ai_models', label: 'AI Models', description: 'Model registry + promotion + drift monitoring', category: 'ai', domain: 'both', sort_order: 42, active: true },
  // Reporting
  { id: 'reports', label: 'Reports', description: 'Reports + report builder + scheduled jobs', category: 'reporting', domain: 'both', sort_order: 50, active: true },
  // Admin
  { id: 'users', label: 'Users & RBAC', description: 'User lifecycle: create, edit, disable, force-logout', category: 'admin', domain: 'both', sort_order: 60, active: true },
  { id: 'master_data', label: 'Master Data', description: 'Master entity CRUD (countries / currencies / case-types …)', category: 'admin', domain: 'both', sort_order: 61, active: true },
  { id: 'audit_trail', label: 'Audit Trail', description: 'Hash-chained audit events + evidence packaging', category: 'admin', domain: 'both', sort_order: 62, active: true },
  { id: 'configuration', label: 'Configuration', description: 'Platform configuration: alerts SLA / notification toggles', category: 'admin', domain: 'both', sort_order: 63, active: true },
  { id: 'permission_matrix', label: 'Permission Matrix', description: 'This very surface — manage role × module × action grants', category: 'admin', domain: 'both', sort_order: 64, active: true },
  // Data plane
  { id: 'data_ingestion', label: 'Data Ingestion', description: 'Source connectors + schema + run history', category: 'data', domain: 'both', sort_order: 70, active: true },
  { id: 'data_quality', label: 'Data Quality', description: 'DQ rules + profiling + standardisation', category: 'data', domain: 'both', sort_order: 71, active: true },
] as const;

export const PERMISSION_MODULE_IDS = PERMISSION_MODULE_CATALOG.map((m) => m.id);

export type EnterpriseRoleId =
  | 'super_admin'
  | 'country_admin'
  | 'bank_admin'
  | 'insurance_admin'
  | 'risk_analyst'
  | 'fraud_analyst'
  | 'credit_officer'
  | 'operations_user'
  | 'auditor'
  | 'read_only_user';

export const ENTERPRISE_ROLE_IDS: readonly EnterpriseRoleId[] = [
  'super_admin',
  'country_admin',
  'bank_admin',
  'insurance_admin',
  'risk_analyst',
  'fraud_analyst',
  'credit_officer',
  'operations_user',
  'auditor',
  'read_only_user',
] as const;

export interface RolePermissionEntry {
  role_id: string;
  module_id: string;
  action_id: PermissionAction;
  granted: boolean;
  granted_by: string | null;
  granted_at: string;
  updated_at: string;
}

export interface RolePermissionGrid {
  role_id: string;
  permissions: Record<string, Record<PermissionAction, boolean>>;
}

export interface MatrixSnapshot {
  generated_at: string;
  total_roles: number;
  total_modules: number;
  total_actions: number;
  /** role_id → module_id → action_id → granted boolean. Sparse — only granted=true present. */
  matrix: Record<string, Record<string, Record<PermissionAction, boolean>>>;
}

export class PermissionMatrixError extends Error {
  constructor(public readonly code: 'invalid_input' | 'unknown_role' | 'unknown_module' | 'unknown_action' | 'invalid_grants') {
    super(code);
  }
}

export function isPermissionAction(s: unknown): s is PermissionAction {
  return typeof s === 'string' && (PERMISSION_ACTIONS as readonly string[]).includes(s);
}

export function isPermissionModuleId(s: unknown): boolean {
  return typeof s === 'string' && PERMISSION_MODULE_IDS.includes(s);
}

export function getModuleDef(module_id: string): PermissionModuleDef | undefined {
  return PERMISSION_MODULE_CATALOG.find((m) => m.id === module_id);
}

export function getActionDef(action_id: string): PermissionActionDef | undefined {
  return PERMISSION_ACTION_CATALOG.find((a) => a.id === action_id);
}

export interface IPermissionMatrixStore {
  /** Returns granted=true entries for a given role. Unknown role returns []. */
  listForRole(role_id: string): RolePermissionEntry[];

  /** Snapshot of the entire matrix (granted=true only) sparse-grouped. */
  snapshot(now: Date): MatrixSnapshot;

  /** Per-role flat grid (module → action → granted). EVERY module + action key always present
   *  to give the SPA a stable grid; unset entries are `false`. */
  gridForRole(role_id: string): RolePermissionGrid;

  /** Check a single (role, module, action). */
  isGranted(role_id: string, module_id: string, action_id: PermissionAction): boolean;

  /** Resolve permissions for a user holding ≥ 1 role; OR-merge across roles. */
  resolveForRoles(role_ids: readonly string[]): RolePermissionGrid;

  /** Bulk-replace a role's grants. Throws on bad shape. */
  setRoleGrants(
    role_id: string,
    grants: Record<string, Partial<Record<PermissionAction, boolean>>>,
    actor: string,
    now: Date,
  ): RolePermissionEntry[];

  /** Set a single cell. */
  setCell(
    role_id: string,
    module_id: string,
    action_id: PermissionAction,
    granted: boolean,
    actor: string,
    now: Date,
  ): RolePermissionEntry;
}

function emptyGrid(): Record<string, Record<PermissionAction, boolean>> {
  const grid: Record<string, Record<PermissionAction, boolean>> = {};
  for (const m of PERMISSION_MODULE_CATALOG) {
    grid[m.id] = {} as Record<PermissionAction, boolean>;
    for (const a of PERMISSION_ACTIONS) grid[m.id][a] = false;
  }
  return grid;
}

export class InMemoryPermissionMatrixStore implements IPermissionMatrixStore {
  // Keyed `role:module:action` → entry.
  private readonly cells = new Map<string, RolePermissionEntry>();

  constructor(initial?: Iterable<RolePermissionEntry>) {
    if (initial) for (const e of initial) this.cells.set(key(e.role_id, e.module_id, e.action_id), e);
  }

  /** Replace the store from a seed source — used at boot to pre-populate matching the SQL seed. */
  seed(entries: Iterable<RolePermissionEntry>): void {
    this.cells.clear();
    for (const e of entries) this.cells.set(key(e.role_id, e.module_id, e.action_id), e);
  }

  listForRole(role_id: string): RolePermissionEntry[] {
    if (!role_id) return [];
    const out: RolePermissionEntry[] = [];
    for (const e of this.cells.values()) {
      if (e.role_id === role_id && e.granted) out.push({ ...e });
    }
    return out;
  }

  snapshot(now: Date): MatrixSnapshot {
    const matrix: Record<string, Record<string, Record<PermissionAction, boolean>>> = {};
    for (const e of this.cells.values()) {
      if (!e.granted) continue;
      matrix[e.role_id] ??= {};
      matrix[e.role_id][e.module_id] ??= {} as Record<PermissionAction, boolean>;
      matrix[e.role_id][e.module_id][e.action_id] = true;
    }
    return {
      generated_at: now.toISOString(),
      total_roles: ENTERPRISE_ROLE_IDS.length,
      total_modules: PERMISSION_MODULE_CATALOG.length,
      total_actions: PERMISSION_ACTIONS.length,
      matrix,
    };
  }

  gridForRole(role_id: string): RolePermissionGrid {
    const permissions = emptyGrid();
    for (const e of this.cells.values()) {
      if (e.role_id !== role_id || !e.granted) continue;
      if (permissions[e.module_id]) permissions[e.module_id][e.action_id] = true;
    }
    return { role_id, permissions };
  }

  isGranted(role_id: string, module_id: string, action_id: PermissionAction): boolean {
    const e = this.cells.get(key(role_id, module_id, action_id));
    return !!e && e.granted;
  }

  resolveForRoles(role_ids: readonly string[]): RolePermissionGrid {
    const permissions = emptyGrid();
    for (const rid of role_ids) {
      for (const e of this.cells.values()) {
        if (e.role_id !== rid || !e.granted) continue;
        if (permissions[e.module_id]) permissions[e.module_id][e.action_id] = true;
      }
    }
    return { role_id: role_ids.join('+'), permissions };
  }

  setRoleGrants(
    role_id: string,
    grants: Record<string, Partial<Record<PermissionAction, boolean>>>,
    actor: string,
    now: Date,
  ): RolePermissionEntry[] {
    if (!role_id || typeof role_id !== 'string') throw new PermissionMatrixError('invalid_input');
    if (!grants || typeof grants !== 'object') throw new PermissionMatrixError('invalid_grants');
    const touched: RolePermissionEntry[] = [];
    for (const [module_id, actions] of Object.entries(grants)) {
      if (!isPermissionModuleId(module_id)) throw new PermissionMatrixError('unknown_module');
      if (!actions || typeof actions !== 'object') throw new PermissionMatrixError('invalid_grants');
      for (const [action_id, granted] of Object.entries(actions)) {
        if (!isPermissionAction(action_id)) throw new PermissionMatrixError('unknown_action');
        if (typeof granted !== 'boolean') throw new PermissionMatrixError('invalid_grants');
        const k = key(role_id, module_id, action_id);
        const existing = this.cells.get(k);
        const entry: RolePermissionEntry = {
          role_id,
          module_id,
          action_id,
          granted,
          granted_by: actor,
          granted_at: existing?.granted_at ?? now.toISOString(),
          updated_at: now.toISOString(),
        };
        this.cells.set(k, entry);
        touched.push({ ...entry });
      }
    }
    return touched;
  }

  setCell(
    role_id: string,
    module_id: string,
    action_id: PermissionAction,
    granted: boolean,
    actor: string,
    now: Date,
  ): RolePermissionEntry {
    if (!role_id) throw new PermissionMatrixError('invalid_input');
    if (!isPermissionModuleId(module_id)) throw new PermissionMatrixError('unknown_module');
    if (!isPermissionAction(action_id)) throw new PermissionMatrixError('unknown_action');
    if (typeof granted !== 'boolean') throw new PermissionMatrixError('invalid_input');
    const k = key(role_id, module_id, action_id);
    const existing = this.cells.get(k);
    const entry: RolePermissionEntry = {
      role_id,
      module_id,
      action_id,
      granted,
      granted_by: actor,
      granted_at: existing?.granted_at ?? now.toISOString(),
      updated_at: now.toISOString(),
    };
    this.cells.set(k, entry);
    return { ...entry };
  }
}

function key(role: string, module: string, action: string): string {
  return `${role}::${module}::${action}`;
}

/** Mirror of the SQL seed in 049_rbac_permission_matrix.sql so the
 *  in-memory store renders the SAME default matrix in dev / tests. */
export function buildDefaultMatrixSeed(now: Date): RolePermissionEntry[] {
  const ts = now.toISOString();
  const every: PermissionAction[] = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'configure'];
  const viewExport: PermissionAction[] = ['view', 'export'];
  const viewOnly: PermissionAction[] = ['view'];
  const viewCreateEdit: PermissionAction[] = ['view', 'create', 'edit'];
  const viewEditExport: PermissionAction[] = ['view', 'edit', 'export'];
  const viewEditExportApprove: PermissionAction[] = ['view', 'edit', 'export', 'approve'];
  const bankingMods = ['dashboard', 'borrower_watch', 'account_behaviour', 'financial_ratios', 'sma_classification', 'npa_prediction', 'sector_watch', 'fraud_detection', 'alerts', 'cases', 'rules_engine', 'scenarios', 'ai_models', 'reports', 'audit_trail'];
  const insuranceMods = ['dashboard', 'claims_anomaly', 'policy_lapse_risk', 'solvency_watch', 'underwriting', 'channel_risk', 'fraud_detection', 'alerts', 'cases', 'rules_engine', 'scenarios', 'ai_models', 'reports', 'audit_trail'];
  const fraudMods = ['dashboard', 'fraud_detection', 'claims_anomaly', 'alerts', 'cases', 'audit_trail', 'reports'];
  const creditMods = ['dashboard', 'borrower_watch', 'account_behaviour', 'financial_ratios', 'sma_classification', 'npa_prediction', 'alerts', 'cases', 'reports'];
  const opsMods = ['dashboard', 'alerts', 'cases', 'reports'];
  const auditMods = ['dashboard', 'audit_trail', 'reports', 'users', 'permission_matrix'];
  const rdonlyMods = ['dashboard', 'borrower_watch', 'alerts', 'cases', 'reports'];
  const riskMods = ['dashboard', 'borrower_watch', 'npa_prediction', 'sma_classification', 'alerts', 'cases', 'rules_engine', 'scenarios', 'reports'];

  const out: RolePermissionEntry[] = [];
  const grant = (role: string, module: string, action: PermissionAction): void => {
    out.push({ role_id: role, module_id: module, action_id: action, granted: true, granted_by: 'system:seed', granted_at: ts, updated_at: ts });
  };

  // super_admin → everything
  for (const m of PERMISSION_MODULE_IDS) for (const a of every) grant('super_admin', m, a);

  // country_admin → everything except permission_matrix create/delete/configure
  for (const m of PERMISSION_MODULE_IDS) {
    for (const a of every) {
      if (m === 'permission_matrix' && (a === 'create' || a === 'delete' || a === 'configure')) continue;
      grant('country_admin', m, a);
    }
  }

  // bank_admin → banking surfaces (no rules_engine delete) + admin
  for (const m of bankingMods) for (const a of every) {
    if (m === 'rules_engine' && a === 'delete') continue;
    grant('bank_admin', m, a);
  }
  for (const m of ['users', 'master_data', 'configuration', 'audit_trail']) for (const a of viewEditExportApprove) grant('bank_admin', m, a);

  // insurance_admin → mirror of bank_admin on the insurance surface
  for (const m of insuranceMods) for (const a of every) {
    if (m === 'rules_engine' && a === 'delete') continue;
    grant('insurance_admin', m, a);
  }
  for (const m of ['users', 'master_data', 'configuration', 'audit_trail']) for (const a of viewEditExportApprove) grant('insurance_admin', m, a);

  // risk_analyst → analyse + simulate + export
  for (const m of riskMods) {
    for (const a of viewCreateEdit) grant('risk_analyst', m, a);
    grant('risk_analyst', m, 'export');
  }

  // fraud_analyst → fraud surfaces (view/edit/export + approve)
  for (const m of fraudMods) {
    for (const a of viewEditExport) grant('fraud_analyst', m, a);
    grant('fraud_analyst', m, 'approve');
  }

  // credit_officer → credit surfaces (view/edit/export) + approve cases
  for (const m of creditMods) for (const a of viewEditExport) grant('credit_officer', m, a);
  grant('credit_officer', 'cases', 'approve');

  // operations_user → ops surfaces (view + edit) + reports export
  for (const m of opsMods) for (const a of ['view', 'edit'] as PermissionAction[]) grant('operations_user', m, a);
  grant('operations_user', 'reports', 'export');

  // auditor → audit-relevant surfaces (view + export only)
  for (const m of auditMods) for (const a of viewExport) grant('auditor', m, a);

  // read_only_user → strict view
  for (const m of rdonlyMods) for (const a of viewOnly) grant('read_only_user', m, a);

  return out;
}

/** Default singleton, seeded once at module load with the same matrix
 *  the SQL migration declares. Tests can construct fresh instances. */
let _default: InMemoryPermissionMatrixStore | undefined;
export function defaultPermissionMatrixStore(): InMemoryPermissionMatrixStore {
  if (!_default) {
    _default = new InMemoryPermissionMatrixStore(buildDefaultMatrixSeed(new Date()));
  }
  return _default;
}

/** Test reset — wipes the singleton so the next call re-seeds. */
export function _resetDefaultPermissionMatrixStore(): void {
  _default = undefined;
}
