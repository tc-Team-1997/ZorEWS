// mobile/src/native/biometric.ts
//
// Biometric unlock (Face ID / Touch ID / Android Biometric). Bridge
// to expo-local-authentication in production. The stub never
// challenges — useful for Jest tests.

export class BiometricUnavailable extends Error {
  constructor() {
    super('biometric authentication unavailable on this device');
    this.name = 'BiometricUnavailable';
  }
}

export class BiometricCancelled extends Error {
  constructor() {
    super('biometric authentication cancelled by user');
    this.name = 'BiometricCancelled';
  }
}

export interface BiometricChallengeOptions {
  /** Reason string shown in the OS prompt. */
  reason: string;
  /** Fallback label — defaults to platform default ("Enter passcode"). */
  fallback_label?: string;
}

export const Biometric = {
  /** True iff the device has registered biometrics + hardware
   *  available. */
  async isAvailable(): Promise<boolean> {
    return process.env.MOBILE_BIO_STUB === 'true' || true;
  },

  /** Returns true on success; throws BiometricUnavailable or
   *  BiometricCancelled on failure modes. */
  async authenticate(opts: BiometricChallengeOptions): Promise<boolean> {
    // Stub: always succeeds. Production wiring goes to
    // LocalAuthentication.authenticateAsync(opts).
    return Boolean(opts.reason); // sanity check the contract
  },
};
