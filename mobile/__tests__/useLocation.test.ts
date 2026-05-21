// T4.3.1 — useLocation hook tests (pure facade-level behaviour).

import { captureSilentCoords, type LocationFacade } from '../src/hooks/useLocation';

function makeFacade(
  status: 'granted' | 'denied' | 'undetermined',
  coords: { lat: number; lng: number; accuracy_m: number } = { lat: 1.23, lng: 4.56, accuracy_m: 10 },
  throwOnGet: boolean = false,
): LocationFacade {
  return {
    async requestPermission() {
      return status;
    },
    async getCurrentCoords() {
      if (throwOnGet) throw new Error('GPS unavailable');
      return coords;
    },
  };
}

describe('captureSilentCoords', () => {
  test('returns coords when permission already granted', async () => {
    const facade = makeFacade('granted', { lat: -1.286, lng: 36.817, accuracy_m: 8 });
    const out = await captureSilentCoords(facade);
    expect(out).toEqual({ lat: -1.286, lng: 36.817, accuracy_m: 8 });
  });

  test('returns null when permission denied', async () => {
    const facade = makeFacade('denied');
    expect(await captureSilentCoords(facade)).toBeNull();
  });

  test('returns null when permission undetermined', async () => {
    const facade = makeFacade('undetermined');
    expect(await captureSilentCoords(facade)).toBeNull();
  });

  test('returns null when device throws on getCurrentCoords', async () => {
    const facade = makeFacade('granted', undefined, true);
    expect(await captureSilentCoords(facade)).toBeNull();
  });
});
