// mobile/src/hooks/useLocation.ts
//
// T4.3.1 — GPS / location hook for the mobile shell. Field officers
// log a visit; useLocation captures the device coords for the action
// log payload. Wraps expo-location with permission handling +
// graceful degradation (returns null when permission denied; the
// action log still records the action without GPS).
//
// expo-location is imported lazily so tests can run without it.

import { useCallback, useState } from 'react';

export interface GpsCoords {
  lat: number;
  lng: number;
  accuracy_m: number;
}

export type LocationPermissionStatus = 'granted' | 'denied' | 'undetermined';

export interface LocationState {
  status: LocationPermissionStatus;
  coords: GpsCoords | null;
  error: string | null;
  loading: boolean;
}

/** Adapter the hook calls. Mocked in tests. */
export interface LocationFacade {
  requestPermission(): Promise<LocationPermissionStatus>;
  getCurrentCoords(): Promise<GpsCoords>;
}

/** Default expo-location-backed facade. Lazy-imported so tests don't
 *  drag expo-location into the suite. */
export function expoLocationFacade(): LocationFacade {
  return {
    async requestPermission() {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Location = require('expo-location') as typeof import('expo-location');
      const { status } = await Location.requestForegroundPermissionsAsync();
      return status === 'granted' ? 'granted' : status === 'denied' ? 'denied' : 'undetermined';
    },
    async getCurrentCoords() {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Location = require('expo-location') as typeof import('expo-location');
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      return {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy_m: pos.coords.accuracy ?? 50,
      };
    },
  };
}

/** Hook that exposes capture() — call it from the action-log
 *  submit button. Returns the latest LocationState for UI rendering. */
export function useLocation(facade: LocationFacade): {
  state: LocationState;
  capture: () => Promise<GpsCoords | null>;
} {
  const [state, setState] = useState<LocationState>({
    status: 'undetermined',
    coords: null,
    error: null,
    loading: false,
  });

  const capture = useCallback(async (): Promise<GpsCoords | null> => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const status = await facade.requestPermission();
      if (status !== 'granted') {
        setState({ status, coords: null, error: 'permission_denied', loading: false });
        return null;
      }
      const coords = await facade.getCurrentCoords();
      setState({ status: 'granted', coords, error: null, loading: false });
      return coords;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      setState((s) => ({ ...s, error: msg, loading: false }));
      return null;
    }
  }, [facade]);

  return { state, capture };
}

/** Pure helper — captures coords if permission already granted; useful
 *  for screens that want to silently refresh without re-prompting. */
export async function captureSilentCoords(facade: LocationFacade): Promise<GpsCoords | null> {
  const status = await facade.requestPermission();
  if (status !== 'granted') return null;
  try {
    return await facade.getCurrentCoords();
  } catch {
    return null;
  }
}
