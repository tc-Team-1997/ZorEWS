// Onboarding-state hooks for the 4-step enterprise login flow.
//
// Three pieces of state survive across page reloads:
//   - `useCountry()`        — STEP 1, set on login (drives locale).
//   - `useDomain()`         — STEP 2, banking | insurance.
//   - `useTenantContext()`  — STEP 3, organisation + region + branch.
//
// These are deliberately separate from `useAuth` so we don't churn the
// store's existing surface. Cross-tab sync via `storage` event plus an
// in-tab custom event (mirrors `useVerticalMode.ts`).

import { useCallback, useEffect, useState } from 'react';
import { COUNTRY_STORAGE_KEY, type CountryCode } from './countries';
import {
  TENANT_CONTEXT_KEY,
  type TenantContext,
  getOrganization,
} from './organizations';

// ── Country ──────────────────────────────────────────────────────────

const COUNTRY_CHANGE = 'zorews:country-changed';

function readCountry(): CountryCode | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(COUNTRY_STORAGE_KEY);
    if (!v) return null;
    // Crude validation — keep the catalog as the source of truth, but
    // any non-empty string is treated as the persisted code; the UI
    // will fall back to the picker if it doesn't resolve.
    return v as CountryCode;
  } catch {
    return null;
  }
}

export function useCountry(): [CountryCode | null, (next: CountryCode | null) => void] {
  const [country, setCountry] = useState<CountryCode | null>(readCountry);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === COUNTRY_STORAGE_KEY) setCountry(readCountry());
    };
    const onChange = () => setCountry(readCountry());
    window.addEventListener('storage', onStorage);
    window.addEventListener(COUNTRY_CHANGE, onChange as EventListener);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(COUNTRY_CHANGE, onChange as EventListener);
    };
  }, []);

  const set = useCallback((next: CountryCode | null) => {
    if (typeof window === 'undefined') return;
    try {
      if (next) window.localStorage.setItem(COUNTRY_STORAGE_KEY, next);
      else window.localStorage.removeItem(COUNTRY_STORAGE_KEY);
    } catch {
      /* private mode / quota — best effort */
    }
    setCountry(next);
    window.dispatchEvent(new Event(COUNTRY_CHANGE));
  }, []);

  return [country, set];
}

// ── Domain (banking | insurance) ────────────────────────────────────
//
// We piggy-back on the existing `useVerticalMode` hook for storage
// compatibility (key `zorews.vertical`, values `bank`/`insurance`).
// This avoids splitting the source of truth — the dashboards already
// read that hook.

import { useVerticalMode, type VerticalMode } from './useVerticalMode';

export type DomainChoice = 'banking' | 'insurance';

export function useDomain(): [DomainChoice | null, (next: DomainChoice) => void] {
  const [mode, setMode] = useVerticalMode();
  // We don't have a "no choice yet" state in useVerticalMode (it
  // defaults to 'bank'). The onboarding flow uses the explicit
  // localStorage marker `zorews.domainChosen` to know whether the
  // user has actually completed STEP 2.
  const chosen = readDomainChosen();
  const value: DomainChoice | null = chosen ? toDomain(mode) : null;
  const set = useCallback(
    (next: DomainChoice) => {
      setMode(toVertical(next));
      writeDomainChosen(true);
    },
    [setMode],
  );
  return [value, set];
}

const DOMAIN_CHOSEN_KEY = 'zorews.domainChosen';

function readDomainChosen(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(DOMAIN_CHOSEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDomainChosen(chosen: boolean) {
  if (typeof window === 'undefined') return;
  try {
    if (chosen) window.localStorage.setItem(DOMAIN_CHOSEN_KEY, '1');
    else window.localStorage.removeItem(DOMAIN_CHOSEN_KEY);
  } catch {
    /* best effort */
  }
}

function toDomain(v: VerticalMode): DomainChoice {
  return v === 'insurance' ? 'insurance' : 'banking';
}

function toVertical(d: DomainChoice): VerticalMode {
  return d === 'insurance' ? 'insurance' : 'bank';
}

// ── Tenant context (org + region + branch) ──────────────────────────

const TENANT_CHANGE = 'zorews:tenant-context-changed';

function readTenantContext(): TenantContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(TENANT_CONTEXT_KEY);
    if (!v) return null;
    const parsed = JSON.parse(v) as TenantContext;
    // Defensive validation — if the org has been delisted between
    // sessions, drop the stale context and force re-selection.
    if (!getOrganization(parsed.organization_id)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function useTenantContext(): [
  TenantContext | null,
  (next: TenantContext | null) => void,
] {
  const [ctx, setCtx] = useState<TenantContext | null>(readTenantContext);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === TENANT_CONTEXT_KEY) setCtx(readTenantContext());
    };
    const onChange = () => setCtx(readTenantContext());
    window.addEventListener('storage', onStorage);
    window.addEventListener(TENANT_CHANGE, onChange as EventListener);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(TENANT_CHANGE, onChange as EventListener);
    };
  }, []);

  const set = useCallback((next: TenantContext | null) => {
    if (typeof window === 'undefined') return;
    try {
      if (next) window.localStorage.setItem(TENANT_CONTEXT_KEY, JSON.stringify(next));
      else window.localStorage.removeItem(TENANT_CONTEXT_KEY);
    } catch {
      /* best effort */
    }
    setCtx(next);
    window.dispatchEvent(new Event(TENANT_CHANGE));
  }, []);

  return [ctx, set];
}

/** Clears every onboarding state — invoked on logout so the next login
 *  drives the user through the 4-step flow again. */
export function clearOnboardingState() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(COUNTRY_STORAGE_KEY);
    window.localStorage.removeItem(DOMAIN_CHOSEN_KEY);
    window.localStorage.removeItem(TENANT_CONTEXT_KEY);
  } catch {
    /* best effort */
  }
  window.dispatchEvent(new Event(COUNTRY_CHANGE));
  window.dispatchEvent(new Event(TENANT_CHANGE));
}
