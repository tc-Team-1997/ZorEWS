// mobile/src/native/location.ts
//
// GPS bridge. Production impl swaps to expo-location (Expo) or
// @react-native-community/geolocation (bare RN). This stub returns
// a typed contract so the screens compile + Jest tests have a target.

import type { MobileGpsCoords } from '../types';

export class LocationDenied extends Error {
  constructor() {
    super('location permission denied');
    this.name = 'LocationDenied';
  }
}

export class LocationUnavailable extends Error {
  constructor() {
    super('location unavailable');
    this.name = 'LocationUnavailable';
  }
}

export interface GetCurrentPositionOptions {
  /** Acceptable accuracy in metres; falls back to lower accuracy
   *  when the high-accuracy lock can't be acquired within timeout. */
  desired_accuracy_m?: number;
  /** Total wait in ms. */
  timeout_ms?: number;
}

/**
 * Acquire one GPS fix. In production: requests permission, opens
 * the LocationManager, returns the best lat/lng available within
 * `timeout_ms`. Stub returns a deterministic Nairobi fixture so
 * Jest tests don't hit the native module.
 */
export const Location = {
  async getCurrentPosition(opts: GetCurrentPositionOptions = {}): Promise<MobileGpsCoords> {
    // Stub: replace at native-wiring time with expo-location's
    // getCurrentPositionAsync — same return shape.
    const stubMode = process.env.MOBILE_LOCATION_STUB ?? 'true';
    if (stubMode !== 'true') {
      throw new LocationUnavailable();
    }
    // Default fixture — Nairobi CBD.
    return {
      lat: -1.286389,
      lng: 36.817223,
      accuracy_m: opts.desired_accuracy_m ?? 25,
    };
  },

  async hasPermission(): Promise<boolean> {
    return true;
  },

  async requestPermission(): Promise<boolean> {
    return true;
  },
};
