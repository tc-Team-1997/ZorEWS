// infra/rbac/lib/src/index.ts
//
// Tiny RBAC helper. Loads the canonical matrix at infra/rbac/matrix.json
// and exposes `can(role, operation)`. Services import this for HTTP-level
// authorisation guards.

import * as fs from 'node:fs';
import * as path from 'node:path';

export type Role =
  | 'admin'
  | 'risk_analyst'
  | 'supervisor'
  | 'collection_officer'
  | 'field_officer';

export interface Matrix {
  version: string;
  roles: Role[];
  operations: Record<string, Role[]>;
  role_descriptions: Partial<Record<Role, string>>;
}

// The same source compiles to either `lib/src/index.ts` (ts-jest) or
// `lib/dist/src/index.js` (after tsc). Walk up looking for matrix.json so
// both layouts find it.
function findDefaultMatrixPath(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'matrix.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to the source layout — the loader will throw a clear error
  // if the file is genuinely missing.
  return path.resolve(__dirname, '..', '..', 'matrix.json');
}
const DEFAULT_MATRIX_PATH = findDefaultMatrixPath();

let _matrix: Matrix | null = null;
let _matrixPath = DEFAULT_MATRIX_PATH;

export function loadMatrix(matrixPath?: string): Matrix {
  if (_matrix && (!matrixPath || matrixPath === _matrixPath)) return _matrix;
  const p = matrixPath ?? _matrixPath;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));

  const roles: unknown = raw.roles;
  if (!Array.isArray(roles) || !roles.every((r) => typeof r === 'string')) {
    throw new Error(`${p}: roles must be a string[]`);
  }
  const ops: unknown = raw.operations;
  if (!ops || typeof ops !== 'object' || Array.isArray(ops)) {
    throw new Error(`${p}: operations must be an object`);
  }
  const roleSet = new Set(roles as string[]);
  for (const [op, allowed] of Object.entries(ops as Record<string, unknown>)) {
    if (!Array.isArray(allowed)) {
      throw new Error(`${p}: operation ${op} must list allowed roles`);
    }
    for (const a of allowed) {
      if (typeof a !== 'string' || !roleSet.has(a)) {
        throw new Error(`${p}: operation ${op} references unknown role: ${String(a)}`);
      }
    }
  }
  _matrix = raw as Matrix;
  _matrixPath = p;
  return _matrix;
}

/** Test/dev helper. */
export function resetMatrix(): void {
  _matrix = null;
  _matrixPath = DEFAULT_MATRIX_PATH;
}

/**
 * Authorisation check. Returns true iff `role` is allowed `operation` per the
 * canonical matrix. Unknown operations and unknown roles deny by default —
 * fail-closed is the right call for an HTTP guard.
 */
export function can(role: string, operation: string, matrixPath?: string): boolean {
  const m = loadMatrix(matrixPath);
  const allowed = m.operations[operation];
  if (!allowed) return false;
  return allowed.includes(role as Role);
}

/** All operations the role is granted, in matrix order. */
export function operationsFor(role: string, matrixPath?: string): string[] {
  const m = loadMatrix(matrixPath);
  return Object.entries(m.operations)
    .filter(([, allowed]) => allowed.includes(role as Role))
    .map(([op]) => op);
}

/** Express middleware factory: requires the request to carry a role attribute. */
export function requireRole(operation: string, getRole: (req: unknown) => string | null) {
  return (req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void): void => {
    const role = getRole(req);
    if (!role) {
      res.status(401).json({ error: 'authentication required' });
      return;
    }
    if (!can(role, operation)) {
      res.status(403).json({ error: `role ${role} cannot ${operation}` });
      return;
    }
    next();
  };
}
