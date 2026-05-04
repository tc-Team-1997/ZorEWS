import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { can, loadMatrix, operationsFor, requireRole, resetMatrix } from '../src/index';

const REAL_MATRIX = path.resolve(__dirname, '..', '..', 'matrix.json');

beforeEach(() => resetMatrix());

describe('loadMatrix — real artefact', () => {
  test('loads and parses the canonical matrix', () => {
    const m = loadMatrix(REAL_MATRIX);
    expect(m.version).toBe('1.0.0');
    expect(m.roles).toContain('admin');
    expect(m.roles).toContain('field_officer');
    expect(Object.keys(m.operations).length).toBeGreaterThan(20);
  });

  test('rejects a matrix with unknown roles in operations', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-rbac-'));
    const p = path.join(dir, 'matrix.json');
    fs.writeFileSync(
      p,
      JSON.stringify({
        version: '0.0.0',
        roles: ['admin'],
        operations: { 'x:y': ['admin', 'ghost'] },
      }),
    );
    expect(() => loadMatrix(p)).toThrow(/ghost/);
  });

  test('rejects a matrix where roles is not an array of strings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-rbac-'));
    const p = path.join(dir, 'matrix.json');
    fs.writeFileSync(p, JSON.stringify({ version: '0', roles: 'admin', operations: {} }));
    expect(() => loadMatrix(p)).toThrow(/string\[\]/);
  });
});

describe('can(role, operation)', () => {
  test('admin can do everything in the matrix', () => {
    const m = loadMatrix(REAL_MATRIX);
    for (const op of Object.keys(m.operations)) {
      expect(can('admin', op, REAL_MATRIX)).toBe(true);
    }
  });

  test('field_officer can log_action but cannot retire rules', () => {
    expect(can('field_officer', 'cases:log_action', REAL_MATRIX)).toBe(true);
    expect(can('field_officer', 'rules:retire', REAL_MATRIX)).toBe(false);
  });

  test('risk_analyst cannot close cases (FR-CASE supervisor-only)', () => {
    expect(can('risk_analyst', 'cases:close', REAL_MATRIX)).toBe(false);
    expect(can('supervisor', 'cases:close', REAL_MATRIX)).toBe(true);
    expect(can('collection_officer', 'cases:close', REAL_MATRIX)).toBe(true);
  });

  test('collection_officer is the Collection-routing target', () => {
    expect(can('collection_officer', 'collection:callback', REAL_MATRIX)).toBe(true);
    expect(can('field_officer', 'collection:callback', REAL_MATRIX)).toBe(false);
  });

  test('unknown roles fail closed (deny)', () => {
    expect(can('ghost', 'alerts:list', REAL_MATRIX)).toBe(false);
  });

  test('unknown operations fail closed (deny)', () => {
    expect(can('admin', 'nonexistent:op', REAL_MATRIX)).toBe(false);
  });
});

describe('operationsFor', () => {
  test('returns the full set of permissions per role', () => {
    const ops = operationsFor('admin', REAL_MATRIX);
    expect(ops).toContain('users:create');
    expect(ops).toContain('audit:read');

    const fo = operationsFor('field_officer', REAL_MATRIX);
    expect(fo).not.toContain('users:create');
    expect(fo).toContain('cases:log_action');
  });
});

describe('requireRole — Express middleware', () => {
  function fakeRes() {
    const calls: { status?: number; body?: unknown } = {};
    return {
      calls,
      status(n: number) {
        calls.status = n;
        return {
          json(body: unknown) {
            calls.body = body;
          },
        };
      },
    };
  }

  test('401 when no role on request', () => {
    const guard = requireRole('cases:close', () => null);
    const res = fakeRes();
    let nextCalled = false;
    guard({}, res, () => {
      nextCalled = true;
    });
    expect(res.calls.status).toBe(401);
    expect(nextCalled).toBe(false);
  });

  test('403 when role is denied for the operation', () => {
    loadMatrix(REAL_MATRIX);
    const guard = requireRole('cases:close', () => 'risk_analyst');
    const res = fakeRes();
    let nextCalled = false;
    guard({}, res, () => {
      nextCalled = true;
    });
    expect(res.calls.status).toBe(403);
    expect((res.calls.body as { error: string }).error).toMatch(/risk_analyst/);
    expect(nextCalled).toBe(false);
  });

  test('next() when role is permitted', () => {
    loadMatrix(REAL_MATRIX);
    const guard = requireRole('cases:close', () => 'supervisor');
    const res = fakeRes();
    let nextCalled = false;
    guard({}, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(res.calls.status).toBeUndefined();
  });
});
