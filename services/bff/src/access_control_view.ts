// services/bff/src/access_control_view.ts
//
// Access Control Config — MASTER SETUP spec screen #20.
//
// A read-only viewer over the canonical RBAC matrix (infra/rbac/matrix.json).
// Operators see, in one place: which roles exist, which operations each role is
// granted, and the full role × operation grid grouped by resource. There is NO
// mutable per-tenant state here — the matrix is the platform's single source of
// truth and is edited via the matrix.json file + CI gate (infra/rbac), not at
// runtime. That keeps the authorisation contract version-controlled and
// auditable; this screen is the human-readable lens onto it.

import {
  loadMatrix,
  operationsFor,
  type Matrix,
  type Role,
} from '../../../infra/rbac/lib/dist/src/index';

export class AccessControlError extends Error {
  constructor(
    public code: 'unknown_role',
    message: string,
  ) {
    super(message);
    this.name = 'AccessControlError';
  }
}

// `resource:action` is the matrix convention; the first colon-delimited segment
// is the resource (alerts / cases / admin / …) and the remainder is the action.
export function resourceOf(operation: string): string {
  const idx = operation.indexOf(':');
  return idx < 0 ? operation : operation.slice(0, idx);
}
export function actionOf(operation: string): string {
  const idx = operation.indexOf(':');
  return idx < 0 ? operation : operation.slice(idx + 1);
}

export interface RoleSummaryShape {
  role: Role;
  description: string;
  operation_count: number;
}

export interface ResourceGroupShape {
  resource: string;
  operation_count: number;
  operations: string[]; // matrix order within the resource
}

export interface AccessControlOverviewShape {
  version: string;
  total_roles: number;
  total_operations: number;
  total_resources: number;
  roles: Role[];
  resources: ResourceGroupShape[]; // sorted by resource name asc
  role_summaries: RoleSummaryShape[]; // matrix role order
}

export interface RoleAccessShape {
  role: Role;
  description: string;
  total_operations: number;
  total_resources: number;
  resources: ResourceGroupShape[]; // only resources the role can touch; asc
}

export interface AccessMatrixRowShape {
  operation: string;
  resource: string;
  action: string;
  allowed_role_count: number;
  by_role: Record<Role, boolean>;
}

export interface AccessMatrixShape {
  version: string;
  roles: Role[];
  total_operations: number;
  rows: AccessMatrixRowShape[]; // matrix order
}

function descriptionFor(m: Matrix, role: Role): string {
  return m.role_descriptions[role] ?? '';
}

// Group operations by resource, preserving matrix declaration order within each
// resource. Returns groups sorted by resource name ascending for a stable grid.
function groupByResource(operations: string[]): ResourceGroupShape[] {
  const byResource = new Map<string, string[]>();
  for (const op of operations) {
    const res = resourceOf(op);
    const list = byResource.get(res);
    if (list) list.push(op);
    else byResource.set(res, [op]);
  }
  return Array.from(byResource.entries())
    .map(([resource, ops]) => ({ resource, operation_count: ops.length, operations: ops }))
    .sort((a, b) => a.resource.localeCompare(b.resource));
}

export function buildAccessControlOverview(): AccessControlOverviewShape {
  const m = loadMatrix();
  const allOps = Object.keys(m.operations);
  const resources = groupByResource(allOps);
  const role_summaries: RoleSummaryShape[] = m.roles.map((role) => ({
    role,
    description: descriptionFor(m, role),
    operation_count: operationsFor(role).length,
  }));
  return {
    version: m.version,
    total_roles: m.roles.length,
    total_operations: allOps.length,
    total_resources: resources.length,
    roles: [...m.roles],
    resources,
    role_summaries,
  };
}

export function buildRoleAccess(role: string): RoleAccessShape {
  const m = loadMatrix();
  if (!m.roles.includes(role as Role)) {
    throw new AccessControlError('unknown_role', `unknown role '${role}'`);
  }
  const ops = operationsFor(role);
  const resources = groupByResource(ops);
  return {
    role: role as Role,
    description: descriptionFor(m, role as Role),
    total_operations: ops.length,
    total_resources: resources.length,
    resources,
  };
}

export function buildAccessMatrix(): AccessMatrixShape {
  const m = loadMatrix();
  const rows: AccessMatrixRowShape[] = Object.entries(m.operations).map(([operation, allowed]) => {
    const by_role = {} as Record<Role, boolean>;
    for (const role of m.roles) by_role[role] = allowed.includes(role);
    return {
      operation,
      resource: resourceOf(operation),
      action: actionOf(operation),
      allowed_role_count: allowed.length,
      by_role,
    };
  });
  return {
    version: m.version,
    roles: [...m.roles],
    total_operations: rows.length,
    rows,
  };
}
