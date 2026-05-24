// web/src/lib/useVerticalMode.ts
//
// G1 — Bank / Insurance vertical mode toggle (Monday Playbook H1).
//
// Single source of truth for the SPA's currently-displayed vertical.
// Persisted to localStorage so the choice survives reloads + tabs.
//
// Cross-tab sync: native `storage` event fires on OTHER tabs only — so
// for same-tab listener wake-up, we also dispatch a custom event.
//
// Consumer pattern:
//   const [mode, setMode] = useVerticalMode();
//   <button onClick={() => setMode('insurance')}>...</button>
//
// Queries that want mode-aware results read `mode` from the hook and
// pass `?mode=${mode}` to the BFF. Routes that aren't mode-aware just
// ignore it — pure-additive, no envelope change.

import { useCallback, useEffect, useState } from 'react';

export type VerticalMode = 'bank' | 'insurance';
const STORAGE_KEY = 'zorews.vertical';
const CHANGE_EVENT = 'zorews:vertical-changed';
const DEFAULT_MODE: VerticalMode = 'bank';

function readMode(): VerticalMode {
  if (typeof window === 'undefined') return DEFAULT_MODE;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === 'insurance' || v === 'bank' ? v : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

/**
 * useVerticalMode — read + write the user's chosen vertical.
 * Returns `[mode, setMode]`. The hook listens for both `storage`
 * (cross-tab) and a custom `zorews:vertical-changed` event
 * (same-tab) so all components stay in sync.
 */
export function useVerticalMode(): [VerticalMode, (next: VerticalMode) => void] {
  const [mode, setModeState] = useState<VerticalMode>(readMode);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setModeState(readMode());
    };
    const onChange = () => setModeState(readMode());
    window.addEventListener('storage', onStorage);
    window.addEventListener(CHANGE_EVENT, onChange as EventListener);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(CHANGE_EVENT, onChange as EventListener);
    };
  }, []);

  const setMode = useCallback((next: VerticalMode) => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode / quota — best effort */
    }
    setModeState(next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return [mode, setMode];
}

/**
 * Pure helper for non-hook code paths (e.g. one-shot API client
 * interceptor) that want the current value without subscribing.
 */
export function getVerticalMode(): VerticalMode {
  return readMode();
}
