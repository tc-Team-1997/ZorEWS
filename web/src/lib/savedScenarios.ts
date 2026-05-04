// Saved-scenario persistence — write-through to the BFF API
// (`app_scenario.saved_scenarios`, T4.18) with a localStorage cache for
// instant first-render + offline resilience.
//
// Storage shape (cache):
//   apex.ews.saved_scenarios = JSON-encoded SavedScenario[] (newest first)
//
// We snapshot the full ScenarioResult (not just inputs) so loading a saved
// scenario shows the exact result the user committed to, rather than
// re-running and getting a slightly different number if the engine is
// tweaked.
//
// Sync contract: `listSaved`/`saveScenario`/`deleteScenario` return
// synchronously from the localStorage cache. Each mutating call ALSO
// fires the API in the background — the local cache is the source of
// truth for the current tab; the API is the source of truth across
// tabs / devices / cache clears. On page mount, callers should call
// `refreshSavedFromApi()` to pull the canonical list from the BFF (with
// graceful fallback to the cache when the API is unreachable).

import type { ScenarioResult, ShockInputs, SavedScenario } from './api';
import { api } from './api';

export type { SavedScenario };

const STORAGE_KEY = 'apex.ews.saved_scenarios';
const MAX_SAVED = 20;

function read(): SavedScenario[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as SavedScenario[];
  } catch {
    return [];
  }
}

function write(list: SavedScenario[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_SAVED)));
}

export function listSaved(): SavedScenario[] {
  return read();
}

/**
 * Background refresh — pull the canonical list from the BFF and MERGE
 * with the localStorage cache. The API is authoritative for any id it
 * returns; cache-only entries are kept (they may be in-flight saves
 * from this tab whose POST hasn't landed yet, or scenarios saved
 * before T4.18 wired the API). Returns the merged list (or the existing
 * cache on API failure). Safe to call on mount; no UI lock-up.
 */
export async function refreshSavedFromApi(): Promise<SavedScenario[]> {
  try {
    const fromApi = await api.listScenarios();
    const apiIds = new Set(fromApi.map((s) => s.id));
    const cacheOnly = read().filter((s) => !apiIds.has(s.id));
    const merged = [...fromApi, ...cacheOnly].sort((a, b) =>
      a.saved_at < b.saved_at ? 1 : a.saved_at > b.saved_at ? -1 : 0,
    );
    write(merged);
    return merged;
  } catch {
    // API unreachable — leave the cache as-is so the SPA keeps working
    // offline. Don't surface the error; the user only cares when they
    // try to save (which will then fail loudly).
    return read();
  }
}

export function saveScenario(
  name: string,
  inputs: ShockInputs,
  result: ScenarioResult,
): SavedScenario {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Scenario name cannot be empty.');
  // Generate the id locally so the sync caller can reference the new
  // record immediately. The BFF accepts our id (PgScenarioStore + the
  // in-memory store both honor it inside save()'s input shape).
  const entry: SavedScenario = {
    id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: trimmed,
    saved_by: 'self', // placeholder; the BFF stamps the real username from x-apex-user
    saved_at: new Date().toISOString(),
    inputs,
    result,
  };
  // Newest-first; cap at MAX_SAVED to keep the cache bounded.
  write([entry, ...read().filter((s) => s.id !== entry.id)]);
  // Fire-and-forget to the API. We pass the local id so the server
  // stores it as-is — keeps the SPA's cache + the BFF's row in
  // lock-step (no id reassignment, no "two entries for the same
  // scenario" reconciliation problem). On success, fold any server
  // fields we didn't have locally (real saved_by) into the cache.
  void api
    .saveScenarioApi({ id: entry.id, name: trimmed, inputs, result })
    .then((saved) => {
      const list = read();
      const idx = list.findIndex((s) => s.id === entry.id);
      if (idx >= 0) {
        list[idx] = saved;
        write(list);
      }
    })
    .catch(() => {
      // Best-effort. The cached entry stays so the user doesn't lose
      // their work; refreshSavedFromApi() on the next mount will
      // reconcile if the API recovers.
    });
  return entry;
}

export function deleteScenario(id: string): void {
  write(read().filter((s) => s.id !== id));
  // Best-effort API delete. If it fails, the next refresh will pull
  // the row back into the cache — that's the user's signal to retry.
  void api.deleteScenarioApi(id).catch(() => undefined);
}

export function getScenario(id: string): SavedScenario | undefined {
  return read().find((s) => s.id === id);
}
