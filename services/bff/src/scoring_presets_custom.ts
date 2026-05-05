// services/bff/src/scoring_presets_custom.ts
//
// T6 M6.4 — Custom user-defined weight presets.
//
// M6.3 ships the platform-static weight preset library (6 presets:
// conservative/balanced/aggressive × banking/insurance). M6.4 adds
// a per-tenant CRUD store so tenants author their own multiplier
// bundles. Same WeightPreset shape so M6.3's PresetScopedLookup +
// scoreByPreset entry-point work unchanged when a custom id is
// passed in.
//
// Design mirrors M16.4 (custom scenario presets):
//  - Per-tenant cap = 30 custom presets.
//  - Custom ids prefixed `wp_custom_` + 8 hex chars; defensive
//    collision-check against the library on create.
//  - `getEffectiveWeightPreset(store, tenant, id)` — library
//    first, then per-tenant store. Helper for downstream consumers.

import { randomUUID } from 'node:crypto';
import {
  type WeightPreset,
  type WeightPresetMode,
  isWeightPresetMode,
  getWeightPreset as getLibraryWeightPreset,
} from './scoring_presets';
import { type ScoringVertical, isScoringVertical } from './bil_scoring_v2';

export interface CustomWeightPresetInput {
  name: string;
  description: string;
  vertical: ScoringVertical;
  mode: WeightPresetMode;
  weight_multipliers: Record<string, number>;
}

export class CustomWeightPresetError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CustomWeightPresetError';
  }
}

const CAP_PER_TENANT = 30;
const MULTIPLIER_MIN = 0.1;
const MULTIPLIER_MAX = 5.0;
const MAX_INDICATOR_KEYS = 50;

function validate(input: unknown): CustomWeightPresetInput {
  if (!input || typeof input !== 'object') {
    throw new CustomWeightPresetError('invalid_input', 'request body required');
  }
  const i = input as Record<string, unknown>;
  if (typeof i.name !== 'string' || !i.name.trim()) {
    throw new CustomWeightPresetError('invalid_input', 'name is required');
  }
  if (i.name.length > 80) {
    throw new CustomWeightPresetError('invalid_input', 'name ≤ 80 chars');
  }
  if (typeof i.description !== 'string' || !i.description.trim()) {
    throw new CustomWeightPresetError('invalid_input', 'description is required');
  }
  if (i.description.length > 500) {
    throw new CustomWeightPresetError('invalid_input', 'description ≤ 500 chars');
  }
  if (!isScoringVertical(i.vertical)) {
    throw new CustomWeightPresetError('invalid_input', 'vertical must be banking|insurance');
  }
  if (!isWeightPresetMode(i.mode)) {
    throw new CustomWeightPresetError(
      'invalid_input',
      'mode must be conservative|balanced|aggressive',
    );
  }
  if (
    !i.weight_multipliers ||
    typeof i.weight_multipliers !== 'object' ||
    Array.isArray(i.weight_multipliers)
  ) {
    throw new CustomWeightPresetError(
      'invalid_input',
      'weight_multipliers must be a JSON object',
    );
  }
  const wm = i.weight_multipliers as Record<string, unknown>;
  const keys = Object.keys(wm);
  if (keys.length > MAX_INDICATOR_KEYS) {
    throw new CustomWeightPresetError(
      'invalid_input',
      `weight_multipliers exceeds ${MAX_INDICATOR_KEYS} entries`,
    );
  }
  const cleaned: Record<string, number> = {};
  for (const k of keys) {
    if (!k.trim()) {
      throw new CustomWeightPresetError(
        'invalid_input',
        'weight_multipliers keys must be non-empty strings',
      );
    }
    const v = wm[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new CustomWeightPresetError(
        'invalid_input',
        `weight_multipliers.${k} must be a finite number`,
      );
    }
    if (v < MULTIPLIER_MIN || v > MULTIPLIER_MAX) {
      throw new CustomWeightPresetError(
        'invalid_input',
        `weight_multipliers.${k} must be in [${MULTIPLIER_MIN}, ${MULTIPLIER_MAX}]`,
      );
    }
    cleaned[k] = v;
  }
  return {
    name: i.name.trim(),
    description: i.description.trim(),
    vertical: i.vertical,
    mode: i.mode,
    weight_multipliers: cleaned,
  };
}

// ─── Store ────────────────────────────────────────────────────────────

export interface CustomWeightPresetStore {
  list(tenant_id: string): WeightPreset[];
  get(tenant_id: string, preset_id: string): WeightPreset | null;
  create(
    tenant_id: string,
    input: unknown,
    created_by: string,
    now: Date,
  ): WeightPreset;
  delete(tenant_id: string, preset_id: string): boolean;
}

export class InMemoryCustomWeightPresetStore implements CustomWeightPresetStore {
  private readonly perTenant = new Map<string, WeightPreset[]>();

  list(tenant_id: string): WeightPreset[] {
    return [...(this.perTenant.get(tenant_id) ?? [])];
  }

  get(tenant_id: string, preset_id: string): WeightPreset | null {
    return (
      this.perTenant.get(tenant_id)?.find((p) => p.id === preset_id) ?? null
    );
  }

  create(
    tenant_id: string,
    input: unknown,
    created_by: string,
    now: Date,
  ): WeightPreset {
    if (!created_by || !created_by.trim()) {
      throw new CustomWeightPresetError('invalid_input', 'created_by required');
    }
    void now;
    const valid = validate(input);
    const arr = this.perTenant.get(tenant_id) ?? [];
    if (arr.length >= CAP_PER_TENANT) {
      throw new CustomWeightPresetError(
        'cap_reached',
        `tenant ${tenant_id} already has ${CAP_PER_TENANT} custom presets`,
      );
    }
    const preset: WeightPreset = {
      id: `wp_custom_${randomUUID().slice(0, 8)}`,
      name: valid.name,
      description: valid.description,
      vertical: valid.vertical,
      mode: valid.mode,
      weight_multipliers: valid.weight_multipliers,
    };
    if (getLibraryWeightPreset(preset.id)) {
      throw new CustomWeightPresetError(
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

export const defaultCustomWeightPresetStore: CustomWeightPresetStore =
  new InMemoryCustomWeightPresetStore();

/** Look up a weight preset by id — checks library first, then per-
 *  tenant custom store. Helper for downstream consumers (M6.3
 *  scoreByPreset is the natural caller). */
export function getEffectiveWeightPreset(
  store: CustomWeightPresetStore,
  tenant_id: string,
  preset_id: string,
): WeightPreset | null {
  const lib = getLibraryWeightPreset(preset_id);
  if (lib) return lib;
  return store.get(tenant_id, preset_id);
}
