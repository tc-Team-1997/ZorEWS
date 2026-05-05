// services/bff/src/scenario_custom.ts
//
// T6 M16.4 — Custom user-defined scenario presets.
//
// M16.1 ships the platform-static library (10 presets). M16.4
// adds a per-tenant CRUD store for custom presets — admins author
// their own scenarios and the SPA renders them alongside the
// built-ins. M16.2 bulk-run + M16.3 diff don't need to change;
// callers pass `getEffectivePreset(tenant, id)` here to merge
// custom + library views.
//
// Design:
//  - Per-tenant cap of 50 custom presets.
//  - Custom preset ids must NOT collide with library ids — checked
//    at create time.
//  - Same `ScenarioPreset` shape as M16.1 so all downstream
//    consumers (M16.2 bulk-run, M16.3 diff) work without changes.

import { randomUUID } from 'node:crypto';
import {
  type ScenarioPreset,
  type ScenarioCategory,
  type ScenarioRegulator,
  type ScenarioSeverity,
  isScenarioCategory,
  isScenarioRegulator,
  isScenarioSeverity,
  getScenarioPreset as getLibraryPreset,
} from './scenario_library';

export interface CustomPresetInput {
  name: string;
  description: string;
  category: ScenarioCategory;
  regulator: ScenarioRegulator;
  severity: ScenarioSeverity;
  shocks: { gdp: number; rate: number; fx: number };
  source_doc?: string;
}

export class CustomPresetError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CustomPresetError';
  }
}

const CAP_PER_TENANT = 50;

function checkNumber(name: string, v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new CustomPresetError('invalid_input', `${name} must be a finite number`);
  }
  if (v < min || v > max) {
    throw new CustomPresetError('invalid_input', `${name} must be in [${min}, ${max}]`);
  }
  return v;
}

function validate(input: unknown): CustomPresetInput {
  if (!input || typeof input !== 'object') {
    throw new CustomPresetError('invalid_input', 'request body required');
  }
  const i = input as Record<string, unknown>;
  if (typeof i.name !== 'string' || !i.name.trim()) {
    throw new CustomPresetError('invalid_input', 'name is required');
  }
  if (i.name.length > 80) throw new CustomPresetError('invalid_input', 'name ≤ 80 chars');
  if (typeof i.description !== 'string' || !i.description.trim()) {
    throw new CustomPresetError('invalid_input', 'description is required');
  }
  if (i.description.length > 500) {
    throw new CustomPresetError('invalid_input', 'description ≤ 500 chars');
  }
  if (!isScenarioCategory(i.category)) {
    throw new CustomPresetError('invalid_input', 'invalid category');
  }
  if (!isScenarioRegulator(i.regulator)) {
    throw new CustomPresetError('invalid_input', 'invalid regulator');
  }
  if (!isScenarioSeverity(i.severity)) {
    throw new CustomPresetError('invalid_input', 'invalid severity');
  }
  if (!i.shocks || typeof i.shocks !== 'object') {
    throw new CustomPresetError('invalid_input', 'shocks must be an object');
  }
  const s = i.shocks as Record<string, unknown>;
  // Bounded ranges aligned with the platform library extremes
  const gdp = checkNumber('shocks.gdp', s.gdp, -20, 20);
  const rate = checkNumber('shocks.rate', s.rate, -1000, 1000);
  const fx = checkNumber('shocks.fx', s.fx, -50, 50);
  let source_doc: string | undefined;
  if (i.source_doc !== undefined) {
    if (typeof i.source_doc !== 'string') {
      throw new CustomPresetError('invalid_input', 'source_doc must be a string');
    }
    if (i.source_doc.length > 200) {
      throw new CustomPresetError('invalid_input', 'source_doc ≤ 200 chars');
    }
    source_doc = i.source_doc.trim();
  }
  return {
    name: i.name.trim(),
    description: i.description.trim(),
    category: i.category,
    regulator: i.regulator,
    severity: i.severity,
    shocks: { gdp, rate, fx },
    source_doc,
  };
}

// ─── Store ────────────────────────────────────────────────────────────

export interface CustomPresetStore {
  list(tenant_id: string): ScenarioPreset[];
  get(tenant_id: string, preset_id: string): ScenarioPreset | null;
  create(tenant_id: string, input: unknown, created_by: string, now: Date): ScenarioPreset;
  delete(tenant_id: string, preset_id: string): boolean;
}

export class InMemoryCustomPresetStore implements CustomPresetStore {
  private readonly perTenant = new Map<string, ScenarioPreset[]>();

  list(tenant_id: string): ScenarioPreset[] {
    return [...(this.perTenant.get(tenant_id) ?? [])];
  }

  get(tenant_id: string, preset_id: string): ScenarioPreset | null {
    return (
      this.perTenant.get(tenant_id)?.find((p) => p.id === preset_id) ?? null
    );
  }

  create(tenant_id: string, input: unknown, created_by: string, now: Date): ScenarioPreset {
    if (!created_by || !created_by.trim()) {
      throw new CustomPresetError('invalid_input', 'created_by required');
    }
    void now;
    const valid = validate(input);
    const arr = this.perTenant.get(tenant_id) ?? [];
    if (arr.length >= CAP_PER_TENANT) {
      throw new CustomPresetError(
        'cap_reached',
        `tenant ${tenant_id} already has ${CAP_PER_TENANT} custom presets`,
      );
    }
    const preset: ScenarioPreset = {
      id: `custom_${randomUUID().slice(0, 8)}`,
      name: valid.name,
      description: valid.description,
      category: valid.category,
      regulator: valid.regulator,
      severity: valid.severity,
      shocks: valid.shocks,
      source_doc: valid.source_doc ?? `User-authored by ${created_by.trim()}`,
    };
    // Defensive — should never collide given UUID prefix, but the
    // library is platform-static so an explicit guard is cheap.
    if (getLibraryPreset(preset.id)) {
      throw new CustomPresetError(
        'id_collision',
        `generated id ${preset.id} collides with a library preset`,
      );
    }
    arr.push(preset);
    this.perTenant.set(tenant_id, arr);
    return preset;
  }

  delete(tenant_id: string, preset_id: string): boolean {
    const arr = this.perTenant.get(tenant_id);
    if (!arr) return false;
    const idx = arr.findIndex((p) => p.id === preset_id);
    if (idx < 0) return false;
    arr.splice(idx, 1);
    return true;
  }
}

export const defaultCustomPresetStore: CustomPresetStore = new InMemoryCustomPresetStore();

/** Look up a preset by id — checks library first, then per-tenant
 *  custom store. Helper for downstream consumers (bulk-run, diff)
 *  that want a unified view. */
export function getEffectivePreset(
  store: CustomPresetStore,
  tenant_id: string,
  preset_id: string,
): ScenarioPreset | null {
  const lib = getLibraryPreset(preset_id);
  if (lib) return lib;
  return store.get(tenant_id, preset_id);
}
