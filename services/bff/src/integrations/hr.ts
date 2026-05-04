// services/bff/src/integrations/hr.ts
//
// T6 M14.8 — HR adapter (8th adapter in Module 14).
//
// Covers the BIL HR upstream (SAP SuccessFactors / Workday / etc):
// employee register + leave balance. Distinct from M14.6 Agent — agents
// are external sales force; HR holds bank/insurer staff (UW officers,
// case officers, ops, admins, IT, finance).
//
// Read-only at this stage; the upstream HR system owns mutations.
// 3 routes mirror the standard adapter shape: list-with-filters /
// single / per-resource sub-fetch.

// ─── Public types ──────────────────────────────────────────────────────

export type EmployeeStatus = 'active' | 'on_leave' | 'suspended' | 'terminated';
export type EmployeeType = 'permanent' | 'contract' | 'intern' | 'consultant';
export type EmployeeDepartment =
  | 'risk'
  | 'underwriting'
  | 'claims'
  | 'operations'
  | 'compliance'
  | 'it'
  | 'finance'
  | 'admin';

export interface Employee {
  employee_id: string;
  name: string;
  role: string;
  department: EmployeeDepartment;
  /** Manager's employee_id — null for department heads. */
  manager_id: string | null;
  status: EmployeeStatus;
  joined_at: string;
  type: EmployeeType;
  location: string;
}

export interface LeaveBalance {
  employee_id: string;
  /** Casual leave days remaining in current cycle. */
  casual_days_remaining: number;
  sick_days_remaining: number;
  annual_days_remaining: number;
  /** Compensatory off days accrued. */
  comp_off_remaining: number;
  /** ISO timestamp of the most-recent sync from the HR upstream. */
  last_synced_at: string;
}

export interface EmployeeListPage {
  items: Employee[];
  page: number;
  page_size: number;
  total: number;
  filter: {
    department?: EmployeeDepartment;
    status?: EmployeeStatus;
  } | null;
}

export interface HrAdapter {
  list(
    tenant_id: string,
    opts: {
      department?: EmployeeDepartment;
      status?: EmployeeStatus;
      page?: number;
      page_size?: number;
    },
    asOf: Date,
  ): Promise<EmployeeListPage>;
  get(tenant_id: string, employee_id: string): Promise<Employee | null>;
  /** Fetches the leave balance. Returns null when employee is unknown
   *  (the route maps null → 404). */
  getLeaveBalance(
    tenant_id: string,
    employee_id: string,
    asOf: Date,
  ): Promise<LeaveBalance | null>;
}

export class HrError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'HrError';
  }
}

const VALID_STATUSES: EmployeeStatus[] = ['active', 'on_leave', 'suspended', 'terminated'];
const VALID_DEPARTMENTS: EmployeeDepartment[] = [
  'risk',
  'underwriting',
  'claims',
  'operations',
  'compliance',
  'it',
  'finance',
  'admin',
];

export function isEmployeeStatus(s: unknown): s is EmployeeStatus {
  return typeof s === 'string' && VALID_STATUSES.includes(s as EmployeeStatus);
}
export function isEmployeeDepartment(s: unknown): s is EmployeeDepartment {
  return typeof s === 'string' && VALID_DEPARTMENTS.includes(s as EmployeeDepartment);
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

// ─── Stub data ─────────────────────────────────────────────────────────

const FLEET_SIZE = 80; // 80 staff per tenant — tighter than the 50-agent fleet
const FIRST = ['Asha', 'Rajiv', 'Priya', 'Arjun', 'Maya', 'Ravi', 'Sneha', 'Karan', 'Divya', 'Vikram', 'Faith', 'Mohammed'];
const LAST = ['Mwangi', 'Patel', 'Sharma', 'Kumar', 'Reddy', 'Iyer', 'Singh', 'Nair', 'Otieno', 'Onyango', 'Kariuki', 'Cheruiyot'];
const ROLES_BY_DEPT: Record<EmployeeDepartment, string[]> = {
  risk: ['Risk Analyst', 'Senior Risk Officer', 'Head of Risk'],
  underwriting: ['Underwriter', 'Senior Underwriter', 'UW Manager'],
  claims: ['Claims Officer', 'Claims Investigator', 'Claims Manager'],
  operations: ['Ops Officer', 'Ops Lead', 'Ops Manager'],
  compliance: ['Compliance Officer', 'AML Analyst', 'Head of Compliance'],
  it: ['Engineer', 'Senior Engineer', 'IT Manager'],
  finance: ['Accountant', 'Treasury Analyst', 'Finance Controller'],
  admin: ['Admin Officer', 'Executive Assistant', 'Office Manager'],
};
const LOCATIONS = ['Nairobi-HQ', 'Mumbai-BKC', 'Bangalore-Whitefield', 'Mombasa-Branch', 'Delhi-NCR', 'Pune-Office'];

function buildEmployee(tenant_id: string, index: number): Employee {
  const seed = fnv1a(`hr|${tenant_id}|${index}`);
  const r = rng(seed);
  // First 8 employees are department heads, each pinned to one of the
  // 8 departments in canonical order. Everyone else picks at random.
  const isHead = index < 8;
  const department: EmployeeDepartment = isHead
    ? VALID_DEPARTMENTS[index]!
    : pick(r, VALID_DEPARTMENTS);
  const roles = ROLES_BY_DEPT[department];
  const role = isHead ? roles[roles.length - 1]! : pick(r, roles.slice(0, -1));
  // Manager: department heads have null; everyone else reports to the
  // department head (the first 8 employees, by department index).
  const manager_id = isHead
    ? null
    : `EMP-${tenant_id.slice(0, 3).toUpperCase()}-${VALID_DEPARTMENTS.indexOf(department).toString().padStart(4, '0')}`;
  // Status distribution: 86% active, 7% on_leave, 4% suspended, 3% terminated.
  const statusRoll = r();
  const status: EmployeeStatus =
    statusRoll < 0.86 ? 'active' : statusRoll < 0.93 ? 'on_leave' : statusRoll < 0.97 ? 'suspended' : 'terminated';
  // Type distribution: 70% permanent, 18% contract, 7% consultant, 5% intern.
  const typeRoll = r();
  const type: EmployeeType =
    typeRoll < 0.7 ? 'permanent' : typeRoll < 0.88 ? 'contract' : typeRoll < 0.95 ? 'consultant' : 'intern';
  // Joined 30-3650 days ago (1 month - 10 years).
  const joinedDaysAgo = 30 + Math.floor(r() * 3620);
  const joined_at = new Date(Date.now() - joinedDaysAgo * 86_400_000).toISOString();

  return {
    employee_id: `EMP-${tenant_id.slice(0, 3).toUpperCase()}-${index.toString().padStart(4, '0')}`,
    name: `${pick(r, FIRST)} ${pick(r, LAST)}`,
    role,
    department,
    manager_id,
    status,
    joined_at,
    type,
    location: pick(r, LOCATIONS),
  };
}

function buildLeaveBalance(employee: Employee, asOf: Date): LeaveBalance {
  const seed = fnv1a(`leave|${employee.employee_id}|${asOf.toISOString().slice(0, 10)}`);
  const r = rng(seed);
  // Terminated → all zero. Other statuses → realistic remaining days
  // (annual cycle resets every Jan; assume mid-year query).
  if (employee.status === 'terminated') {
    return {
      employee_id: employee.employee_id,
      casual_days_remaining: 0,
      sick_days_remaining: 0,
      annual_days_remaining: 0,
      comp_off_remaining: 0,
      last_synced_at: asOf.toISOString(),
    };
  }
  // Permanent + intern entitlements differ — interns get fewer days.
  const isIntern = employee.type === 'intern';
  return {
    employee_id: employee.employee_id,
    casual_days_remaining: isIntern ? Math.floor(r() * 4) : Math.floor(r() * 8),
    sick_days_remaining: isIntern ? Math.floor(r() * 5) : Math.floor(r() * 10),
    annual_days_remaining: isIntern ? Math.floor(r() * 6) : Math.floor(r() * 18),
    comp_off_remaining: Math.floor(r() * 5),
    last_synced_at: asOf.toISOString(),
  };
}

// ─── Stub adapter ──────────────────────────────────────────────────────

export class StubHrAdapter implements HrAdapter {
  async list(
    tenant_id: string,
    opts: {
      department?: EmployeeDepartment;
      status?: EmployeeStatus;
      page?: number;
      page_size?: number;
    },
    _asOf: Date,
  ): Promise<EmployeeListPage> {
    const all: Employee[] = [];
    for (let i = 0; i < FLEET_SIZE; i++) {
      all.push(buildEmployee(tenant_id, i));
    }
    const filtered = all.filter((e) => {
      if (opts.department && e.department !== opts.department) return false;
      if (opts.status && e.status !== opts.status) return false;
      return true;
    });
    const page = Math.max(1, opts.page ?? 1);
    const page_size = Math.max(1, Math.min(100, opts.page_size ?? 25));
    const start = (page - 1) * page_size;
    return {
      items: filtered.slice(start, start + page_size),
      page,
      page_size,
      total: filtered.length,
      filter:
        opts.department || opts.status
          ? { department: opts.department, status: opts.status }
          : null,
    };
  }

  async get(tenant_id: string, employee_id: string): Promise<Employee | null> {
    if (!tenant_id || !employee_id) return null;
    const m = employee_id.match(new RegExp(`^EMP-${tenant_id.slice(0, 3).toUpperCase()}-(\\d{4})$`));
    if (!m) return null;
    const idx = parseInt(m[1]!, 10);
    if (idx < 0 || idx >= FLEET_SIZE) return null;
    return buildEmployee(tenant_id, idx);
  }

  async getLeaveBalance(
    tenant_id: string,
    employee_id: string,
    asOf: Date,
  ): Promise<LeaveBalance | null> {
    const employee = await this.get(tenant_id, employee_id);
    if (!employee) return null;
    return buildLeaveBalance(employee, asOf);
  }
}

/** Module-level singleton. */
export const defaultHrAdapter: HrAdapter = new StubHrAdapter();
